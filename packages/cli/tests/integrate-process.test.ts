import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fingerprintDirectory,
  planInstallation,
  readInstallationHistory,
  StagingRegistry
} from "@skill-steward/installer";
import { writeReviewedPlan } from "@skill-steward/store";
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
let fixtureDirectory = "";
let binary = "";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "steward-cli-source-process-"));
  binary = join(fixtureDirectory, "main.mjs");
  await build({
    entryPoints: [mainSource],
    outfile: binary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    },
    alias: {
      "@skill-steward/integrations": integrationsSource,
      "@skill-steward/installer": installerSource,
      "@skill-steward/store": storeSource
    }
  });
  await cp(companionAssets, join(fixtureDirectory, "integrations"), { recursive: true });
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

describe("integration CLI source processes", () => {
  it("serializes different exact plans before claim and domain revalidation", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-lease-process-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const workspace = join(base, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const options = {
      cwd: workspace,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    };
    const firstPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(firstPreview.code, firstPreview.stderr).toBe(0);
    const firstPlan = JSON.parse(firstPreview.stdout) as { id: string };
    const secondPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(secondPreview.code, secondPreview.stderr).toBe(0);
    const secondPlan = JSON.parse(secondPreview.stdout) as { id: string };

    const results = await Promise.all([
      runCli(["integrate", "apply", "--plan", firstPlan.id, "--confirm"], options),
      runCli(["integrate", "apply", "--plan", secondPlan.id, "--confirm"], options)
    ]);

    expect(results.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(results.find(({ code }) => code === 1)?.stderr).toContain("INTEGRATION_DRIFTED");
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toContain("skill-steward hook prompt --harness codex");
  });

  it("serializes reviewed replacements before claim and destination revalidation", async () => {
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
    expect(results.find(({ code }) => code === 1)?.stderr).toContain("DESTINATION_DRIFT");
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
});
