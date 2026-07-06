import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendIntegrationRecoveryTransition,
  appendIntegrationRecord,
  createIntegrationRecoveryIntent,
  finalizeIntegrationFileTransaction,
  finalizeIntegrationReadiness,
  loadIntegrationFileRecoveryAuthority,
  loadIntegrationReadinessRecoveryAuthority,
  readIntegrationRecoveryInspection,
  readIntegrationRecoveryState,
  readIntegrationRecords,
  readLatestReport,
  restoreIntegrationFileTransaction,
  restoreIntegrationFileFromRecovery,
  restoreIntegrationReadiness,
  withIntegrationMutationLease
} from "@skill-steward/store";
import { describe, expect, it } from "vitest";
import {
  applyCompanionIntegrationTransaction,
  CompanionTransactionError,
  companionTransactionReceiptSchema,
  type CompanionTransactionBoundary,
  type CompanionTransactionDependencies,
  type CompanionTransactionOptions
} from "../src/companion-transaction.js";
import {
  cleanupOwnedTree,
  restoreOwnedTreeUpgrade,
  rollbackCreatedOwnedTreeAncestors
} from "../src/companion-owned-tree.js";
import { planIntegration } from "../src/config.js";
import type { CompanionSubplan } from "../src/companion-domain.js";
import { inspectCompanionTree } from "../src/companion-manifest.js";
import type { IntegrationHarness } from "../src/domain.js";
import {
  applyIntegrationRecoveryPlan,
  planIntegrationRecovery
} from "../src/integration-recovery.js";

const TRANSACTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const RECORD_ID = "223e4567-e89b-42d3-a456-426614174000";
const packagedCompanion = fileURLToPath(
  new URL("../assets/skill-steward-preflight", import.meta.url)
);

type ReadinessReport = Awaited<ReturnType<CompanionTransactionOptions["generateReadiness"]>>;

function report(): ReadinessReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [],
    findings: []
  };
}

function exactCompanionEvidence(companion: CompanionSubplan) {
  if (!("fingerprint" in companion.after) || !("fingerprint" in companion.source)) {
    throw new Error("Expected exact companion evidence");
  }
  return { after: companion.after, source: companion.source };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function seedRecordedOldCompanion(
  home: string,
  stateDirectory: string,
  harness: IntegrationHarness
): Promise<void> {
  const oldSource = join(home, "old-package", "skill-steward-preflight");
  await cp(packagedCompanion, oldSource, { recursive: true });
  await chmod(oldSource, 0o700);
  await writeFile(join(oldSource, "SKILL.md"), "old companion\n", { mode: 0o600 });
  const oldManifest = await inspectCompanionTree(oldSource, {
    boundary: dirname(oldSource),
    platform: process.platform
  });
  const preview = await planIntegration(harness, {
    home,
    stateDirectory,
    id: () => `seed-${harness}`,
    now: () => new Date("2026-07-04T23:59:00.000Z")
  });
  await mkdir(dirname(preview.targetPath), { recursive: true, mode: 0o700 });
  await writeFile(preview.targetPath, stableJson(preview.afterConfig), { mode: 0o600 });
  const destination = preview.companion.path;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(oldSource, destination, { recursive: true });
  await appendIntegrationRecord(stateDirectory, {
    schemaVersion: 2,
    id: `seed-record-${harness}`,
    harness,
    action: "apply",
    status: "installed",
    targetPath: preview.targetPath,
    beforeFingerprint: preview.expectedBeforeFingerprint,
    afterFingerprint: preview.afterFingerprint,
    installedEntryFingerprint: preview.installedEntryFingerprint,
    companion: {
      action: "create",
      path: destination,
      before: { state: "absent" },
      after: { state: "exact", fingerprint: oldManifest.fingerprint },
      source: { fingerprint: oldManifest.fingerprint },
      proof: { category: "new" },
      installedFingerprint: oldManifest.fingerprint,
      consumers: [harness]
    },
    trigger: {
      planId: preview.id,
      harness,
      createdAt: "2026-07-04T23:59:00.000Z"
    },
    createdAt: "2026-07-04T23:59:00.000Z"
  });
}

async function applyWithFreshAuthority(
  plan: Awaited<ReturnType<typeof planIntegration>>,
  options: Omit<CompanionTransactionOptions, "generateReadiness">,
  expectedAction: "create" | "upgrade" | "none"
) {
  expect(plan.companion.action).toBe(expectedAction);
  return applyCompanionIntegrationTransaction(plan, {
    ...options,
    generateReadiness: async () => report()
  }, {
    transactionId: randomUUID,
    recordId: randomUUID
  });
}

function releaseFailingLease(
  releaseFailure: Error
): CompanionTransactionDependencies["withLease"] {
  return (async (stateDirectory, operation, leaseOptions) => {
    await withIntegrationMutationLease(stateDirectory, operation, leaseOptions);
    throw releaseFailure;
  }) as CompanionTransactionDependencies["withLease"];
}

async function readRecoveryFragments(stateDirectory: string): Promise<Record<string, unknown>[]> {
  const directory = join(stateDirectory, "integration-recovery");
  const names = await readdir(directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as Record<
      string,
      unknown
    >));
}

describe("companion integration transaction", () => {
  it("defines a strict path-free local receipt and preserves the typed cause", () => {
    const receipt = companionTransactionReceiptSchema.parse({
      transactionId: "123e4567-e89b-42d3-a456-426614174000",
      outcome: "rolled-back",
      hook: "restored",
      companion: "restored",
      recordId: "223e4567-e89b-42d3-a456-426614174000",
      cleanup: "clean",
      reasonCode: "INTEGRATION_CONFIGURATION_FAILED",
      nextSafeAction: "create-new-plan"
    });
    const cause = Object.assign(new Error("injected configuration failure"), {
      code: "INTEGRATION_CONFIGURATION_FAILED"
    });
    const error = new CompanionTransactionError(cause, receipt);

    expect(error.cause).toBe(cause);
    expect(error.receipt).toEqual(receipt);
    expect(JSON.stringify(error)).not.toContain(".skill-steward-owned");
    expect(() => companionTransactionReceiptSchema.parse({
      ...receipt,
      stagePath: "/private/stage"
    })).toThrow();
  });

  it("creates the exact companion, Hook, readiness report, and authoritative v2 record", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-companion-transaction-create-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "create-codex-plan"
    });
    const evidence = exactCompanionEvidence(plan.companion);
    const receipt = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: () => TRANSACTION_ID,
      recordId: () => RECORD_ID
    });

    expect(receipt).toEqual({
      transactionId: TRANSACTION_ID,
      outcome: "ready",
      hook: "installed",
      companion: "created",
      recordId: RECORD_ID,
      cleanup: "clean",
      reasonCode: "INTEGRATION_READY",
      nextSafeAction: "none"
    });
    const records = await readIntegrationRecords(stateDirectory);
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      id: RECORD_ID,
      harness: "codex",
      action: "apply",
      status: "installed",
      companion: {
        action: "create",
        path: plan.companion.path,
        before: { state: "absent" },
        after: { state: "exact", fingerprint: evidence.after.fingerprint },
        source: { fingerprint: evidence.source.fingerprint },
        proof: { category: "new" },
        installedFingerprint: evidence.after.fingerprint,
        consumers: ["codex"]
      },
      trigger: {
        planId: plan.id,
        harness: "codex",
        createdAt: "2026-07-05T00:00:00.000Z"
      }
    });
    expect(records[0]?.id).not.toBe(plan.id);
    expect(await readLatestReport(stateDirectory)).toEqual(report());
    expect(JSON.parse(await readFile(plan.targetPath, "utf8"))).toHaveProperty("hooks");
    const companionParentEntries = await readdir(dirname(plan.companion.path));
    expect(companionParentEntries).toEqual(["skill-steward-preflight"]);
    expect((await readdir(stateDirectory)).some((name) =>
      name.includes("integration-readiness") || name.includes("skill-steward")
    )).toBe(false);
  });

  it.each(["codex", "claude-code", "github-copilot"] as const)(
    "finalizes create for %s with one exact consumer",
    async (harness) => {
      const home = await mkdtemp(join(tmpdir(), `steward-create-${harness}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration(harness, {
        home,
        stateDirectory,
        now,
        id: () => `create-${harness}`
      });

      const receipt = await applyWithFreshAuthority(
        plan,
        { home, stateDirectory, now },
        "create"
      );

      expect(receipt).toMatchObject({
        outcome: "ready",
        companion: "created",
        cleanup: "clean"
      });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        schemaVersion: 2,
        companion: { action: "create", consumers: [harness] }
      });
    }
  );

  it.each(["codex", "claude-code", "github-copilot"] as const)(
    "finalizes upgrade for %s and removes the exact old backup",
    async (harness) => {
      const home = await mkdtemp(join(tmpdir(), `steward-upgrade-${harness}-`));
      const stateDirectory = join(home, "state");
      await seedRecordedOldCompanion(home, stateDirectory, harness);
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration(harness, {
        home,
        stateDirectory,
        now,
        id: () => `upgrade-${harness}`
      });

      const receipt = await applyWithFreshAuthority(
        plan,
        { home, stateDirectory, now },
        "upgrade"
      );

      expect(receipt).toMatchObject({
        outcome: "ready",
        companion: "upgraded",
        cleanup: "clean"
      });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        schemaVersion: 2,
        companion: { action: "upgrade", consumers: [harness] }
      });
      expect((await readdir(dirname(plan.companion.path))).filter((name) =>
        name.startsWith(".skill-steward-owned.")
      )).toEqual([]);
    }
  );

  it.each(["codex", "claude-code", "github-copilot"] as const)(
    "finalizes none for %s and expands the exact consumer set without moving the tree",
    async (harness) => {
      const home = await mkdtemp(join(tmpdir(), `steward-none-${harness}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const firstPlan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `first-${harness}`
      });
      await applyWithFreshAuthority(firstPlan, { home, stateDirectory, now }, "create");
      const plan = await planIntegration(harness, {
        home,
        stateDirectory,
        now,
        id: () => `none-${harness}`
      });
      const beforeNames = await readdir(dirname(plan.companion.path));

      const receipt = await applyWithFreshAuthority(
        plan,
        { home, stateDirectory, now },
        "none"
      );

      expect(receipt).toMatchObject({
        outcome: "ready",
        companion: "unchanged",
        cleanup: "clean"
      });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        schemaVersion: 2,
        companion: {
          action: "none",
          consumers: [...new Set(["codex", harness])].sort()
        }
      });
      expect(await readdir(dirname(plan.companion.path))).toEqual(beforeNames);
    }
  );

  it("migrates only exactly dual-proven legacy Hook consumers into the first v2 record", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-consumer-migration-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    for (const harness of ["codex", "claude-code"] as const) {
      const legacyPlan = await planIntegration(harness, {
        home,
        stateDirectory,
        now,
        id: () => `legacy-${harness}`
      });
      await mkdir(dirname(legacyPlan.targetPath), { recursive: true, mode: 0o700 });
      await writeFile(legacyPlan.targetPath, stableJson(legacyPlan.afterConfig), { mode: 0o600 });
      await appendIntegrationRecord(stateDirectory, {
        schemaVersion: 1,
        id: `legacy-record-${harness}`,
        harness,
        action: "apply",
        status: "installed",
        targetPath: legacyPlan.targetPath,
        beforeFingerprint: legacyPlan.expectedBeforeFingerprint,
        afterFingerprint: legacyPlan.afterFingerprint,
        installedEntryFingerprint: legacyPlan.installedEntryFingerprint,
        createdAt: "2026-07-05T00:00:00.000Z"
      });
    }
    const plan = await planIntegration("github-copilot", {
      home,
      stateDirectory,
      now,
      id: () => "first-v2-with-legacy-consumers"
    });

    await applyWithFreshAuthority(plan, { home, stateDirectory, now }, "create");

    expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
      schemaVersion: 2,
      companion: {
        consumers: ["claude-code", "codex", "github-copilot"]
      }
    });
  });

  it.each(["changed", "unavailable", "consumer-proof"] as const)(
    "durably consumes a plan before %s lifecycle revalidation fails",
    async (failureMode) => {
      const home = await mkdtemp(join(tmpdir(), `steward-preclaim-${failureMode}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `preclaim-${failureMode}`
      });
      const exact = exactCompanionEvidence(plan.companion);
      const consumerRecord = {
        schemaVersion: 2 as const,
        id: "consumer-proof-record",
        harness: "claude-code" as const,
        action: "apply" as const,
        status: "installed" as const,
        targetPath: join(home, ".claude", "settings.json"),
        beforeFingerprint: plan.expectedBeforeFingerprint,
        afterFingerprint: plan.afterFingerprint,
        installedEntryFingerprint: plan.installedEntryFingerprint,
        companion: {
          action: "create" as const,
          path: plan.companion.path,
          before: { state: "absent" as const },
          after: { state: "exact" as const, fingerprint: exact.after.fingerprint },
          source: { fingerprint: exact.source.fingerprint },
          proof: { category: "new" as const },
          installedFingerprint: exact.after.fingerprint,
          consumers: ["claude-code" as const]
        },
        trigger: {
          planId: "consumer-proof-plan",
          harness: "claude-code" as const,
          createdAt: "2026-07-04T00:00:00.000Z"
        },
        createdAt: "2026-07-04T00:00:00.000Z"
      };
      const readJournal: CompanionTransactionDependencies["readJournal"] = async () => {
        if (failureMode === "unavailable") {
          throw Object.assign(new Error("injected lifecycle journal unavailability"), {
            code: "EIO"
          });
        }
        if (failureMode === "changed") {
          return { changedDuringRead: true, orderedRecords: [], records: [] };
        }
        return {
          changedDuringRead: false,
          orderedRecords: [consumerRecord],
          records: [consumerRecord]
        };
      };

      const failure = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        readJournal
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CompanionTransactionError);
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
      await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
      const claimedHistory = await readRecoveryFragments(stateDirectory);
      expect(claimedHistory.length).toBeGreaterThan(0);
      expect(claimedHistory.every((state) => state.planId === plan.id)).toBe(true);
      expect(claimedHistory.every((state) => state.lifecycleRecordBinding === undefined)).toBe(true);
      expect(await readIntegrationRecoveryState(stateDirectory)).toEqual({ status: "clear" });

      await expect(applyWithFreshAuthority(plan, {
        home,
        stateDirectory,
        now
      }, "create")).rejects.toBeDefined();
      const freshPlan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `fresh-after-${failureMode}`
      });
      await expect(applyWithFreshAuthority(freshPlan, {
        home,
        stateDirectory,
        now
      }, "create")).resolves.toMatchObject({ outcome: "ready" });
    }
  );

  it.each(["before", "after"] as const)(
    "never mutates when lifecycle-binding publication is uncertain %s persistence",
    async (position) => {
      const home = await mkdtemp(join(tmpdir(), `steward-binding-uncertain-${position}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `binding-uncertain-${position}`
      });
      const uncertainty = Object.assign(
        new Error(`injected binding publication uncertainty ${position} persistence`),
        { code: "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN" }
      );
      let bindingAttempted = false;

      const failure = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        appendRecovery: async (directory, input, options) => {
          if (
            !bindingAttempted
            && input.state === "mutating"
            && input.lifecycleRecordBindingAddition !== undefined
          ) {
            bindingAttempted = true;
            if (position === "after") {
              await appendIntegrationRecoveryTransition(directory, input, options);
            }
            throw uncertainty;
          }
          return appendIntegrationRecoveryTransition(directory, input, options);
        }
      }).catch((error: unknown) => error);

      expect(bindingAttempted).toBe(true);
      expect(failure).toMatchObject({
        cause: uncertainty,
        receipt: {
          outcome: "recovery-required",
          cleanup: "pending",
          reasonCode: "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN"
        }
      });
      expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
        status: "unresolved"
      });
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
      await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
      const history = await readRecoveryFragments(stateDirectory);
      expect(history.some((state) => state.planId === plan.id)).toBe(true);
      expect(history.some((state) => state.lifecycleRecordBinding !== undefined))
        .toBe(position === "after");
    }
  );

  it("resumes an upgrade backup after cleanup acquired its exact restart path", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-cleanup-restart-"));
    const stateDirectory = join(home, "state");
    await seedRecordedOldCompanion(home, stateDirectory, "codex");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "cleanup-restart"
    });

    const receipt = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      cleanupTree: async (handle, options) => cleanupOwnedTree(handle, {
        ...options,
        hooks: {
          ...options.hooks,
          unlinkPath: async () => {
            throw Object.assign(new Error("cleanup restart interruption"), { code: "EIO" });
          }
        }
      })
    });

    expect(receipt).toMatchObject({ outcome: "ready", cleanup: "pending" });
    await expect(readIntegrationRecoveryInspection(stateDirectory)).resolves.toMatchObject({
      status: "unresolved",
      transaction: {
        artifactProofs: expect.arrayContaining([
          expect.objectContaining({ role: "backup", path: expect.stringMatching(/\.backup$/u) }),
          expect.objectContaining({ role: "cleanup", path: expect.stringMatching(/\.cleanup$/u) })
        ])
      }
    });

    const recoveryPlan = await planIntegrationRecovery({
      stateDirectory,
      id: () => "recover-upgrade-cleanup-restart",
      now: () => new Date("2026-07-05T00:01:00.000Z"),
      platform: "darwin"
    });
    await expect(applyIntegrationRecoveryPlan(recoveryPlan.planId, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T00:02:00.000Z"),
      platform: "darwin"
    })).resolves.toMatchObject({ action: "finalize", outcome: "recovered" });
    await expect(readIntegrationRecoveryState(stateDirectory))
      .resolves.toEqual({ status: "clear" });
  });

  const precommitBoundaries = [
    "lease-assert",
    "plan-revalidate",
    "recovery-intent",
    "recovery-checkpoint",
    "stage",
    "install-rename",
    "config-ancestors",
    "config-publish",
    "readiness-generate",
    "readiness-publish",
    "journal-append"
  ] as const satisfies readonly CompanionTransactionBoundary[];

  it.each(precommitBoundaries.flatMap((boundary) => [
    [boundary, "before"],
    [boundary, "after"]
  ] as const))(
    "classifies a definite %s %s failure without contradicting finalize",
    async (boundary, position) => {
      const home = await mkdtemp(join(tmpdir(), `steward-boundary-${boundary}-${position}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `boundary-${boundary}-${position}`
      });
      const injected = Object.assign(new Error(`injected ${boundary} ${position}`), {
        code: "INJECTED_BOUNDARY"
      });
      let fired = false;
      const hook = async (candidate: CompanionTransactionBoundary) => {
        if (!fired && candidate === boundary) {
          fired = true;
          throw injected;
        }
      };

      const result = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        ...(position === "before" ? { beforeBoundary: hook } : { afterBoundary: hook })
      }).catch((error: unknown) => error);

      expect(fired).toBe(true);
      if (boundary === "journal-append" && position === "after") {
        expect(result).toMatchObject({
          outcome: "ready",
          cleanup: "pending",
          reasonCode: "INTEGRATION_READY_CLEANUP_PENDING"
        });
        expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
          schemaVersion: 2,
          trigger: { planId: plan.id }
        });
        return;
      }
      expect(result).toBeInstanceOf(CompanionTransactionError);
      expect(result).toMatchObject({
        cause: injected,
        receipt: {
          outcome: "rolled-back",
          cleanup: "clean",
          reasonCode: "INJECTED_BOUNDARY",
          nextSafeAction: "create-new-plan"
        }
      });
      expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
      await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readIntegrationRecoveryState(stateDirectory)).toEqual({ status: "clear" });
    }
  );

  it.each([
    ["definite", "EIO", "rolled-back"],
    ["uncertain", "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN", "recovery-required"]
  ] as const)(
    "classifies a %s lifecycle append failure without guessing commit",
    async (_kind, code, outcome) => {
      const home = await mkdtemp(join(tmpdir(), `steward-journal-${outcome}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `journal-${outcome}`
      });
      const primary = Object.assign(new Error(`injected ${outcome} journal failure`), { code });

      const failure = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        appendRecord: async () => { throw primary; }
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        cause: primary,
        receipt: {
          outcome,
          reasonCode: code,
          cleanup: outcome === "rolled-back" ? "clean" : "pending"
        }
      });
      expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
      if (outcome === "rolled-back") {
        await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readIntegrationRecoveryState(stateDirectory)).toEqual({ status: "clear" });
      } else {
        await expect(access(plan.companion.path)).resolves.toBeUndefined();
        await expect(access(plan.targetPath)).resolves.toBeUndefined();
        expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
          status: "unresolved"
        });
        const recoveryPlan = await planIntegrationRecovery({
          stateDirectory,
          id: () => "recover-uncertain-create",
          now: () => new Date("2026-07-05T00:01:00.000Z"),
          platform: "darwin"
        });
        expect(recoveryPlan.action).toBe("rollback");
        await expect(applyIntegrationRecoveryPlan(recoveryPlan.planId, {
          home,
          stateDirectory,
          now: () => new Date("2026-07-05T00:02:00.000Z"),
          platform: "darwin"
        })).resolves.toMatchObject({
          action: "rollback",
          outcome: "recovered"
        });
        await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readIntegrationRecoveryState(stateDirectory))
          .resolves.toEqual({ status: "clear" });
      }
    }
  );

  it("rolls back an uncertain upgrade from exact installed and backup authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-recover-upgrade-"));
    const stateDirectory = join(home, "state");
    await seedRecordedOldCompanion(home, stateDirectory, "codex");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "uncertain-upgrade-plan"
    });
    expect(plan.companion.action).toBe("upgrade");
    if (plan.companion.expectedBefore.state !== "exact") {
      throw new Error("expected exact old companion");
    }
    const oldFingerprint = plan.companion.expectedBefore.fingerprint;
    const uncertain = Object.assign(new Error("uncertain upgrade journal"), {
      code: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN"
    });
    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => { throw uncertain; }
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      receipt: { outcome: "recovery-required" }
    });
    expect((await inspectCompanionTree(plan.companion.path, {
      boundary: home,
      platform: process.platform
    })).fingerprint).toBe(exactCompanionEvidence(plan.companion).after.fingerprint);

    const recoveryPlan = await planIntegrationRecovery({
      stateDirectory,
      id: () => "recover-uncertain-upgrade",
      now: () => new Date("2026-07-05T00:01:00.000Z"),
      platform: "darwin"
    });
    expect(recoveryPlan.action).toBe("rollback");
    await expect(applyIntegrationRecoveryPlan(recoveryPlan.planId, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T00:02:00.000Z"),
      platform: "darwin"
    })).resolves.toMatchObject({ action: "rollback", outcome: "recovered" });
    expect((await inspectCompanionTree(plan.companion.path, {
      boundary: home,
      platform: process.platform
    })).fingerprint).toBe(oldFingerprint);
    await expect(readFile(plan.targetPath, "utf8"))
      .resolves.toBe(stableJson(plan.afterConfig));
    await expect(readIntegrationRecoveryState(stateDirectory))
      .resolves.toEqual({ status: "clear" });
  });

  it("treats lease loss at a forward mutation boundary as recovery-required", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-boundary-lease-loss-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "lease-loss-boundary"
    });
    const primary = Object.assign(new Error("injected lease loss"), {
      code: "INTEGRATION_LEASE_LOST"
    });

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      beforeBoundary: async (boundary) => {
        if (boundary === "install-rename") throw primary;
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: primary,
      receipt: {
        outcome: "recovery-required",
        reasonCode: "INTEGRATION_LEASE_LOST"
      }
    });
    expect((await readdir(dirname(plan.companion.path))).some((name) =>
      name.includes(".stage")
    )).toBe(true);
  });

  it.each([
    "readiness-restore",
    "config-restore",
    "companion-cleanup",
    "ancestor-cleanup"
  ] as const)(
    "preserves the original typed cause when %s compensation fails",
    async (compensation) => {
      const home = await mkdtemp(join(tmpdir(), `steward-compensate-${compensation}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `compensate-${compensation}`
      });
      const primary = Object.assign(new Error("injected definite journal failure"), { code: "EIO" });
      const compensationFailure = Object.assign(new Error(`injected ${compensation} failure`), {
        code: "INJECTED_COMPENSATION"
      });

      const failure = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        appendRecord: async () => { throw primary; },
        ...(compensation === "readiness-restore"
          ? { restoreReadiness: async () => { throw compensationFailure; } }
          : {}),
        ...(compensation === "config-restore"
          ? { restoreConfig: async () => { throw compensationFailure; } }
          : {}),
        ...(compensation === "companion-cleanup"
          ? { cleanupTree: async () => { throw compensationFailure; } }
          : {}),
        ...(compensation === "ancestor-cleanup"
          ? { rollbackAncestors: async () => { throw compensationFailure; } }
          : {})
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CompanionTransactionError);
      expect(failure).toMatchObject({
        cause: primary,
        receipt: {
          outcome: "recovery-required",
          reasonCode: "EIO",
          cleanup: "pending"
        }
      });
      expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
        status: "unresolved"
      });
      const liveCompanion = await access(plan.companion.path).then(
        () => true,
        () => false
      );
      const packaged = await access(packagedCompanion).then(
        () => true,
        () => false
      );
      expect(liveCompanion || packaged).toBe(true);
    }
  );

  it.each(["before", "after"] as const)(
    "restores the exact old companion when upgrade backup rename fails %s its boundary",
    async (position) => {
      const home = await mkdtemp(join(tmpdir(), `steward-backup-boundary-${position}-`));
      const stateDirectory = join(home, "state");
      await seedRecordedOldCompanion(home, stateDirectory, "codex");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `backup-boundary-${position}`
      });
      expect(plan.companion.action).toBe("upgrade");
      const beforeFingerprint = plan.companion.expectedBefore.state === "exact"
        ? plan.companion.expectedBefore.fingerprint
        : "";
      const injected = Object.assign(new Error(`injected backup ${position}`), {
        code: "INJECTED_BACKUP_BOUNDARY"
      });

      const failure = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        ...(position === "before"
          ? {
              beforeBoundary: async (boundary) => {
                if (boundary === "backup-rename") throw injected;
              }
            }
          : {
              afterBoundary: async (boundary) => {
                if (boundary === "backup-rename") throw injected;
              }
            })
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        cause: injected,
        receipt: { outcome: "rolled-back", companion: "restored" }
      });
      expect((await inspectCompanionTree(plan.companion.path, {
        boundary: home,
        platform: process.platform
      })).fingerprint).toBe(beforeFingerprint);
      expect((await readdir(dirname(plan.companion.path))).filter((name) =>
        name.startsWith(".skill-steward-owned.")
      )).toEqual([]);
    }
  );

  it.each(["boundary", "append"] as const)(
    "stops every post-commit cleanup when recovery commit fails at %s",
    async (failureMode) => {
      const home = await mkdtemp(join(tmpdir(), `steward-recovery-commit-stop-${failureMode}-`));
      const stateDirectory = join(home, "state");
      await seedRecordedOldCompanion(home, stateDirectory, "codex");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("claude-code", {
        home,
        stateDirectory,
        now,
        id: () => `recovery-commit-stop-${failureMode}`
      });
      const calls: string[] = [];
      const failure = Object.assign(new Error(`recovery commit ${failureMode} failed`), {
        code: "EIO"
      });

      const receipt = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        ...(failureMode === "boundary"
          ? {
              beforeBoundary: async (boundary) => {
                if (boundary === "recovery-commit") throw failure;
              }
            }
          : {
              appendRecovery: async (directory, input, options) => {
                if (input.state === "committed") throw failure;
                return appendIntegrationRecoveryTransition(directory, input, options);
              }
            }),
        finalizeReadiness: async (...args) => {
          calls.push("readiness-finalize");
          return finalizeIntegrationReadiness(...args);
        },
        cleanupTree: async (...args) => {
          calls.push("tree-cleanup");
          return cleanupOwnedTree(...args);
        },
        finalizeConfig: async (...args) => {
          calls.push("config-finalize");
          return finalizeIntegrationFileTransaction(...args);
        }
      });

      expect(receipt).toMatchObject({
        outcome: "ready",
        cleanup: "pending",
        nextSafeAction: "recover-transaction"
      });
      expect(calls).toEqual([]);
      expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
        status: "unresolved"
      });
      const backupName = (await readdir(dirname(plan.companion.path))).find((name) =>
        name.includes(".skill-steward-owned.") && name.endsWith(".backup")
      );
      expect(backupName).toBeDefined();

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const configAuthority = await loadIntegrationFileRecoveryAuthority(
          stateDirectory,
          { transactionId: receipt.transactionId, operation: "finalize" },
          { leaseContext }
        );
        const readinessAuthority = await loadIntegrationReadinessRecoveryAuthority(
          stateDirectory,
          { transactionId: receipt.transactionId, operation: "finalize" },
          { leaseContext }
        );
        expect(Object.isFrozen(configAuthority)).toBe(true);
        expect(Object.isFrozen(readinessAuthority)).toBe(true);
      });
    }
  );

  it("keeps real configuration cleanup-pending unresolved with recoverable authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-real-config-cleanup-pending-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "real-config-cleanup-pending"
    });
    let locked = false;

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecovery: async (directory, input, options) => {
        const state = await appendIntegrationRecoveryTransition(directory, input, options);
        if (input.configurationArtifactAddition) {
          await chmod(dirname(plan.targetPath), 0o500);
          locked = true;
        }
        return state;
      }
    }).catch((error: unknown) => error);
    if (locked) await chmod(dirname(plan.targetPath), 0o700);

    expect(failure).toBeInstanceOf(CompanionTransactionError);
    expect(failure).toMatchObject({
      receipt: {
        outcome: "recovery-required",
        cleanup: "pending",
        reasonCode: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
      }
    });
    expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
      status: "unresolved"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const authority = await loadIntegrationFileRecoveryAuthority(
        stateDirectory,
        {
          transactionId: (failure as CompanionTransactionError).receipt.transactionId,
          operation: "restore"
        },
        { leaseContext }
      );
      await restoreIntegrationFileFromRecovery(authority, { stateDirectory, leaseContext });
    });
  });

  it.each(["unresolved", "unavailable"] as const)(
    "reports pre-existing %s recovery as recovery-required without compensation",
    async (recoveryState) => {
      const home = await mkdtemp(join(tmpdir(), `steward-existing-recovery-${recoveryState}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `existing-recovery-${recoveryState}`
      });
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      if (recoveryState === "unresolved") {
        const evidence = exactCompanionEvidence(plan.companion);
        await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
          await createIntegrationRecoveryIntent(stateDirectory, {
            schemaVersion: 1,
            transactionId: randomUUID(),
            planId: "prior-plan",
            harness: "codex",
            action: "none",
            companionPath: plan.companion.path,
            configPath: plan.targetPath,
            beforeFingerprint: evidence.after.fingerprint,
            afterFingerprint: evidence.after.fingerprint,
            createdAt: now().toISOString(),
            artifactHints: []
          }, { leaseContext });
        });
      } else {
        await mkdir(join(stateDirectory, "integration-recovery"), { mode: 0o700 });
      }

      const failure = await applyWithFreshAuthority(plan, { home, stateDirectory, now }, "create")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CompanionTransactionError);
      expect(failure).toMatchObject({
        receipt: {
          outcome: "recovery-required",
          cleanup: "pending",
          nextSafeAction: "recover-transaction"
        }
      });
      await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("preserves both exact upgrade trees when companion restore compensation fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-upgrade-restore-failure-"));
    const stateDirectory = join(home, "state");
    await seedRecordedOldCompanion(home, stateDirectory, "codex");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "upgrade-restore-failure"
    });
    const transactionId = randomUUID();
    const primary = Object.assign(new Error("injected definite append failure"), { code: "EIO" });
    const restoreFailure = Object.assign(new Error("injected companion restore failure"), {
      code: "INJECTED_COMPENSATION"
    });

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: () => transactionId,
      recordId: randomUUID,
      appendRecord: async () => { throw primary; },
      restoreUpgrade: async () => { throw restoreFailure; }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: primary,
      receipt: { outcome: "recovery-required", reasonCode: "EIO" }
    });
    const parentNames = await readdir(dirname(plan.companion.path));
    expect(parentNames).toContain("skill-steward-preflight");
    expect(parentNames).toContain(`.skill-steward-owned.${transactionId}.backup`);
    expect((await inspectCompanionTree(plan.companion.path, {
      boundary: home,
      platform: process.platform
    })).fingerprint).toBe(exactCompanionEvidence(plan.companion).after.fingerprint);
  });

  it.each([
    "recovery-commit",
    "readiness-finalize",
    "config-finalize",
    "recovery-close"
  ] as const)(
    "reports committed cleanup pending when %s fails after v2 finalize",
    async (boundary) => {
      const home = await mkdtemp(join(tmpdir(), `steward-postcommit-${boundary}-`));
      const stateDirectory = join(home, "state");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `postcommit-${boundary}`
      });
      let fired = false;

      const receipt = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        afterBoundary: async (candidate) => {
          if (!fired && candidate === boundary) {
            fired = true;
            throw Object.assign(new Error(`injected postcommit ${boundary}`), { code: "EIO" });
          }
        }
      });

      expect(fired).toBe(true);
      expect(receipt).toMatchObject(boundary === "recovery-close" ? {
        outcome: "ready",
        cleanup: "clean",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none"
      } : {
        outcome: "ready",
        cleanup: "pending",
        reasonCode: "INTEGRATION_READY_CLEANUP_PENDING",
        nextSafeAction: "recover-transaction"
      });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        schemaVersion: 2,
        trigger: { planId: plan.id }
      });
      await expect(access(plan.companion.path)).resolves.toBeUndefined();
      await expect(access(plan.targetPath)).resolves.toBeUndefined();
      if (boundary === "recovery-close") {
        await expect(readIntegrationRecoveryState(stateDirectory))
          .resolves.toEqual({ status: "clear" });
        return;
      }
      const recoveryPlan = await planIntegrationRecovery({
        stateDirectory,
        id: () => `recover-postcommit-${boundary}`,
        now: () => new Date("2026-07-05T00:01:00.000Z"),
        platform: "darwin"
      });
      expect(recoveryPlan.action).toBe("finalize");
      await expect(applyIntegrationRecoveryPlan(recoveryPlan.planId, {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T00:02:00.000Z"),
        platform: "darwin"
      })).resolves.toMatchObject({ action: "finalize", outcome: "recovered" });
      await expect(readIntegrationRecoveryState(stateDirectory))
        .resolves.toEqual({ status: "clear" });
    }
  );

  it.each(["before", "after"] as const)(
    "keeps upgrade committed when exact backup cleanup fails %s its boundary",
    async (position) => {
      const home = await mkdtemp(join(tmpdir(), `steward-cleanup-${position}-`));
      const stateDirectory = join(home, "state");
      await seedRecordedOldCompanion(home, stateDirectory, "codex");
      const now = () => new Date("2026-07-05T00:00:00.000Z");
      const plan = await planIntegration("codex", {
        home,
        stateDirectory,
        now,
        id: () => `cleanup-${position}`
      });
      let fired = false;
      const hook = async (candidate: CompanionTransactionBoundary) => {
        if (!fired && candidate === "tree-cleanup") {
          fired = true;
          throw Object.assign(new Error(`injected cleanup ${position}`), { code: "EIO" });
        }
      };

      const receipt = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        ...(position === "before" ? { beforeBoundary: hook } : { afterBoundary: hook })
      });

      expect(receipt).toMatchObject({ outcome: "ready", cleanup: "pending" });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        schemaVersion: 2,
        companion: { action: "upgrade" }
      });
      const recoveryPlan = await planIntegrationRecovery({
        stateDirectory,
        id: () => `recover-upgrade-cleanup-${position}`,
        now: () => new Date("2026-07-05T00:01:00.000Z"),
        platform: "darwin"
      });
      expect(recoveryPlan.action).toBe("finalize");
      await expect(applyIntegrationRecoveryPlan(recoveryPlan.planId, {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T00:02:00.000Z"),
        platform: "darwin"
      })).resolves.toMatchObject({ action: "finalize", outcome: "recovered" });
      await expect(readIntegrationRecoveryState(stateDirectory))
        .resolves.toEqual({ status: "clear" });
      expect((await readdir(dirname(plan.companion.path))))
        .not.toContain(`.skill-steward-owned.${receipt.transactionId}.backup`);
    }
  );

  it("keeps a durable committed result path-free when lease release fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-release-ready-"));
    const stateDirectory = join(home, "private-state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "release-ready"
    });
    const releaseFailure = Object.assign(new Error(
      `lease release failed at ${join(stateDirectory, "integration-mutation.lease")}`
    ), { code: "INTEGRATION_LEASE_LOST" });

    const receipt = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      withLease: releaseFailingLease(releaseFailure)
    });

    expect(receipt).toMatchObject({
      outcome: "ready",
      cleanup: "pending",
      reasonCode: "INTEGRATION_READY_CLEANUP_PENDING",
      nextSafeAction: "recover-transaction"
    });
    expect(JSON.stringify(receipt)).not.toContain(stateDirectory);
    expect(await readIntegrationRecords(stateDirectory)).toHaveLength(1);
    await expect(access(plan.companion.path)).resolves.toBeUndefined();
    await expect(access(plan.targetPath)).resolves.toBeUndefined();
  });

  it("preserves rolled-back truth and the original typed cause when lease release fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-release-rollback-"));
    const stateDirectory = join(home, "private-state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "release-rollback"
    });
    const primary = Object.assign(new Error("typed precommit failure"), {
      code: "INJECTED_PRECOMMIT"
    });
    const releaseFailure = Object.assign(new Error(
      `lease release failed at ${join(stateDirectory, "integration-mutation.lease")}`
    ), { code: "INTEGRATION_LEASE_LOST" });

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => { throw primary; },
      withLease: releaseFailingLease(releaseFailure)
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CompanionTransactionError);
    expect(failure).toMatchObject({
      cause: primary,
      receipt: {
        outcome: "rolled-back",
        cleanup: "pending",
        reasonCode: "INJECTED_PRECOMMIT",
        nextSafeAction: "recover-transaction"
      }
    });
    expect((failure as Error).message).not.toContain(stateDirectory);
    expect(JSON.stringify(failure)).not.toContain(stateDirectory);
    expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
    await expect(access(plan.companion.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(plan.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes a lease failure before any terminal transaction result exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-lease-no-terminal-"));
    const stateDirectory = join(home, "private-state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "lease-no-terminal"
    });
    const leaseFailure = Object.assign(new Error(
      `lease acquisition failed at ${join(stateDirectory, "integration-mutation.lease")}`
    ), { code: "INTEGRATION_LEASE_UNSAFE" });

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      withLease: (async () => { throw leaseFailure; }) as CompanionTransactionDependencies["withLease"]
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CompanionTransactionError);
    expect(failure).toMatchObject({
      cause: leaseFailure,
      receipt: {
        outcome: "recovery-required",
        cleanup: "pending",
        reasonCode: "INTEGRATION_LEASE_UNSAFE",
        nextSafeAction: "recover-transaction"
      }
    });
    expect((failure as Error).message).not.toContain(stateDirectory);
    expect(JSON.stringify(failure)).not.toContain(stateDirectory);
    expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
  });

  it("compensates create in exact reverse mutation order", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-reverse-create-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "reverse-create"
    });
    const calls: string[] = [];

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => { throw Object.assign(new Error("definite"), { code: "EIO" }); },
      restoreReadiness: async (...args) => {
        calls.push("readiness-restore");
        return restoreIntegrationReadiness(...args);
      },
      restoreConfig: async (...args) => {
        calls.push("config-restore");
        return restoreIntegrationFileTransaction(...args);
      },
      rollbackAncestors: async (proofs, mutationOptions) => {
        calls.push(proofs.some(({ path }) => path.includes(".codex"))
          ? "config-ancestors"
          : "tree-ancestors");
        return rollbackCreatedOwnedTreeAncestors(proofs, mutationOptions);
      },
      cleanupTree: async (...args) => {
        calls.push("companion-cleanup");
        return cleanupOwnedTree(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(calls).toEqual([
      "readiness-restore",
      "config-restore",
      "config-ancestors",
      "companion-cleanup",
      "tree-ancestors"
    ]);
  });

  it("compensates upgrade in exact reverse mutation order", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-reverse-upgrade-"));
    const stateDirectory = join(home, "state");
    await seedRecordedOldCompanion(home, stateDirectory, "codex");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("claude-code", {
      home,
      stateDirectory,
      now,
      id: () => "reverse-upgrade"
    });
    const calls: string[] = [];

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => { throw Object.assign(new Error("definite"), { code: "EIO" }); },
      restoreReadiness: async (...args) => {
        calls.push("readiness-restore");
        return restoreIntegrationReadiness(...args);
      },
      restoreConfig: async (...args) => {
        calls.push("config-restore");
        return restoreIntegrationFileTransaction(...args);
      },
      rollbackAncestors: async (proofs, mutationOptions) => {
        calls.push(proofs.some(({ path }) => path.includes(".claude"))
          ? "config-ancestors"
          : "tree-ancestors");
        return rollbackCreatedOwnedTreeAncestors(proofs, mutationOptions);
      },
      restoreUpgrade: async (...args) => {
        calls.push("companion-restore");
        return restoreOwnedTreeUpgrade(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(calls).toEqual([
      "readiness-restore",
      "config-restore",
      "config-ancestors",
      "companion-restore"
    ]);
  });

  it("halts reverse compensation after config ancestor rollback fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-reverse-config-ancestor-failure-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "reverse-config-ancestor-failure"
    });
    const primary = Object.assign(new Error("definite append failure"), { code: "EIO" });
    const calls: string[] = [];

    const failure = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => { throw primary; },
      restoreReadiness: async (...args) => {
        calls.push("readiness-restore");
        return restoreIntegrationReadiness(...args);
      },
      restoreConfig: async (...args) => {
        calls.push("config-restore");
        return restoreIntegrationFileTransaction(...args);
      },
      rollbackAncestors: async (proofs, mutationOptions) => {
        const role = proofs.some(({ path }) => path.includes(".codex"))
          ? "config-ancestors"
          : "tree-ancestors";
        calls.push(role);
        if (role === "config-ancestors") {
          throw Object.assign(new Error("config ancestor rollback failed"), {
            code: "INJECTED_COMPENSATION"
          });
        }
        return rollbackCreatedOwnedTreeAncestors(proofs, mutationOptions);
      },
      cleanupTree: async (...args) => {
        calls.push("companion-cleanup");
        return cleanupOwnedTree(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: primary,
      receipt: { outcome: "recovery-required", reasonCode: "EIO" }
    });
    expect(calls).toEqual([
      "readiness-restore",
      "config-restore",
      "config-ancestors"
    ]);
    await expect(access(plan.companion.path)).resolves.toBeUndefined();
    expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
      status: "unresolved"
    });
  });

  it("serializes competing creates and consumes the stale waiter without overwrite", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-concurrent-create-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const [firstPlan, secondPlan] = await Promise.all([
      planIntegration("codex", { home, stateDirectory, now, id: () => "concurrent-first" }),
      planIntegration("claude-code", { home, stateDirectory, now, id: () => "concurrent-second" })
    ]);

    const results = await Promise.all([
      applyWithFreshAuthority(firstPlan, { home, stateDirectory, now }, "create")
        .catch((error: unknown) => error),
      applyWithFreshAuthority(secondPlan, { home, stateDirectory, now }, "create")
        .catch((error: unknown) => error)
    ]);

    expect(results.filter((result) =>
      typeof result === "object" && result !== null && "outcome" in result
      && result.outcome === "ready"
    )).toHaveLength(1);
    expect(results.filter((result) => result instanceof CompanionTransactionError)).toHaveLength(1);
    expect(await readIntegrationRecords(stateDirectory)).toHaveLength(1);
    expect((await readdir(dirname(firstPlan.companion.path))).filter((name) =>
      name.startsWith(".skill-steward-owned.")
    )).toEqual([]);
  });

  it("consumes a stale plan before revalidation and rejects it after state is restored", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-durable-stale-plan-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "durable-stale-plan"
    });
    await mkdir(dirname(plan.targetPath), { recursive: true, mode: 0o700 });
    await writeFile(plan.targetPath, "external drift\n", { mode: 0o600 });

    const first = await applyWithFreshAuthority(plan, { home, stateDirectory, now }, "create")
      .catch((error: unknown) => error);
    expect(first).toMatchObject({ receipt: { outcome: "rolled-back" } });
    await unlink(plan.targetPath);

    const replay = await applyWithFreshAuthority(plan, { home, stateDirectory, now }, "create")
      .catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CompanionTransactionError);
    expect(replay).toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(await readIntegrationRecords(stateDirectory)).toEqual([]);

    const freshPlan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "durable-fresh-plan"
    });
    await expect(applyWithFreshAuthority(
      freshPlan,
      { home, stateDirectory, now },
      "create"
    )).resolves.toMatchObject({ outcome: "ready" });
  });

  it("rejects the identical plan after a definite rollback", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-durable-rollback-plan-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      now,
      id: () => "durable-rollback-plan"
    });

    const first = await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      appendRecord: async () => {
        throw Object.assign(new Error("definite append rejection"), { code: "EIO" });
      }
    }).catch((error: unknown) => error);
    expect(first).toMatchObject({ receipt: { outcome: "rolled-back" } });

    const replay = await applyWithFreshAuthority(plan, { home, stateDirectory, now }, "create")
      .catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CompanionTransactionError);
    expect(replay).toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
  });
});
