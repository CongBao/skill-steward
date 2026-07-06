import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fingerprintDirectory,
  planInstallation,
  readInstallationHistory,
  StagingRegistry
} from "@skill-steward/installer";
import { withIntegrationMutationLease, writeReviewedPlan } from "@skill-steward/store";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mainSource = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const integrationsSource = fileURLToPath(
  new URL("../../integrations/src/index.ts", import.meta.url)
);
const installerSource = fileURLToPath(new URL("../../installer/src/index.ts", import.meta.url));
const storeSource = fileURLToPath(new URL("../../store/src/index.ts", import.meta.url));
const companionAssets = fileURLToPath(
  new URL("../../integrations/assets", import.meta.url)
);
const jsoncParserEsm = createRequire(
  new URL("../../engine/package.json", import.meta.url)
).resolve("jsonc-parser/lib/esm/main.js");
let fixtureDirectory = "";
let binary = "";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "steward-cli-source-process-"));
  const distributionDirectory = join(fixtureDirectory, "dist");
  await mkdir(distributionDirectory);
  binary = join(distributionDirectory, "main.mjs");
  await build({
    entryPoints: [mainSource],
    outfile: binary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);"
    },
    alias: {
      "jsonc-parser": jsoncParserEsm,
      "@skill-steward/integrations": integrationsSource,
      "@skill-steward/installer": installerSource,
      "@skill-steward/store": storeSource
    }
  });
  await Promise.all([
    cp(companionAssets, join(distributionDirectory, "integrations"), { recursive: true }),
    cp(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      join(fixtureDirectory, "package.json")
    )
  ]);
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const libc = process.platform === "linux"
    ? report.header.glibcVersionRuntime === undefined ? "musl" : "gnu"
    : "none";
  const nativeDirectory = process.platform === "win32"
    ? null
    : `rename-noreplace-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc}` : ""}`;
  if (nativeDirectory !== null) {
    await cp(
      fileURLToPath(new URL(`../../${nativeDirectory}`, import.meta.url)),
      join(fixtureDirectory, "node_modules", "@skill-steward", nativeDirectory),
      { recursive: true }
    );
  }
});

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

function runCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createSkill(directory: string, body: string, bulkFiles = 0): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: shared-review\ndescription: Review shared changes\n---\n${body}\n`
  );
  for (let start = 0; start < bulkFiles; start += 100) {
    const length = Math.min(100, bulkFiles - start);
    await Promise.all(Array.from({ length }, (_, offset) =>
      writeFile(
        join(directory, `payload-${String(start + offset).padStart(4, "0")}.txt`),
        "x".repeat(8_192)
      )
    ));
  }
  return fingerprintDirectory(directory);
}

async function writeReplacementPlan(input: {
  state: string;
  home: string;
  workspace: string;
  destination: string;
  body: string;
  bulkFiles?: number;
}): Promise<string> {
  const id = randomUUID();
  const staging = await new StagingRegistry({
    stateDirectory: input.state,
    id: () => id
  }).create({ ttlMs: 5 * 60_000 });
  const source = join(staging.directory, "source");
  const sourceFingerprint = await createSkill(source, input.body, input.bulkFiles);
  const plan = await planInstallation({
    source,
    sourceFingerprint,
    destination: input.destination,
    conflictAction: "replace"
  });
  plan.id = id;
  await writeReviewedPlan(input.state, {
    schemaVersion: 1,
    id,
    kind: "installation",
    createdAt: new Date(plan.createdAt).toISOString(),
    expiresAt: new Date(plan.expiresAt).toISOString(),
    payload: {
      plan,
      previewId: id,
      candidateName: "shared-review",
      route: {
        harness: "codex",
        scope: "global",
        targetName: "shared-review",
        workspace: input.workspace
      }
    }
  });
  return id;
}

async function authorizeRecordedCompanion(stateDirectory: string, planId: string): Promise<void> {
  const path = join(stateDirectory, "reviewed-plans", `${planId}.json`);
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const companion = envelope.payload.companion;
  if (
    companion.expectedBefore?.state !== "exact"
    || companion.expectedBefore.fingerprint !== companion.after.fingerprint
  ) throw new Error("Expected an exact unowned companion fixture");
  envelope.payload.companion = {
    ...companion,
    action: "none",
    proof: {
      kind: "recorded",
      recordId: "fixture-current-companion",
      installedFingerprint: companion.after.fingerprint
    }
  };
  await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

describe("integration CLI source processes", () => {
  it("serializes forged exact plans and rejects both before Hook mutation", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-lease-process-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const workspace = join(base, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await cp(
      join(dirname(binary), "integrations", "skill-steward-preflight"),
      join(home, ".agents", "skills", "skill-steward-preflight"),
      { recursive: true }
    );
    const options = {
      cwd: workspace,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    };
    const firstPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(firstPreview.code, firstPreview.stderr).toBe(0);
    const firstPlan = JSON.parse(firstPreview.stdout) as { planId: string };
    await authorizeRecordedCompanion(state, firstPlan.planId);
    const secondPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(secondPreview.code, secondPreview.stderr).toBe(0);
    const secondPlan = JSON.parse(secondPreview.stdout) as { planId: string };
    await authorizeRecordedCompanion(state, secondPlan.planId);

    const results = await Promise.all([
      runCli(["integrate", "apply", "--plan", firstPlan.planId, "--confirm"], options),
      runCli(["integrate", "apply", "--plan", secondPlan.planId, "--confirm"], options)
    ]);

    expect(results.map(({ code }) => code)).toEqual([1, 1]);
    expect(results.every(({ stderr }) =>
      stderr.includes("INTEGRATION_DRIFTED")
    )).toBe(true);
    await expect(readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes reviewed replacements across the bounded lease wait", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-install-lease-process-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const workspace = join(base, "workspace");
    const destination = join(home, ".agents", "skills", "shared-review");
    await mkdir(workspace, { recursive: true });
    await createSkill(destination, "original");
    const originalFingerprint = await fingerprintDirectory(destination);
    const slowPlan = await writeReplacementPlan({
      state,
      home,
      workspace,
      destination,
      body: "slow replacement",
      bulkFiles: 1_500
    });
    const fastPlan = await writeReplacementPlan({
      state,
      home,
      workspace,
      destination,
      body: "fast replacement"
    });
    const options = {
      cwd: workspace,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    };

    const slow = runCli(["install", "--plan", slowPlan, "--confirm"], options);
    const parent = join(home, ".agents", "skills");
    const deadline = Date.now() + 10_000;
    while (!(await readdir(parent)).some((name) =>
      name.startsWith(".shared-review.skill-steward-") && name.endsWith(".tmp")
    )) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for slow staged copy");
      await delay(1);
    }
    const fast = runCli(["install", "--plan", fastPlan, "--confirm"], options);
    const results = await Promise.all([slow, fast]);

    expect(results.map(({ code }) => code).sort()).toEqual([0, 1]);
    const failed = results.find(({ code }) => code === 1)!;
    if (failed.stderr.includes("INSTALLATION_BUSY")) {
      await expect(access(join(state, "reviewed-plans", `${fastPlan}.json`)))
        .resolves.toBeUndefined();
      await expect(access(join(state, "staging", fastPlan))).resolves.toBeUndefined();
      const retried = await runCli(["install", "--plan", fastPlan, "--confirm"], options);
      expect(retried.code).toBe(1);
      expect(retried.stderr).toContain("DESTINATION_DRIFT");
    } else {
      expect(failed.stderr).toContain("DESTINATION_DRIFT");
    }
    expect(await readFile(join(destination, "SKILL.md"), "utf8"))
      .toContain("slow replacement");
    const history = await readInstallationHistory(state);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      previousFingerprint: originalFingerprint,
      destination
    });
    expect(await readFile(join(history[0]!.backupDirectory!, "SKILL.md"), "utf8"))
      .toContain("original");
  }, 30_000);

  it("keeps a reviewed installation plan retryable when the shared lease is busy", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-install-busy-process-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const workspace = join(base, "workspace");
    const destination = join(home, ".agents", "skills", "shared-review");
    await mkdir(workspace, { recursive: true });
    await createSkill(destination, "original");
    const planId = await writeReplacementPlan({
      state,
      home,
      workspace,
      destination,
      body: "replacement after busy"
    });
    const options = {
      cwd: workspace,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withIntegrationMutationLease(state, () => gate, {
      waitMs: 10_000,
      pollMs: 2,
      heartbeatMs: 25
    });
    const leasePath = join(state, "integration-mutation.lease");
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await access(leasePath);
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for shared lease");
        await delay(2);
      }
    }

    const busy = await runCli(["install", "--plan", planId, "--confirm"], options);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toMatch(/INSTALLATION_BUSY.*retry this same reviewed plan/is);
    await expect(access(join(state, "reviewed-plans", `${planId}.json`)))
      .resolves.toBeUndefined();
    await expect(access(join(state, "staging", planId))).resolves.toBeUndefined();

    release();
    await held;
    const retried = await runCli(["install", "--plan", planId, "--confirm"], options);
    expect(retried.code, retried.stderr).toBe(0);
    expect(await readFile(join(destination, "SKILL.md"), "utf8"))
      .toContain("replacement after busy");
    expect(await readInstallationHistory(state)).toHaveLength(1);
  }, 20_000);
});
