import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyIntegrationPlan,
  applyIntegrationRecoveryPlan,
  integrationRecoveryStatus,
  planIntegration,
  planIntegrationDisconnect,
  planIntegrationRecovery
} from "../src/integration-lifecycle.js";

const packagedCompanion = fileURLToPath(new URL(
  "../assets/skill-steward-preflight",
  import.meta.url
));
let workerRoot = "";
let workerPath = "";

beforeAll(async () => {
  workerRoot = await mkdtemp(fileURLToPath(new URL(
    "./.phase7-crash-worker-",
    import.meta.url
  )));
  workerPath = join(workerRoot, "worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(
      "./fixtures/companion-transaction-crash-worker.ts",
      import.meta.url
    ))],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: workerPath,
    logLevel: "silent"
  });
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  if (workerRoot) await rm(workerRoot, { recursive: true, force: true });
});

async function crashReviewedPlan(input: {
  home: string;
  stateDirectory: string;
  companionSourceDirectory: string;
  planId: string;
  operation: "apply" | "disconnect";
  boundary: string;
  position: "before" | "after";
  occurrence: number;
  markerPath: string;
}): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerPath,
      input.home,
      input.stateDirectory,
      input.companionSourceDirectory,
      input.planId,
      input.operation,
      input.boundary,
      input.position,
      String(input.occurrence),
      input.markerPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  expect(result).toEqual({ code: null, signal: "SIGKILL", stderr: "" });
  expect(await readFile(input.markerPath, "utf8"))
    .toBe(`${input.position}:${input.boundary}:${input.occurrence}\n`);
  const leasePath = join(input.stateDirectory, "integration-mutation.lease");
  await access(leasePath);
  const stale = new Date(Date.now() - 31 * 60_000);
  await utimes(leasePath, stale, stale);
}

async function crashCreateAt(
  boundary: string,
  position: "before" | "after" = "after",
  occurrence = 1
) {
  const home = await mkdtemp(join(tmpdir(), `steward-process-crash-${boundary}-`));
  const stateDirectory = join(home, "state");
  const markerPath = join(home, "crashed.marker");
  const outside = join(home, "outside-sentinel.txt");
  await writeFile(outside, "preserve\n", { mode: 0o600 });
  const plan = await planIntegration("codex", {
    home,
    stateDirectory,
    companionSourceDirectory: packagedCompanion,
    now: () => new Date("2026-07-06T06:00:00.000Z"),
    id: () => `crash-${boundary}-${position}-${occurrence}`
  });
  await crashReviewedPlan({
    home,
    stateDirectory,
    companionSourceDirectory: packagedCompanion,
    planId: plan.planId,
    operation: "apply",
    boundary,
    position,
    occurrence,
    markerPath
  });
  expect(await readFile(outside, "utf8")).toBe("preserve\n");
  return { home, stateDirectory, outside, plan };
}

function readinessReport(hour: string) {
  return {
    schemaVersion: 1 as const,
    generatedAt: `2026-07-06T${hour}:00:01.000Z`,
    portfolioFingerprint: `sha256:${"b".repeat(64)}`,
    skills: [],
    findings: []
  };
}

async function installCurrentCompanion(home: string, stateDirectory: string): Promise<void> {
  const now = () => new Date("2026-07-06T05:00:00.000Z");
  const plan = await planIntegration("codex", {
    home,
    stateDirectory,
    companionSourceDirectory: packagedCompanion,
    now,
    id: () => "seed-current-companion"
  });
  await applyIntegrationPlan(plan.planId, {
    home,
    stateDirectory,
    companionSourceDirectory: packagedCompanion,
    expectedHarness: "codex",
    now,
    generateReadiness: async () => readinessReport("05")
  });
}

async function recoverExpected(
  home: string,
  stateDirectory: string,
  direction: "rollback" | "finalize"
) {
  await expect(integrationRecoveryStatus({ stateDirectory })).resolves.toMatchObject({
    state: direction === "rollback" ? "rollback-required" : "finalize-required",
    direction,
    recoverable: true
  });
  const plan = await planIntegrationRecovery({
    stateDirectory,
    platform: process.platform,
    now: () => new Date("2026-07-06T06:01:00.000Z")
  });
  const receipt = await applyIntegrationRecoveryPlan(plan.planId, {
    home,
    stateDirectory,
    platform: process.platform,
    now: () => new Date("2026-07-06T06:02:00.000Z")
  });
  expect(receipt).toMatchObject({ action: direction, outcome: "recovered" });
  await expect(integrationRecoveryStatus({ stateDirectory })).resolves.toEqual({
    state: "clear",
    reasonCode: "INTEGRATION_RECOVERY_CLEAR",
    recoverable: false
  });
  return receipt;
}

describe.skipIf(process.platform === "win32")("real process-kill integration recovery", () => {
  it.each([
    ["recovery-intent", "after", "rollback"],
    ["stage", "after", "rollback"],
    ["install-rename", "after", "rollback"],
    ["config-publish", "after", "rollback"],
    ["readiness-publish", "after", "rollback"],
    ["journal-append", "after", "finalize"],
    ["recovery-commit", "after", "finalize"],
    ["readiness-finalize", "after", "finalize"],
    ["config-finalize", "after", "finalize"],
    ["recovery-close", "before", "finalize"]
  ] as const)(
    "recovers an abruptly killed create at %s %s through the proven %s direction",
    async (boundary, position, direction) => {
      const fixture = await crashCreateAt(boundary, position);
      const status = await integrationRecoveryStatus({
        stateDirectory: fixture.stateDirectory
      });
      expect(status).toMatchObject({
        state: direction === "rollback" ? "rollback-required" : "finalize-required",
        direction,
        recoverable: true
      });
      const recoveryPlan = await planIntegrationRecovery({
        stateDirectory: fixture.stateDirectory,
        platform: process.platform,
        now: () => new Date("2026-07-06T06:01:00.000Z")
      });
      expect(recoveryPlan.action).toBe(direction);
      const receipt = await applyIntegrationRecoveryPlan(recoveryPlan.planId, {
        home: fixture.home,
        stateDirectory: fixture.stateDirectory,
        platform: process.platform,
        now: () => new Date("2026-07-06T06:02:00.000Z")
      });
      expect(receipt).toMatchObject({ action: direction, outcome: "recovered" });
      expect(await integrationRecoveryStatus({ stateDirectory: fixture.stateDirectory }))
        .toEqual({
          state: "clear",
          reasonCode: "INTEGRATION_RECOVERY_CLEAR",
          recoverable: false
        });
      expect(await readFile(fixture.outside, "utf8")).toBe("preserve\n");
      if (direction === "rollback") {
        await expect(access(fixture.plan.targets.hook)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(fixture.plan.targets.companion)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(access(fixture.plan.targets.hook)).resolves.toBeUndefined();
        await expect(access(fixture.plan.targets.companion)).resolves.toBeUndefined();
      }
      expect(JSON.stringify(receipt)).not.toMatch(
        /stagePath|backupPath|sourceDirectory|expectedBefore|fingerprint|\.skill-steward-owned/u
      );
    },
    30_000
  );

  it.each([
    ["backup-rename", "after", "rollback"],
    ["tree-cleanup", "before", "finalize"],
    ["tree-cleanup", "after", "finalize"]
  ] as const)(
    "recovers an abruptly killed upgrade %s %s through %s",
    async (boundary, position, direction) => {
      const home = await mkdtemp(join(tmpdir(), `steward-upgrade-crash-${position}-`));
      const stateDirectory = join(home, "state");
      await installCurrentCompanion(home, stateDirectory);
      const upgradedSource = join(home, "upgraded-source");
      await cp(packagedCompanion, upgradedSource, { recursive: true });
      await writeFile(
        join(upgradedSource, "SKILL.md"),
        `${await readFile(join(upgradedSource, "SKILL.md"), "utf8")}\n<!-- packaged upgrade fixture -->\n`
      );
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        companionSourceDirectory: upgradedSource,
        now: () => new Date("2026-07-06T06:00:00.000Z"),
        id: () => `upgrade-crash-${position}`
      });
      expect(plan.action).toBe("upgrade");
      const markerPath = join(home, "upgrade-crashed.marker");
      await crashReviewedPlan({
        home,
        stateDirectory,
        companionSourceDirectory: upgradedSource,
        planId: plan.planId,
        operation: "apply",
        boundary,
        position,
        occurrence: 1,
        markerPath
      });
      const receipt = await recoverExpected(
        home,
        stateDirectory,
        direction
      );
      expect(JSON.stringify(receipt)).not.toMatch(/fingerprint|backupPath|\.skill-steward-owned/u);
      await expect(access(plan.targets.hook)).resolves.toBeUndefined();
      await expect(access(plan.targets.companion)).resolves.toBeUndefined();
    },
    30_000
  );

  it.each([
    ["backup-rename", "after", "rollback"],
    ["tree-cleanup", "before", "finalize"],
    ["tree-cleanup", "after", "finalize"]
  ] as const)(
    "recovers an abruptly killed final disconnect %s %s through %s",
    async (boundary, position, direction) => {
      const home = await mkdtemp(join(tmpdir(), `steward-disconnect-crash-${position}-`));
      const stateDirectory = join(home, "state");
      await installCurrentCompanion(home, stateDirectory);
      const plan = await planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now: () => new Date("2026-07-06T06:00:00.000Z"),
        id: () => `disconnect-crash-${position}`
      });
      expect(plan.companion).toBe("removed");
      const markerPath = join(home, "disconnect-crashed.marker");
      await crashReviewedPlan({
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        planId: plan.planId,
        operation: "disconnect",
        boundary,
        position,
        occurrence: 1,
        markerPath
      });
      await recoverExpected(
        home,
        stateDirectory,
        direction
      );
      if (direction === "rollback") {
        await expect(access(plan.targets.hook)).resolves.toBeUndefined();
        await expect(access(plan.targets.companion)).resolves.toBeUndefined();
      } else {
        await expect(access(plan.targets.hook)).resolves.toBeUndefined();
        await expect(access(plan.targets.companion)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    30_000
  );
});
