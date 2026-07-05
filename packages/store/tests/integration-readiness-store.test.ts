import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
import {
  appendIntegrationRecord,
  bindIntegrationRecordV2,
  deriveIntegrationReadinessRecoveryArtifact,
  finalizeIntegrationReadiness as finalizeIntegrationReadinessActual,
  integrationReadinessTransactionReceipt,
  integrationReadinessRecoveryArtifact,
  publishIntegrationReadiness as publishIntegrationReadinessActual,
  readIntegrationReadinessBackup,
  readLatestReport,
  readPreviousReport,
  readReportHistory,
  restoreIntegrationReadiness,
  withIntegrationMutationLease,
  type IntegrationFileMutationOptions,
  type IntegrationReadinessPublishOptions,
  type IntegrationReadinessTransactionHandle,
  type IntegrationRecordCommitReceipt,
  type IntegrationRecordV1,
  type IntegrationRecordV2
} from "../src/index.js";
import { restoreIntegrationReadinessFromArtifact } from "../src/integration-readiness-recovery.js";
import {
  integrationReadinessBackupSchema,
  integrationReadinessBackupPath,
  integrationReadinessPublicationTransactionId,
  integrationReadinessRecoveryArtifactSchema
} from "../src/integration-readiness-recovery.js";
import { appendIntegrationReportHistoryClaimed } from "../src/integration-history-store.js";

const fault = vi.hoisted(() => ({
  destination: null as string | null,
  destinationSuffix: null as string | null,
  mode: null as "throw-before" | "throw-after" | "replace-after" | null,
  historyFailure: false,
  historySyncFailureCode: null as "EIO" | "INTEGRATION_LEASE_LOST" | null,
  failHistoryIndexParentSync: false,
  historyIndexCommitted: false,
  cleanupLeaseError: false,
  historyGcUnlinkFailure: false,
  failHistoryDirectorySyncAfterGcClaimUnlink: false,
  historyGcClaimUnlinked: false,
  historyDirectorySyncFailures: 0,
  historyDirectorySyncs: 0,
  replaceHistoryGcSourceBeforeLink: false,
  replaceHistoryIndexResidueBeforeLink: false,
  recoveryUnlinkFailureSuffix: null as string | null,
  recoveryUnlinkFailureSequence: [] as string[],
  failSyncAfterRecoveryRename: false,
  recoveryRenameCommitted: false,
  publications: [] as string[],
  unlinkEvents: [] as string[]
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async open(...args: Parameters<typeof original.open>) {
      const path = String(args[0]);
      const handle = await original.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async () => {
              if (path.endsWith("/history")) {
                fault.historyDirectorySyncs += 1;
                if (fault.historyDirectorySyncFailures > 0) {
                  fault.historyDirectorySyncFailures -= 1;
                  throw Object.assign(new Error("injected history directory fsync failure"), {
                    code: "EIO"
                  });
                }
                if (
                  fault.failHistoryDirectorySyncAfterGcClaimUnlink
                  && fault.historyGcClaimUnlinked
                ) {
                  fault.failHistoryDirectorySyncAfterGcClaimUnlink = false;
                  fault.historyGcClaimUnlinked = false;
                  throw Object.assign(new Error("injected history GC parent fsync failure"), {
                    code: "EIO"
                  });
                }
              }
              if (
                fault.failHistoryIndexParentSync
                && fault.historyIndexCommitted
                && path.endsWith("/history")
              ) {
                fault.failHistoryIndexParentSync = false;
                throw Object.assign(new Error("injected history index parent fsync failure"), {
                  code: "EIO"
                });
              }
              if (
                fault.historySyncFailureCode !== null
                && path.includes("/history/")
              ) {
                const code = fault.historySyncFailureCode;
                fault.historySyncFailureCode = null;
                throw Object.assign(new Error("injected integration history sync failure"), {
                  code
                });
              }
              if (fault.failSyncAfterRecoveryRename && fault.recoveryRenameCommitted) {
                fault.failSyncAfterRecoveryRename = false;
                fault.recoveryRenameCommitted = false;
                throw Object.assign(new Error("injected recovery parent fsync failure"), {
                  code: "EIO"
                });
              }
              return target.sync();
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    async link(...args: Parameters<typeof original.link>) {
      const source = String(args[0]);
      const destination = String(args[1]);
      if (
        fault.replaceHistoryGcSourceBeforeLink
        && destination.includes(".history-gc.")
      ) {
        fault.replaceHistoryGcSourceBeforeLink = false;
        await original.unlink(source);
        await original.writeFile(source, "external history replacement\n", { mode: 0o600 });
      }
      if (
        fault.replaceHistoryIndexResidueBeforeLink
        && source.includes("index.json.skill-steward.")
        && destination.endsWith(".finalize.backup.cleanup.claim")
      ) {
        fault.replaceHistoryIndexResidueBeforeLink = false;
        await original.unlink(source);
        await original.writeFile(source, "external index residue replacement\n", { mode: 0o600 });
      }
      if (
        destination === fault.destination
        || fault.destinationSuffix !== null && destination.endsWith(fault.destinationSuffix)
      ) {
        const mode = fault.mode;
        fault.mode = null;
        if (mode === "throw-before") {
          throw Object.assign(new Error("injected readiness link failure"), { code: "EIO" });
        }
        const result = await original.link(...args);
        if (mode === "throw-after") throw new Error("injected readiness link after commit");
        if (mode === "replace-after") {
          await original.unlink(destination);
          await original.writeFile(destination, "replacement\n", { mode: 0o600 });
          throw new Error("injected readiness replacement after link");
        }
        if (
          destination.includes(".skill-steward.readiness-")
          || destination.includes(".integration-readiness.") && destination.endsWith(".claim")
        ) fault.recoveryRenameCommitted = true;
        return result;
      }
      const result = await original.link(...args);
      if (
        destination.includes(".skill-steward.readiness-")
        || destination.includes(".integration-readiness.") && destination.endsWith(".claim")
      ) fault.recoveryRenameCommitted = true;
      return result;
    },
    async rename(...args: Parameters<typeof original.rename>) {
      const destination = String(args[1]);
      fault.publications.push(destination);
      if (fault.historyFailure && dirname(destination).endsWith("history")) {
        fault.historyFailure = false;
        throw new Error("injected readiness history publication failure");
      }
      if (
        destination === fault.destination
        || fault.destinationSuffix !== null && destination.endsWith(fault.destinationSuffix)
      ) {
        const mode = fault.mode;
        fault.mode = null;
        if (mode === "throw-before") {
          throw Object.assign(new Error("injected readiness rename failure"), { code: "EIO" });
        }
        const result = await original.rename(...args);
        if (destination.endsWith("/history/index.json")) fault.historyIndexCommitted = true;
        if (mode === "throw-after") {
          throw new Error("injected readiness rename after commit");
        }
        if (mode === "replace-after") {
          await original.unlink(destination);
          await original.writeFile(destination, "replacement\n", { mode: 0o600 });
          throw new Error("injected readiness replacement after rename");
        }
        if (
          destination.includes(".skill-steward.readiness-")
          || destination.includes(".integration-readiness.") && destination.endsWith(".claim")
        ) fault.recoveryRenameCommitted = true;
        return result;
      }
      const result = await original.rename(...args);
      if (destination.endsWith("/history/index.json")) fault.historyIndexCommitted = true;
      if (
        destination.includes(".skill-steward.readiness-")
        || destination.includes(".integration-readiness.") && destination.endsWith(".claim")
      ) fault.recoveryRenameCommitted = true;
      return result;
    },
    async unlink(...args: Parameters<typeof original.unlink>) {
      const path = String(args[0]);
      fault.unlinkEvents.push(path);
      if (
        fault.historyGcUnlinkFailure
        && path.includes(".history-gc.")
        && path.endsWith(".claim")
      ) {
        fault.historyGcUnlinkFailure = false;
        throw Object.assign(new Error("injected history GC unlink failure"), { code: "EIO" });
      }
      const nextFailure = fault.recoveryUnlinkFailureSequence[0];
      if (
        nextFailure !== undefined
        && (path === nextFailure || path.endsWith(nextFailure))
      ) {
        fault.recoveryUnlinkFailureSequence.shift();
        throw Object.assign(new Error("injected recovery alias unlink failure"), { code: "EIO" });
      }
      if (
        fault.recoveryUnlinkFailureSuffix !== null
        && path.endsWith(fault.recoveryUnlinkFailureSuffix)
      ) {
        fault.recoveryUnlinkFailureSuffix = null;
        throw Object.assign(new Error("injected recovery unlink failure"), { code: "EIO" });
      }
      if (
        fault.cleanupLeaseError
        && path.includes(".skill-steward.")
        && (path.endsWith(".tmp") || path.endsWith(".claim"))
      ) {
        fault.cleanupLeaseError = false;
        throw Object.assign(new Error("injected nested lease loss"), {
          code: "INTEGRATION_LEASE_LOST"
        });
      }
      const result = await original.unlink(...args);
      if (path.includes(".history-gc.") && path.endsWith(".claim")) {
        fault.historyGcClaimUnlinked = true;
      }
      return result;
    }
  };
});

afterEach(() => {
  fault.destination = null;
  fault.destinationSuffix = null;
  fault.mode = null;
  fault.historyFailure = false;
  fault.historySyncFailureCode = null;
  fault.failHistoryIndexParentSync = false;
  fault.historyIndexCommitted = false;
  fault.cleanupLeaseError = false;
  fault.historyGcUnlinkFailure = false;
  fault.failHistoryDirectorySyncAfterGcClaimUnlink = false;
  fault.historyGcClaimUnlinked = false;
  fault.historyDirectorySyncFailures = 0;
  fault.historyDirectorySyncs = 0;
  fault.replaceHistoryGcSourceBeforeLink = false;
  fault.replaceHistoryIndexResidueBeforeLink = false;
  fault.recoveryUnlinkFailureSuffix = null;
  fault.recoveryUnlinkFailureSequence = [];
  fault.failSyncAfterRecoveryRename = false;
  fault.recoveryRenameCommitted = false;
  fault.publications = [];
  fault.unlinkEvents = [];
});

const report = (character: string, hour = 0): PortfolioReport => ({
  schemaVersion: 1,
  generatedAt: `2026-07-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
  portfolioFingerprint: `sha256:${character.repeat(64)}`,
  skills: [],
  findings: []
});

const historyReport = (index: number): PortfolioReport => ({
  ...report("a"),
  generatedAt: new Date(Date.UTC(2026, 6, 2, 0, 0, index)).toISOString(),
  portfolioFingerprint: `sha256:${index.toString(16).padStart(64, "0")}`
});

async function seedIntegrationHistory(stateDirectory: string, count = 50): Promise<void> {
  const historyDirectory = join(stateDirectory, "history");
  await mkdir(historyDirectory, { mode: 0o700 });
  const reports = Array.from({ length: count }, (_, index) => historyReport(index));
  await Promise.all(reports.map((item) => writeFile(
    join(historyDirectory, `${item.portfolioFingerprint.slice("sha256:".length)}.json`),
    `${JSON.stringify(item, null, 2)}\n`,
    { mode: 0o600 }
  )));
  await writeFile(join(historyDirectory, "index.json"), `${JSON.stringify(
    [...reports].reverse().map((item) => ({
      portfolioFingerprint: item.portfolioFingerprint,
      generatedAt: item.generatedAt,
      fileName: `${item.portfolioFingerprint.slice("sha256:".length)}.json`
    })),
    null,
    2
  )}\n`, { mode: 0o600 });
}

const largeReport = (character: string, hour: number): PortfolioReport => ({
  ...report(character, hour),
  findings: [{
    id: `large-${character}`,
    code: "LARGE_FIXTURE",
    severity: "info",
    skillIds: [],
    summary: character.repeat(3_700_000),
    evidence: [],
    recommendation: "Keep the bounded report readable",
    confidence: 1
  }]
});

function readinessErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((item) => readinessErrorMessages(item, seen))];
  }
  if (error instanceof Error) {
    return [error.message, ...readinessErrorMessages(error.cause, seen)];
  }
  return [];
}

async function findReadinessBackup(stateDirectory: string): Promise<string> {
  const name = (await readdir(stateDirectory)).find((entry) =>
    entry.startsWith(".integration-readiness.") && entry.endsWith(".backup.json"));
  if (!name) throw new Error("Expected a readiness backup");
  return join(stateDirectory, name);
}

interface ReadinessFixtureAuthority {
  transactionId: string;
  trigger: IntegrationReadinessPublishOptions["trigger"];
}

const readinessFixtureAuthority = new WeakMap<
  IntegrationReadinessTransactionHandle,
  ReadinessFixtureAuthority
>();

function fixturePublishOptions(
  options: IntegrationFileMutationOptions,
  transactionId = randomUUID()
): IntegrationReadinessPublishOptions {
  return {
    ...options,
    transactionId,
    trigger: {
      planId: `plan-${transactionId}`,
      harness: "codex",
      createdAt: "2026-07-02T00:00:00.000Z"
    }
  };
}

async function publishIntegrationReadiness(
  input: PortfolioReport,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessTransactionHandle> {
  const publishOptions = fixturePublishOptions(options);
  const handle = await publishIntegrationReadinessActual(input, publishOptions);
  readinessFixtureAuthority.set(handle, {
    transactionId: publishOptions.transactionId,
    trigger: publishOptions.trigger
  });
  return handle;
}

function fixtureRecord(
  authority: ReadinessFixtureAuthority,
  stateDirectory: string
): IntegrationRecordV2 {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: 2,
    id: authority.transactionId,
    harness: authority.trigger.harness,
    action: "apply",
    status: "installed",
    targetPath: join(stateDirectory, "fixture-hooks.json"),
    beforeFingerprint: fingerprint,
    afterFingerprint: fingerprint,
    installedEntryFingerprint: fingerprint,
    companion: {
      action: "none",
      path: join(stateDirectory, "fixture-skill"),
      before: { state: "exact", fingerprint },
      after: { state: "exact", fingerprint },
      source: { fingerprint },
      proof: { category: "recorded" },
      installedFingerprint: fingerprint,
      consumers: [authority.trigger.harness]
    },
    trigger: authority.trigger,
    createdAt: authority.trigger.createdAt
  };
}

async function commitFixtureRecord(
  handle: IntegrationReadinessTransactionHandle,
  stateDirectory: string
): Promise<IntegrationRecordCommitReceipt> {
  const authority = readinessFixtureAuthority.get(handle);
  if (!authority) throw new Error("Missing readiness fixture authority");
  return appendIntegrationRecord(stateDirectory, fixtureRecord(authority, stateDirectory));
}

async function runRecoveryInFreshProcess(
  stateDirectory: string,
  artifactPath: string
): Promise<void> {
  const recovererPath = join(
    dirname(fileURLToPath(import.meta.url)),
    `.readiness-recoverer-${randomUUID()}.cjs`
  );
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/integration-readiness-recoverer.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile: recovererPath,
    logLevel: "silent"
  });
  try {
    await new Promise<void>((resolveProcess, rejectProcess) => {
      const child = spawn(process.execPath, [recovererPath, stateDirectory, artifactPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", rejectProcess);
      child.once("exit", (code) => {
        if (code === 0) resolveProcess();
        else rejectProcess(new Error(`recoverer exited ${String(code)}: ${stderr}`));
      });
    });
  } finally {
    await unlink(recovererPath).catch(() => undefined);
  }
}

async function finalizeIntegrationReadiness(
  handle: IntegrationReadinessTransactionHandle,
  options: IntegrationFileMutationOptions
) {
  const receipt = await commitFixtureRecord(handle, options.stateDirectory);
  return finalizeIntegrationReadinessActual(handle, receipt, options);
}

async function prepareCommittedReadinessRecovery(
  root: string,
  stateDirectory: string,
  transactionId: string,
  planId: string
): Promise<IntegrationRecordV2> {
  const api = await import("../src/index.js");
  let lifecycleRecord!: IntegrationRecordV2;
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    const options = fixturePublishOptions({ stateDirectory, leaseContext });
    options.trigger = {
      planId,
      harness: "codex",
      createdAt: "2026-07-05T00:00:00.000Z"
    };
    lifecycleRecord = fixtureRecord({
      transactionId: options.transactionId,
      trigger: options.trigger
    }, stateDirectory);
    let recovery = await api.createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId,
      harness: "codex",
      action: "none",
      companionPath: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
      configPath: join(root, "home", ".codex", "hooks.json"),
      beforeFingerprint: `sha256:${"d".repeat(64)}`,
      afterFingerprint: `sha256:${"d".repeat(64)}`,
      createdAt: "2026-07-05T00:00:00.000Z",
      lifecycleRecordBinding: bindIntegrationRecordV2(lifecycleRecord),
      artifactHints: []
    }, { leaseContext });
    await publishIntegrationReadinessActual(report("b", 1), {
      ...options,
      recovery: {
        transactionId,
        beforePublish: async (artifact) => {
          recovery = await api.appendIntegrationRecoveryTransition(stateDirectory, {
            transactionId,
            expectedSequence: recovery.sequence,
            expectedState: recovery.state,
            state: "mutating",
            transitionedAt: "2026-07-05T00:00:01.000Z",
            readinessArtifactAddition: artifact
          }, { leaseContext });
        }
      }
    });
    await appendIntegrationRecord(stateDirectory, lifecycleRecord);
    await api.appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId,
      expectedSequence: recovery.sequence,
      expectedState: recovery.state,
      state: "committed",
      transitionedAt: "2026-07-05T00:00:02.000Z"
    }, { leaseContext });
  });
  return lifecycleRecord;
}

describe("integration readiness store", () => {
  it("checkpoints a compact recovery binding before latest or previous publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-checkpoint-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(report("a"), null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(stateDirectory, "previous-report.json"),
      `${JSON.stringify(report("c", 2), null, 2)}\n`,
      { mode: 0o600 }
    );
    let checkpoint: unknown;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = fixturePublishOptions({ stateDirectory, leaseContext });
      await publishIntegrationReadinessActual(report("b", 1), {
        ...options,
        recovery: {
          transactionId: "123e4567-e89b-42d3-a456-426614174000",
          beforePublish: async (binding: unknown) => {
            checkpoint = binding;
            expect(Object.isFrozen(binding)).toBe(true);
            expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
            expect(await readPreviousReport(stateDirectory)).toEqual(report("c", 2));
            await expect(findReadinessBackup(stateDirectory)).resolves.toMatch(/backup\.json$/);
          }
        }
      } as IntegrationReadinessPublishOptions & {
        recovery: {
          transactionId: string;
          beforePublish(binding: unknown): Promise<void>;
        };
      });
    });

    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      recoveryTransactionId: "123e4567-e89b-42d3-a456-426614174000",
      stateDirectory,
      latest: { observed: { state: "file" } },
      previous: { observed: { state: "file" } }
    });
    expect(JSON.stringify(checkpoint).length).toBeLessThan(32 * 1024);
    expect(await readLatestReport(stateDirectory)).toEqual(report("b", 1));
    expect(await readPreviousReport(stateDirectory)).toEqual(report("a"));
  });

  it.each(["absent", "file"] as const)(
    "restores %s readiness from a fresh Store-issued one-shot authority",
    async (beforeState) => {
      const api = await import("../src/index.js") as typeof import("../src/index.js") & {
        restoreIntegrationReadinessFromRecovery: Function;
      };
      expect(typeof api.restoreIntegrationReadinessFromRecovery).toBe("function");
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-authority-"));
      const stateDirectory = join(root, "state");
      const transactionId = "123e4567-e89b-42d3-a456-426614174000";
      await mkdir(stateDirectory, { mode: 0o700 });
      if (beforeState === "file") {
        await writeFile(
          join(stateDirectory, "latest-report.json"),
          `${JSON.stringify(report("a"), null, 2)}\n`,
          { mode: 0o600 }
        );
        await writeFile(
          join(stateDirectory, "previous-report.json"),
          `${JSON.stringify(report("c", 2), null, 2)}\n`,
          { mode: 0o600 }
        );
      }

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const options = fixturePublishOptions({ stateDirectory, leaseContext });
        options.trigger = {
          planId: `readiness-recovery-${beforeState}`,
          harness: "codex",
          createdAt: "2026-07-05T00:00:00.000Z"
        };
        const lifecycleRecord = fixtureRecord({
          transactionId: options.transactionId,
          trigger: options.trigger
        }, stateDirectory);
        let recovery = await api.createIntegrationRecoveryIntent(stateDirectory, {
          schemaVersion: 1,
          transactionId,
          planId: `readiness-recovery-${beforeState}`,
          harness: "codex",
          action: "none",
          companionPath: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
          configPath: join(root, "home", ".codex", "hooks.json"),
          beforeFingerprint: `sha256:${"d".repeat(64)}`,
          afterFingerprint: `sha256:${"d".repeat(64)}`,
          createdAt: "2026-07-05T00:00:00.000Z",
          lifecycleRecordBinding: bindIntegrationRecordV2(lifecycleRecord),
          artifactHints: []
        }, { leaseContext });
        await publishIntegrationReadinessActual(report("b", 1), {
          ...options,
          recovery: {
            transactionId,
            beforePublish: async (artifact) => {
              recovery = await api.appendIntegrationRecoveryTransition(stateDirectory, {
                transactionId,
                expectedSequence: recovery.sequence,
                expectedState: recovery.state,
                state: "mutating",
                transitionedAt: "2026-07-05T00:00:01.000Z",
                readinessArtifactAddition: artifact
              }, { leaseContext });
            }
          }
        });
      });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const restartedStore = api.createIntegrationRecoveryStore() as unknown as {
          loadIntegrationReadinessRecoveryAuthority: Function;
        };
        expect(typeof restartedStore.loadIntegrationReadinessRecoveryAuthority).toBe("function");
        const modeAuthority = await restartedStore.loadIntegrationReadinessRecoveryAuthority(
          stateDirectory,
          { transactionId, operation: "restore" },
          { leaseContext }
        );
        const backupPath = await findReadinessBackup(stateDirectory);
        await chmod(backupPath, 0o640);
        await expect(api.restoreIntegrationReadinessFromRecovery(modeAuthority, {
          stateDirectory,
          leaseContext
        })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE" });
        expect(await readLatestReport(stateDirectory)).toEqual(report("b", 1));
        expect(await readPreviousReport(stateDirectory)).toEqual(
          beforeState === "file" ? report("a") : undefined
        );
        await chmod(backupPath, 0o600);
        const staleAuthority = await restartedStore.loadIntegrationReadinessRecoveryAuthority(
          stateDirectory,
          { transactionId, operation: "restore" },
          { leaseContext }
        );
        await api.appendIntegrationRecoveryTransition(stateDirectory, {
          transactionId,
          expectedSequence: 1,
          expectedState: "mutating",
          state: "recovery-required",
          transitionedAt: "2026-07-05T00:00:02.000Z"
        }, { leaseContext });
        await expect(api.restoreIntegrationReadinessFromRecovery(staleAuthority, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/stale|changed|authority/i);
        const authority = await restartedStore.loadIntegrationReadinessRecoveryAuthority(
          stateDirectory,
          { transactionId, operation: "restore" },
          { leaseContext }
        );
        await expect(api.restoreIntegrationReadinessFromRecovery(authority, {
          stateDirectory: join(root, "other-state"),
          leaseContext
        })).rejects.toThrow(/mismatched|authority/i);
        await expect(api.restoreIntegrationReadinessFromRecovery(
          structuredClone(authority),
          { stateDirectory, leaseContext }
        )).rejects.toThrow(/Store-issued|forged|authority/i);
        await expect(api.restoreIntegrationReadinessFromRecovery(
          {} as never,
          { stateDirectory, leaseContext }
        )).rejects.toThrow(/Store-issued|forged|authority/i);
        await api.restoreIntegrationReadinessFromRecovery(authority, {
          stateDirectory,
          leaseContext
        });
        await expect(api.restoreIntegrationReadinessFromRecovery(authority, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/stale|consumed|authority/i);
      });

      if (beforeState === "file") {
        expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
        expect(await readPreviousReport(stateDirectory)).toEqual(report("c", 2));
      } else {
        expect(await readLatestReport(stateDirectory)).toBeUndefined();
        expect(await readPreviousReport(stateDirectory)).toBeUndefined();
      }
    }
  );

  it("finalizes committed readiness from a fresh Store-issued authority", async () => {
    const api = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-finalize-"));
    const stateDirectory = join(root, "state");
    const transactionId = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(report("a"), null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = fixturePublishOptions({ stateDirectory, leaseContext });
      options.trigger = {
        planId: "readiness-recovery-finalize",
        harness: "codex",
        createdAt: "2026-07-05T00:00:00.000Z"
      };
      const lifecycleRecord = fixtureRecord({
        transactionId: options.transactionId,
        trigger: options.trigger
      }, stateDirectory);
      let recovery = await api.createIntegrationRecoveryIntent(stateDirectory, {
        schemaVersion: 1,
        transactionId,
        planId: "readiness-recovery-finalize",
        harness: "codex",
        action: "none",
        companionPath: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
        configPath: join(root, "home", ".codex", "hooks.json"),
        beforeFingerprint: `sha256:${"d".repeat(64)}`,
        afterFingerprint: `sha256:${"d".repeat(64)}`,
        createdAt: "2026-07-05T00:00:00.000Z",
        lifecycleRecordBinding: bindIntegrationRecordV2(lifecycleRecord),
        artifactHints: []
      }, { leaseContext });
      await publishIntegrationReadinessActual(report("b", 1), {
        ...options,
        recovery: {
          transactionId,
          beforePublish: async (artifact) => {
            recovery = await api.appendIntegrationRecoveryTransition(stateDirectory, {
              transactionId,
              expectedSequence: recovery.sequence,
              expectedState: recovery.state,
              state: "mutating",
              transitionedAt: "2026-07-05T00:00:01.000Z",
              readinessArtifactAddition: artifact
            }, { leaseContext });
          }
        }
      });
      await appendIntegrationRecord(stateDirectory, lifecycleRecord);
      await api.appendIntegrationRecoveryTransition(stateDirectory, {
        transactionId,
        expectedSequence: recovery.sequence,
        expectedState: recovery.state,
        state: "committed",
        transitionedAt: "2026-07-05T00:00:02.000Z"
      }, { leaseContext });
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const authority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      await api.finalizeIntegrationReadinessFromRecovery(authority, {
        stateDirectory,
        leaseContext
      });
    });

    expect(await readLatestReport(stateDirectory)).toEqual(report("b", 1));
    expect(await readPreviousReport(stateDirectory)).toEqual(report("a"));
    expect(await readReportHistory(stateDirectory)).toEqual([report("b", 1)]);
    await expect(findReadinessBackup(stateDirectory)).rejects.toThrow(/Expected/);
  });

  it("retains fresh readiness recovery authority when history append fails and retries", async () => {
    const api = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-history-retry-"));
    const stateDirectory = join(root, "state");
    const transactionId = "123e4567-e89b-42d3-a456-426614174001";
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(report("a"), null, 2)}\n`,
      { mode: 0o600 }
    );
    await prepareCommittedReadinessRecovery(
      root,
      stateDirectory,
      transactionId,
      "readiness-recovery-history-retry"
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const backupPath = await findReadinessBackup(stateDirectory);
      const authority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      fault.historyFailure = true;
      await expect(api.finalizeIntegrationReadinessFromRecovery(authority, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect(await readReportHistory(stateDirectory)).toEqual([]);
      expect(await readFile(backupPath, "utf8")).toContain('"schemaVersion": 1');

      const retryAuthority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      await api.finalizeIntegrationReadinessFromRecovery(retryAuthority, {
        stateDirectory,
        leaseContext
      });
    });

    expect(await readReportHistory(stateDirectory)).toEqual([report("b", 1)]);
    await expect(findReadinessBackup(stateDirectory)).rejects.toThrow(/Expected/);
  });

  it("retries fresh readiness cleanup after history append without duplicating history", async () => {
    const api = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-cleanup-retry-"));
    const stateDirectory = join(root, "state");
    const transactionId = "123e4567-e89b-42d3-a456-426614174002";
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(report("a"), null, 2)}\n`,
      { mode: 0o600 }
    );
    await prepareCommittedReadinessRecovery(
      root,
      stateDirectory,
      transactionId,
      "readiness-recovery-cleanup-retry"
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const backupPath = await findReadinessBackup(stateDirectory);
      const readinessTransactionId = integrationReadinessBackupSchema.parse(JSON.parse(
        await readFile(backupPath, "utf8")
      )).transactionId;
      const cleanupPath = `${backupPath}.recovery-${createHash("sha256")
        .update(`${readinessTransactionId}:backup`)
        .digest("hex")
        .slice(0, 24)}.claim`;
      const authority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      fault.recoveryUnlinkFailureSequence = [cleanupPath];
      await expect(api.finalizeIntegrationReadinessFromRecovery(authority, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect(await readReportHistory(stateDirectory)).toEqual([report("b", 1)]);
      expect(await readFile(cleanupPath, "utf8")).toContain('"schemaVersion": 1');

      const retryAuthority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      await api.finalizeIntegrationReadinessFromRecovery(retryAuthority, {
        stateDirectory,
        leaseContext
      });
      expect(await readReportHistory(stateDirectory)).toEqual([report("b", 1)]);
      await expect(readFile(cleanupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves fresh readiness recovery artifacts when the journal head advances", async () => {
    const api = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-recovery-head-advance-"));
    const stateDirectory = join(root, "state");
    const transactionId = "123e4567-e89b-42d3-a456-426614174003";
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(report("a"), null, 2)}\n`,
      { mode: 0o600 }
    );
    const lifecycleRecord = await prepareCommittedReadinessRecovery(
      root,
      stateDirectory,
      transactionId,
      "readiness-recovery-head-advance"
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const backupPath = await findReadinessBackup(stateDirectory);
      const readinessTransactionId = integrationReadinessBackupSchema.parse(JSON.parse(
        await readFile(backupPath, "utf8")
      )).transactionId;
      const cleanupPath = `${backupPath}.recovery-${createHash("sha256")
        .update(`${readinessTransactionId}:backup`)
        .digest("hex")
        .slice(0, 24)}.claim`;
      const authority = await api.loadIntegrationReadinessRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      await rename(backupPath, cleanupPath);
      await appendIntegrationRecord(stateDirectory, {
        ...lifecycleRecord,
        id: randomUUID(),
        trigger: {
          ...lifecycleRecord.trigger,
          createdAt: "2026-07-05T00:00:03.000Z"
        },
        createdAt: "2026-07-05T00:00:03.000Z"
      });
      await expect(api.finalizeIntegrationReadinessFromRecovery(authority, {
        stateDirectory,
        leaseContext
      })).rejects.toThrow(/exact current journal head/i);
      expect(await readReportHistory(stateDirectory)).toEqual([]);
      await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(cleanupPath, "utf8")).toContain('"schemaVersion": 1');
    });
  });

  it.each(["absent", "file"] as const)(
    "restores %s readiness after a real publisher process is killed",
    async (beforeState) => {
      const api = await import("../src/index.js");
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-crash-recovery-"));
      const stateDirectory = join(root, "state");
      const markerPath = join(root, "published.marker");
      const workerPath = join(root, "readiness-crash-worker.cjs");
      await mkdir(stateDirectory, { mode: 0o700 });
      if (beforeState === "file") {
        await writeFile(
          join(stateDirectory, "latest-report.json"),
          `${JSON.stringify(report("a"), null, 2)}\n`,
          { mode: 0o600 }
        );
        await writeFile(
          join(stateDirectory, "previous-report.json"),
          `${JSON.stringify(report("c", 2), null, 2)}\n`,
          { mode: 0o600 }
        );
      }
      await build({
        entryPoints: [fileURLToPath(new URL(
          "./fixtures/integration-readiness-crash-worker.ts",
          import.meta.url
        ))],
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        outfile: workerPath,
        logLevel: "silent"
      });

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
        (resolveProcess, rejectProcess) => {
          const child = spawn(process.execPath, [
            workerPath,
            stateDirectory,
            beforeState,
            markerPath
          ], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
          child.once("error", rejectProcess);
          child.once("exit", (code, signal) => resolveProcess({ code, signal, stderr }));
        }
      );
      expect(result).toMatchObject({ code: null, signal: "SIGKILL", stderr: "" });
      expect(await readFile(markerPath, "utf8")).toBe("published\n");
      expect(await readLatestReport(stateDirectory)).toEqual(report("b", 1));

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const restartedStore = api.createIntegrationRecoveryStore();
        const authority = await restartedStore.loadIntegrationReadinessRecoveryAuthority(
          stateDirectory,
          {
            transactionId: "123e4567-e89b-42d3-a456-426614174000",
            operation: "restore"
          },
          { leaseContext }
        );
        await api.restoreIntegrationReadinessFromRecovery(authority, {
          stateDirectory,
          leaseContext
        });
      }, {
        waitMs: 2_000,
        pollMs: 2,
        staleMs: 10,
        hardStaleMs: 120_000
      });

      if (beforeState === "file") {
        expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
        expect(await readPreviousReport(stateDirectory)).toEqual(report("c", 2));
      } else {
        expect(await readLatestReport(stateDirectory)).toBeUndefined();
        expect(await readPreviousReport(stateDirectory)).toBeUndefined();
      }
    },
    10_000
  );

  it("rejects oversized untrusted recovery strings before base64 refinement", () => {
    const oversized = "A".repeat(6_000_000);
    const decode = vi.spyOn(Buffer, "from");
    const backup = integrationReadinessBackupSchema.safeParse({
      schemaVersion: 1,
      transactionId: "bounded",
      reportFingerprint: `sha256:${"a".repeat(64)}`,
      trigger: {
        planId: "bounded-plan",
        harness: "codex",
        createdAt: "2026-07-02T00:00:00.000Z"
      },
      latest: { state: "absent" },
      previous: { state: "absent" },
      intended: {
        latest: {
          state: "file",
          bytesBase64: oversized,
          fingerprint: `sha256:${"b".repeat(64)}`,
          mode: 0o600
        },
        previous: { state: "absent" }
      }
    });
    expect(backup.success).toBe(false);
    if (!backup.success) {
      expect(backup.error.issues.some((issue) => issue.code === "too_big")).toBe(true);
    }

    const artifact = integrationReadinessRecoveryArtifactSchema.safeParse({
      schemaVersion: 1,
      transactionId: "bounded",
      stateDirectory: `/${"x".repeat(5_000)}`,
      stateDirectoryIdentity: { device: "1", inode: "1" },
      reportFingerprint: `sha256:${"a".repeat(64)}`,
      trigger: {
        planId: "bounded-plan",
        harness: "codex",
        createdAt: "2026-07-02T00:00:00.000Z"
      },
      backup: {
        fingerprint: `sha256:${"c".repeat(64)}`,
        identity: { device: "1", inode: "1" }
      },
      latest: { before: { state: "absent" }, observed: { state: "absent" } },
      previous: { before: { state: "absent" }, observed: { state: "absent" } }
    });
    expect(artifact.success).toBe(false);
    if (!artifact.success) {
      expect(artifact.error.issues.some((issue) => issue.code === "too_big")).toBe(true);
    }
    expect((decode.mock.calls as unknown[][]).some(([value, encoding]) =>
      value === oversized && encoding === "base64")).toBe(false);
    decode.mockRestore();
  });

  it("returns a frozen opaque readiness authority handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-opaque-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.keys(handle)).toEqual([]);
      expect(() => {
        (handle as unknown as Record<string, unknown>).report = report("b");
      }).toThrow();
    });
  });

  it("rejects forged and JSON-cloned readiness handles before touching state", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-forged-"));
    const stateDirectory = join(root, "state");
    const otherState = join(root, "other-state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(otherState, { mode: 0o700 });
    let authentic!: IntegrationReadinessTransactionHandle;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      authentic = handle;
      for (const forged of [{}, JSON.parse(JSON.stringify(handle))]) {
        await expect(restoreIntegrationReadiness(forged as never, {
          stateDirectory,
          leaseContext
        })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
        expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
      }
    });
    await withIntegrationMutationLease(otherState, async (leaseContext) => {
      await expect(restoreIntegrationReadiness(authentic, {
        stateDirectory: otherState,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
    });
    expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
    expect(await readdir(otherState)).toEqual([]);
  });

  it("finalizes only with the exact committed v2 record receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-commit-gate-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const publishOptions = fixturePublishOptions({ stateDirectory, leaseContext });
      const handle = await publishIntegrationReadinessActual(report("a"), publishOptions);

      await expect(finalizeIntegrationReadinessActual(
        handle,
        Object.freeze(Object.create(null)) as IntegrationRecordCommitReceipt,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
      expect(await readReportHistory(stateDirectory)).toEqual([]);

      const legacy: IntegrationRecordV1 = {
        schemaVersion: 1,
        id: `legacy-${publishOptions.transactionId}`,
        harness: "codex",
        action: "apply",
        status: "installed",
        targetPath: join(stateDirectory, "legacy.json"),
        beforeFingerprint: `sha256:${"a".repeat(64)}`,
        afterFingerprint: `sha256:${"a".repeat(64)}`,
        installedEntryFingerprint: `sha256:${"a".repeat(64)}`,
        createdAt: publishOptions.trigger.createdAt
      };
      const legacyReceipt = await appendIntegrationRecord(stateDirectory, legacy);
      await expect(finalizeIntegrationReadinessActual(
        handle,
        legacyReceipt,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });

      const unrelated = fixtureRecord({
        transactionId: randomUUID(),
        trigger: publishOptions.trigger
      }, stateDirectory);
      const unrelatedReceipt = await appendIntegrationRecord(stateDirectory, unrelated);
      await expect(finalizeIntegrationReadinessActual(
        handle,
        unrelatedReceipt,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });

      const exactReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({
          transactionId: publishOptions.transactionId,
          trigger: publishOptions.trigger
        }, stateDirectory)
      );
      await expect(finalizeIntegrationReadinessActual(
        handle,
        exactReceipt,
        { stateDirectory, leaseContext }
      )).resolves.toEqual({ status: "finalized", warnings: [] });
      expect(await readReportHistory(stateDirectory)).toEqual([report("a")]);
    });
  });

  it("makes readiness restore and finalize terminal and prevents receipt replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-terminal-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const restoredOptions = fixturePublishOptions({ stateDirectory, leaseContext });
      const restored = await publishIntegrationReadinessActual(report("a"), restoredOptions);
      await restoreIntegrationReadiness(restored, { stateDirectory, leaseContext });
      expect(integrationReadinessTransactionReceipt(restored).status).toBe("restored");
      const restoredReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({
          transactionId: restoredOptions.transactionId,
          trigger: restoredOptions.trigger
        }, stateDirectory)
      );
      await expect(finalizeIntegrationReadinessActual(
        restored,
        restoredReceipt,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
      expect(await readLatestReport(stateDirectory)).toBeUndefined();

      const finalizedOptions = fixturePublishOptions({ stateDirectory, leaseContext });
      const finalized = await publishIntegrationReadinessActual(report("b"), finalizedOptions);
      const exactReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({
          transactionId: finalizedOptions.transactionId,
          trigger: finalizedOptions.trigger
        }, stateDirectory)
      );
      const repeated = finalizeIntegrationReadinessActual(
        finalized,
        exactReceipt,
        { stateDirectory, leaseContext }
      );
      await expect(repeated).resolves.toEqual({ status: "finalized", warnings: [] });
      const repeatedResult = await repeated;
      expect(Object.isFrozen(repeatedResult)).toBe(true);
      expect(Object.isFrozen(repeatedResult.warnings)).toBe(true);
      expect(() => {
        (repeatedResult as { status: string }).status = "committed-warning";
      }).toThrow();
      expect(integrationReadinessTransactionReceipt(finalized).status).toBe("finalized");
      const secondResult = await finalizeIntegrationReadinessActual(
        finalized,
        exactReceipt,
        { stateDirectory, leaseContext }
      );
      expect(secondResult).toEqual({ status: "finalized", warnings: [] });
      expect(Object.isFrozen(secondResult)).toBe(true);
      expect(Object.isFrozen(secondResult.warnings)).toBe(true);
      expect(secondResult).not.toBe(repeatedResult);
      await expect(restoreIntegrationReadiness(finalized, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });

      const replayed = await publishIntegrationReadinessActual(report("c", 1), finalizedOptions);
      await expect(finalizeIntegrationReadinessActual(
        replayed,
        exactReceipt,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
      expect(integrationReadinessTransactionReceipt(replayed).status).toBe("published");
    });
  });

  it("keeps a receipt-paired committed handle retryable after a history warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-committed-history-retry-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = fixturePublishOptions({ stateDirectory, leaseContext });
      const handle = await publishIntegrationReadinessActual(report("a"), options);
      const exactReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({ transactionId: options.transactionId, trigger: options.trigger }, stateDirectory)
      );
      const wrongReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({ transactionId: options.transactionId, trigger: options.trigger }, stateDirectory)
      );
      fault.historyFailure = true;

      await expect(finalizeIntegrationReadinessActual(handle, exactReceipt, {
        stateDirectory,
        leaseContext
      })).resolves.toMatchObject({
        status: "committed-warning",
        warnings: [{ code: "INTEGRATION_READINESS_HISTORY_PENDING" }]
      });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");
      expect(integrationReadinessRecoveryArtifact(handle)).toMatchObject({
        transactionId: options.transactionId
      });
      expect(await readIntegrationReadinessBackup(handle, {
        stateDirectory,
        leaseContext
      })).toMatchObject({ transactionId: options.transactionId });

      fault.publications = [];
      fault.unlinkEvents = [];
      await expect(restoreIntegrationReadiness(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
      expect(fault.publications).toEqual([]);
      expect(fault.unlinkEvents).toEqual([]);
      expect(await readLatestReport(stateDirectory)).toEqual(report("a"));

      await expect(finalizeIntegrationReadinessActual(handle, wrongReceipt, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_INVALID" });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");

      await expect(finalizeIntegrationReadinessActual(handle, exactReceipt, {
        stateDirectory,
        leaseContext
      })).resolves.toEqual({ status: "finalized", warnings: [] });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("finalized");
    });
  });

  it("retries committed readiness cleanup with the same receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-committed-cleanup-retry-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = fixturePublishOptions({ stateDirectory, leaseContext });
      const handle = await publishIntegrationReadinessActual(report("a"), options);
      const exactReceipt = await appendIntegrationRecord(
        stateDirectory,
        fixtureRecord({ transactionId: options.transactionId, trigger: options.trigger }, stateDirectory)
      );
      fault.recoveryUnlinkFailureSuffix = ".claim";

      await expect(finalizeIntegrationReadinessActual(handle, exactReceipt, {
        stateDirectory,
        leaseContext
      })).resolves.toMatchObject({
        status: "committed-warning",
        warnings: [{ code: "INTEGRATION_READINESS_CLEANUP_PENDING" }]
      });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");
      await expect(finalizeIntegrationReadinessActual(handle, exactReceipt, {
        stateDirectory,
        leaseContext
      })).resolves.toEqual({ status: "finalized", warnings: [] });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("finalized");
    });
  });

  it("restores exact pre-state from a JSON artifact in a fresh process", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-restart-"));
    const stateDirectory = join(root, "state");
    const artifactPath = join(root, "recovery.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const previous = report("b", 1);
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(current, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(stateDirectory, "previous-report.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      });
      const artifact = integrationReadinessRecoveryArtifact(handle);
      expect(Object.isFrozen(artifact)).toBe(true);
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    });

    await runRecoveryInFreshProcess(stateDirectory, artifactPath);

    expect(await readLatestReport(stateDirectory)).toEqual(current);
    expect(await readPreviousReport(stateDirectory)).toEqual(previous);
    expect((await readdir(stateDirectory)).some((name) =>
      name.startsWith(".integration-readiness."))).toBe(false);
  });

  it("retries restart recovery after latest was already restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-retry-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const previous = report("b", 1);
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(current, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(stateDirectory, "previous-report.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      });
      const artifact = JSON.parse(JSON.stringify(integrationReadinessRecoveryArtifact(handle)));
      fault.destination = join(stateDirectory, "previous-report.json");
      fault.mode = "throw-before";
      await expect(restoreIntegrationReadinessFromArtifact(artifact, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE" });
      expect(await readLatestReport(stateDirectory)).toEqual(current);

      await expect(restoreIntegrationReadinessFromArtifact(artifact, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    expect(await readLatestReport(stateDirectory)).toEqual(current);
    expect(await readPreviousReport(stateDirectory)).toEqual(previous);
    expect((await readdir(stateDirectory)).filter((name) =>
      name.includes(".skill-steward") || name.endsWith(".claim"))).toEqual([]);
  });

  it("never mutates reports from a replayed artifact after central authority is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-replay-"));
    const stateDirectory = join(root, "state");
    const artifactPath = join(root, "recovery.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    const before = report("a");
    const published = report("b", 1);
    let transactionId = "";
    let savedBackup = Buffer.alloc(0);
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(before, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(published, {
        stateDirectory,
        leaseContext
      });
      const artifact = JSON.parse(JSON.stringify(integrationReadinessRecoveryArtifact(handle)));
      transactionId = artifact.transactionId;
      savedBackup = await readFile(integrationReadinessBackupPath(stateDirectory, transactionId));
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      await restoreIntegrationReadinessFromArtifact(artifact, { stateDirectory, leaseContext });
    });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(published, null, 2)}\n`,
      { mode: 0o600 }
    );
    const residueKey = createHash("sha256")
      .update(`${transactionId}:latest`)
      .digest("hex")
      .slice(0, 24);
    const forgedResidue = `${join(stateDirectory, "latest-report.json")}.skill-steward.readiness-${residueKey}.tmp`;
    await writeFile(forgedResidue, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });
    const backupPath = integrationReadinessBackupPath(stateDirectory, transactionId);
    const backupPublicationTemporary = `${backupPath}.skill-steward.${integrationReadinessPublicationTransactionId(
      transactionId,
      "backup"
    )}.tmp`;
    const backupPublicationClaim = `${backupPublicationTemporary}.cleanup.claim`;
    await writeFile(backupPublicationTemporary, savedBackup, { mode: 0o600 });
    await writeFile(backupPublicationClaim, savedBackup, { mode: 0o600 });

    await expect(runRecoveryInFreshProcess(stateDirectory, artifactPath)).rejects.toThrow(
      /backup publication residue could not be reconciled exactly/
    );
    expect(await readLatestReport(stateDirectory)).toEqual(published);
    expect(await readFile(forgedResidue, "utf8")).toBe(`${JSON.stringify(before, null, 2)}\n`);
    expect(await readFile(backupPublicationTemporary)).toEqual(savedBackup);
    expect(await readFile(backupPublicationClaim)).toEqual(savedBackup);
  });

  it("derives recovery after reconciling an exact backup-publication cleanup claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-backup-publish-residue-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      const transactionId = integrationReadinessTransactionReceipt(handle).transactionId;
      const backupPath = integrationReadinessBackupPath(stateDirectory, transactionId);
      const temporary = `${backupPath}.skill-steward.${integrationReadinessPublicationTransactionId(
        transactionId,
        "backup"
      )}.tmp`;
      const cleanupClaim = `${temporary}.cleanup.claim`;
      await rename(backupPath, cleanupClaim);

      const artifact = await deriveIntegrationReadinessRecoveryArtifact(transactionId, {
        stateDirectory,
        leaseContext
      });
      expect(artifact.transactionId).toBe(transactionId);
      expect(await readFile(backupPath, "utf8")).toContain(`"transactionId": "${transactionId}"`);
      await restoreIntegrationReadinessFromArtifact(artifact, { stateDirectory, leaseContext });
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
    });
  });

  it.each([".discard", ".claim"])(
    "a fresh process reconciles recovery residue after %s unlink failure",
    async (failureSuffix) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-residue-retry-"));
      const stateDirectory = join(root, "state");
      const artifactPath = join(root, "recovery.json");
      await mkdir(stateDirectory, { mode: 0o700 });
      const current = report("a");
      const previous = report("b", 1);
      await writeFile(
        join(stateDirectory, "latest-report.json"),
        `${JSON.stringify(current, null, 2)}\n`,
        { mode: 0o600 }
      );
      await writeFile(
        join(stateDirectory, "previous-report.json"),
        `${JSON.stringify(previous, null, 2)}\n`,
        { mode: 0o600 }
      );

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const handle = await publishIntegrationReadiness(report("c", 2), {
          stateDirectory,
          leaseContext
        });
        const artifact = integrationReadinessRecoveryArtifact(handle);
        await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
        fault.recoveryUnlinkFailureSuffix = failureSuffix;
        await expect(restoreIntegrationReadinessFromArtifact(artifact, {
          stateDirectory,
          leaseContext
        })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE" });
      });

      await runRecoveryInFreshProcess(stateDirectory, artifactPath);
      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect(await readPreviousReport(stateDirectory)).toEqual(previous);
      expect((await readdir(stateDirectory)).filter((name) =>
        name.includes(".skill-steward")
        || name.startsWith(".integration-readiness.")
      )).toEqual([]);
    }
  );

  it.each(["target-to-discard", "temporary-to-target"] as const)(
    "retries an exact readiness %s hard-link pair after alias unlink and rollback both fail",
    async (transition) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-hard-link-retry-"));
      const stateDirectory = join(root, "state");
      await mkdir(stateDirectory, { mode: 0o700 });
      const latestPath = join(stateDirectory, "latest-report.json");
      const current = report("a");
      await writeFile(latestPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const handle = await publishIntegrationReadiness(report("b", 1), {
          stateDirectory,
          leaseContext
        });
        const artifact = integrationReadinessRecoveryArtifact(handle);
        fault.recoveryUnlinkFailureSequence = transition === "target-to-discard"
          ? [latestPath, ".discard"]
          : [".tmp", latestPath];

        await expect(restoreIntegrationReadinessFromArtifact(artifact, {
          stateDirectory,
          leaseContext
        })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
        expect(fault.recoveryUnlinkFailureSequence).toEqual([]);

        await expect(restoreIntegrationReadinessFromArtifact(artifact, {
          stateDirectory,
          leaseContext
        })).resolves.toBeUndefined();
      });

      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect((await readdir(stateDirectory)).filter((name) =>
        name.includes(".skill-steward")
        || name.startsWith(".integration-readiness.")
      )).toEqual([]);
    }
  );

  it("a fresh process reconciles recovery residue after parent fsync failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-fsync-retry-"));
    const stateDirectory = join(root, "state");
    const artifactPath = join(root, "recovery.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(current, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("b", 1), {
        stateDirectory,
        leaseContext
      });
      const artifact = integrationReadinessRecoveryArtifact(handle);
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      fault.failSyncAfterRecoveryRename = true;
      await expect(restoreIntegrationReadinessFromArtifact(artifact, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
    });

    await runRecoveryInFreshProcess(stateDirectory, artifactPath);
    expect(await readLatestReport(stateDirectory)).toEqual(current);
    expect((await readdir(stateDirectory)).filter((name) =>
      name.includes(".skill-steward")
      || name.startsWith(".integration-readiness.")
    )).toEqual([]);
  });

  it("a fresh process retries after central backup claim rename failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-backup-claim-retry-"));
    const stateDirectory = join(root, "state");
    const artifactPath = join(root, "recovery.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(current, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("b", 1), {
        stateDirectory,
        leaseContext
      });
      const artifact = integrationReadinessRecoveryArtifact(handle);
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      fault.destinationSuffix = ".claim";
      fault.mode = "throw-before";
      await expect(restoreIntegrationReadinessFromArtifact(artifact, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE" });
    });

    await runRecoveryInFreshProcess(stateDirectory, artifactPath);
    expect(await readLatestReport(stateDirectory)).toEqual(current);
    expect((await readdir(stateDirectory)).filter((name) =>
      name.includes(".skill-steward")
      || name.startsWith(".integration-readiness.")
    )).toEqual([]);
  });

  it("publishes readiness without history until transaction finalize", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const next = report("a");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(next, {
        stateDirectory,
        leaseContext
      });
      const backupPath = await findReadinessBackup(stateDirectory);

      expect(await readLatestReport(stateDirectory)).toEqual(next);
      expect(await readReportHistory(stateDirectory)).toEqual([]);
      expect(JSON.parse(await readFile(backupPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        latest: { state: "absent" },
        previous: { state: "absent" }
      });

      const result = await finalizeIntegrationReadiness(proof, {
        stateDirectory,
        leaseContext
      });
      expect(result).toEqual({ status: "finalized", warnings: [] });
      expect(await readReportHistory(stateDirectory)).toEqual([next]);
    });
  });

  it("restores exact latest and previous state after a later failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-restore-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      });
      await restoreIntegrationReadiness(proof, { stateDirectory, leaseContext });

      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect(await readPreviousReport(stateDirectory)).toEqual(prior);
      expect(await readReportHistory(stateDirectory)).toEqual([]);
    });
  });

  it("moves a changed latest report to previous before publishing the next latest", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-order-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    const next = report("c", 2);
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(next, { stateDirectory, leaseContext });
      expect(integrationReadinessTransactionReceipt(proof).previousPublished).toBe(true);
      expect(await readPreviousReport(stateDirectory)).toEqual(current);
      expect(await readLatestReport(stateDirectory)).toEqual(next);
      const reportPublications = fault.publications.filter((path) =>
        path.endsWith("previous-report.json") || path.endsWith("latest-report.json"));
      expect(reportPublications).toEqual([
        join(stateDirectory, "previous-report.json"),
        join(stateDirectory, "latest-report.json")
      ]);
    });
  });

  it("canonicalizes previous and isolates finalize history from caller mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-canonical-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const next = report("b", 1);
    const expectedNext = structuredClone(next);
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      JSON.stringify(current),
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(next, { stateDirectory, leaseContext });
      next.generatedAt = "2030-01-01T00:00:00.000Z";
      expect(await readFile(join(stateDirectory, "previous-report.json"), "utf8"))
        .toBe(`${JSON.stringify(current, null, 2)}\n`);
      await finalizeIntegrationReadiness(handle, { stateDirectory, leaseContext });
    });

    expect(await readReportHistory(stateDirectory)).toEqual([expectedNext]);
  });

  it("keeps previous unchanged when the portfolio fingerprint is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-same-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    const refreshed = { ...current, generatedAt: "2026-07-02T02:00:00.000Z" };
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(refreshed, { stateDirectory, leaseContext });
      expect(integrationReadinessTransactionReceipt(proof).previousPublished).toBe(false);
      expect(await readPreviousReport(stateDirectory)).toEqual(prior);
      expect(await readLatestReport(stateDirectory)).toEqual(refreshed);
    });
  });

  it("backs up two individually valid near-limit reports after base64 expansion", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-base64-bound-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const latest = largeReport("a", 1);
    const previous = largeReport("b", 0);
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(latest, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(stateDirectory, "previous-report.json"),
      `${JSON.stringify(previous, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      });
      expect((await lstat(await findReadinessBackup(stateDirectory))).size).toBeGreaterThan(8 * 1024 * 1024);
      expect(await readIntegrationReadinessBackup(proof, {
        stateDirectory,
        leaseContext
      })).toMatchObject({
        latest: { state: "file" },
        previous: { state: "file" }
      });
    });
  });

  it("backs up three near-limit logical reports including canonical previous", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-four-payload-bound-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "latest-report.json"),
      `${JSON.stringify(largeReport("a", 1), null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(stateDirectory, "previous-report.json"),
      `${JSON.stringify(largeReport("b", 0), null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(largeReport("c", 2), {
        stateDirectory,
        leaseContext
      });
      expect((await lstat(await findReadinessBackup(stateDirectory))).size)
        .toBeGreaterThan(16 * 1024 * 1024);
      expect(await readIntegrationReadinessBackup(handle, {
        stateDirectory,
        leaseContext
      })).toMatchObject({
        intended: {
          latest: { state: "file" },
          previous: { state: "file" }
        }
      });
    });
  });

  it("rejects invalid input and invalid current reports before creating a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-invalid-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness({
        ...report("a"),
        portfolioFingerprint: "sha256:bad"
      } as PortfolioReport, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_READINESS_INVALID"
      });
      expect((await readdir(stateDirectory)).some((name) => name.includes("readiness"))).toBe(false);

      await writeFile(join(stateDirectory, "latest-report.json"), "not-json\n", { mode: 0o600 });
      await expect(publishIntegrationReadiness(report("b"), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_DRIFT" });
      expect((await readdir(stateDirectory)).some((name) => name.includes("readiness"))).toBe(false);
    });
  });

  it("restores previous and removes the backup after a definite latest failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-definite-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });
    fault.destination = join(stateDirectory, "latest-report.json");
    fault.mode = "throw-before";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect(await readPreviousReport(stateDirectory)).toEqual(prior);
      expect((await readdir(stateDirectory)).some((name) => name.includes("readiness"))).toBe(false);
      expect(await readReportHistory(stateDirectory)).toEqual([]);
    });
  });

  it("preserves nested lease uncertainty after definite publication rollback succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-nested-lease-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    fault.destination = join(stateDirectory, "latest-report.json");
    fault.mode = "throw-before";
    fault.cleanupLeaseError = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
      expect((await readdir(stateDirectory)).some((name) =>
        name.startsWith(".integration-readiness."))).toBe(false);
    });
  });

  it("fresh recovery accepts an artifact after deterministic publication cleanup reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-publication-residue-"));
    const stateDirectory = join(root, "state");
    const artifactPath = join(root, "recovery.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    fault.destination = join(stateDirectory, "latest-report.json");
    fault.mode = "throw-before";
    fault.recoveryUnlinkFailureSuffix = ".cleanup.claim";
    fault.cleanupLeaseError = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let failure: unknown;
      try {
        await publishIntegrationReadiness(report("a"), { stateDirectory, leaseContext });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "INTEGRATION_READINESS_UNCERTAIN",
        recoveryArtifact: { schemaVersion: 1 }
      });
      expect(JSON.stringify(failure)).not.toContain(root);
      const artifact = (failure as { recoveryArtifact: unknown }).recoveryArtifact;
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      expect((await readdir(stateDirectory)).some((name) =>
        name.includes("readiness-publish-") && name.endsWith(".cleanup.claim"))).toBe(false);
    });

    await runRecoveryInFreshProcess(stateDirectory, artifactPath);
    expect(await readLatestReport(stateDirectory)).toBeUndefined();
    expect((await readdir(stateDirectory)).filter((name) =>
      name.includes(".skill-steward")
      || name.startsWith(".integration-readiness.")
    )).toEqual([]);
  });

  it("leaves reports untouched when the readiness backup cannot be published", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-backup-failure-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    fault.destinationSuffix = ".backup.json";
    fault.mode = "throw-before";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
      expect(await readLatestReport(stateDirectory)).toBeUndefined();
      expect(await readPreviousReport(stateDirectory)).toBeUndefined();
      expect((await readdir(stateDirectory)).some((name) => name.includes("readiness"))).toBe(false);
    });
  });

  it("restores the readiness backup when previous publication definitely fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-previous-failure-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });
    fault.destination = join(stateDirectory, "previous-report.json");
    fault.mode = "throw-before";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect(await readPreviousReport(stateDirectory)).toEqual(prior);
      expect((await readdir(stateDirectory)).some((name) => name.includes("readiness"))).toBe(false);
    });
  });

  it("preserves recovery evidence when previous publication is uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-previous-uncertain-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    const prior = report("b", 1);
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(stateDirectory, "previous-report.json"), `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });
    fault.destination = join(stateDirectory, "previous-report.json");
    fault.mode = "replace-after";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationReadiness(report("c", 2), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
      expect(await readLatestReport(stateDirectory)).toEqual(current);
      expect((await readdir(stateDirectory)).some((name) =>
        name.startsWith(".integration-readiness."))).toBe(true);
      expect(await readReportHistory(stateDirectory)).toEqual([]);
    });
  });

  it("accepts a latest report proven committed when rename throws after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-after-commit-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    fault.destination = join(stateDirectory, "latest-report.json");
    fault.mode = "throw-after";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      expect(integrationReadinessTransactionReceipt(proof).status).toBe("published");
      expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
    });
  });

  it("preserves a restart-readable backup when latest publication is uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-uncertain-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const current = report("a");
    await writeFile(join(stateDirectory, "latest-report.json"), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    fault.destination = join(stateDirectory, "latest-report.json");
    fault.mode = "replace-after";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let failure: unknown;
      try {
        await publishIntegrationReadiness(report("c", 2), { stateDirectory, leaseContext });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
      const recoveryFailure = failure as {
        recoveryArtifact?: unknown;
        recoveryTransactionId?: string;
      };
      expect(recoveryFailure.recoveryTransactionId).toBeTypeOf("string");
      expect(recoveryFailure.recoveryArtifact).toBeUndefined();
      expect(readinessErrorMessages(failure)).toEqual(expect.arrayContaining([
        "injected readiness replacement after rename",
        "Readiness targets are neither exact pre-state nor intended published state"
      ]));
      await expect(deriveIntegrationReadinessRecoveryArtifact(
        recoveryFailure.recoveryTransactionId!,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE" });
      const names = await readdir(stateDirectory);
      const backup = names.find((name) => name.startsWith(".integration-readiness."));
      expect(backup).toBeDefined();
      expect(JSON.parse(await readFile(join(stateDirectory, backup!), "utf8"))).toMatchObject({
        schemaVersion: 1,
        latest: { state: "file" }
      });
      expect(await readReportHistory(stateDirectory)).toEqual([]);
    });
  });

  it("returns recovery incomplete and preserves a changed readiness backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-backup-drift-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      const backupPath = await findReadinessBackup(stateDirectory);
      await unlink(backupPath);
      await writeFile(backupPath, "external\n", { mode: 0o600 });
      await expect(restoreIntegrationReadiness(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE"
      });
      expect(await readFile(backupPath, "utf8")).toBe("external\n");
    });
  });

  it("returns a committed history warning without rolling back visible readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-warning-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const next = report("a");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(next, { stateDirectory, leaseContext });
      const backupPath = await findReadinessBackup(stateDirectory);
      fault.historyFailure = true;
      const result = await finalizeIntegrationReadiness(proof, { stateDirectory, leaseContext });
      expect(result).toMatchObject({
        status: "committed-warning",
        warnings: [{ code: "INTEGRATION_READINESS_HISTORY_PENDING" }]
      });
      expect(await readLatestReport(stateDirectory)).toEqual(next);
      expect(await readFile(backupPath, "utf8")).toContain('"schemaVersion": 1');
      expect(await readdir(join(stateDirectory, "history"))).toEqual([]);
    });
  });

  it("never follows a symlinked integration history directory after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-symlink-"));
    const stateDirectory = join(root, "state");
    const outside = join(root, "outside");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(stateDirectory, "history"), "dir");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      await expect(finalizeIntegrationReadiness(proof, {
        stateDirectory,
        leaseContext
      })).resolves.toMatchObject({
        status: "committed-warning",
        warnings: [{ code: "INTEGRATION_READINESS_HISTORY_PENDING" }]
      });
    });

    expect(await readdir(outside)).toEqual([]);
    expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
  });

  it("repairs an indexed history entry whose canonical report file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-repair-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const expected = report("a");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(historyDirectory, { mode: 0o700 });
    await writeFile(join(historyDirectory, "index.json"), `${JSON.stringify([{
      portfolioFingerprint: expected.portfolioFingerprint,
      generatedAt: expected.generatedAt,
      fileName: `${"a".repeat(64)}.json`
    }], null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
        stateDirectory,
        leaseContext
      });
    });

    expect(await readReportHistory(stateDirectory)).toEqual([expected]);
  });

  it("repairs a missing indexed report with honest incoming content and updates indexed generatedAt", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-repair-timestamp-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const indexed = report("a");
    const incoming = {
      ...report("a", 1),
      findings: [{
        id: "new-content",
        code: "NEW_CONTENT",
        severity: "info" as const,
        skillIds: [],
        summary: "Reconstruct this content with its honest incoming time",
        evidence: [],
        recommendation: "Update the indexed metadata transactionally",
        confidence: 1
      }]
    };
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(historyDirectory, { mode: 0o700 });
    await writeFile(join(historyDirectory, "index.json"), `${JSON.stringify([{
      portfolioFingerprint: indexed.portfolioFingerprint,
      generatedAt: indexed.generatedAt,
      fileName: `${"a".repeat(64)}.json`
    }], null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await appendIntegrationReportHistoryClaimed(stateDirectory, incoming, {
        stateDirectory,
        leaseContext
      });
    });

    expect(await readReportHistory(stateDirectory)).toEqual([incoming]);
    expect(JSON.parse(await readFile(
      join(historyDirectory, `${"a".repeat(64)}.json`),
      "utf8"
    ))).toEqual(incoming);
  });

  it("deduplicates finalized reports by portfolio fingerprint regardless of generatedAt", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-fingerprint-dedup-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const first = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      await expect(finalizeIntegrationReadiness(first, {
        stateDirectory,
        leaseContext
      })).resolves.toEqual({ status: "finalized", warnings: [] });

      const second = await publishIntegrationReadiness(report("a", 1), {
        stateDirectory,
        leaseContext
      });
      await expect(finalizeIntegrationReadiness(second, {
        stateDirectory,
        leaseContext
      })).resolves.toEqual({ status: "finalized", warnings: [] });
    });

    expect(await readReportHistory(stateDirectory)).toEqual([report("a")]);
    expect((await readdir(join(stateDirectory, "history"))).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name))).toEqual([`${"a".repeat(64)}.json`]);
  });

  it("bounds physical canonical history reports to the retained 50 entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-limit-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      });
    });

    const entries = await readdir(join(stateDirectory, "history"));
    expect(entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(50);
    expect(await readReportHistory(stateDirectory)).toHaveLength(50);
  });

  it("retries a deterministic history GC claim after final unlink failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-retry-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.historyGcUnlinkFailure = true;
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(join(stateDirectory, "history"))).some((name) =>
        name.includes(".history-gc.") && name.endsWith(".claim"))).toBe(true);

      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    const entries = await readdir(join(stateDirectory, "history"));
    expect(entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(50);
    expect(entries.some((name) => name.includes(".history-gc."))).toBe(false);
  });

  it("durably closes a prior committed history GC unlink on an empty retry pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-fsync-retry-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const retained = historyReport(0);
    const orphan = report("b");
    const orphanHash = orphan.portfolioFingerprint.slice("sha256:".length);
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory, 1);
    await writeFile(
      join(historyDirectory, `${orphanHash}.json`),
      `${JSON.stringify(orphan, null, 2)}\n`,
      { mode: 0o600 }
    );

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.failHistoryDirectorySyncAfterGcClaimUnlink = true;
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(historyDirectory)).some((name) => name.includes(orphanHash))).toBe(false);

      const syncsAfterCommittedUnlink = fault.historyDirectorySyncs;
      fault.historyDirectorySyncFailures = 1;
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect(fault.historyDirectorySyncs).toBe(syncsAfterCommittedUnlink + 1);

      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(fault.historyDirectorySyncs).toBe(syncsAfterCommittedUnlink + 2);
    });

    expect(await readdir(historyDirectory)).toEqual([
      `${retained.portfolioFingerprint.slice("sha256:".length)}.json`,
      "index.json"
    ]);
  });

  it.each([
    "tmp",
    "publication.temporary.cleanup.claim",
    "backup",
    "publication.backup.cleanup.claim",
    "finalize.backup.cleanup.claim",
    "restore.backup.cleanup.claim",
    "restore.discard",
    "restore.discard.cleanup.claim",
    "restore.tmp",
    "restore.tmp.cleanup.claim"
  ])("reconciles a strict canonical report transaction %s residue", async (suffix) => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-report-residue-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const retained = historyReport(0);
    const orphan = report("b");
    const orphanHash = orphan.portfolioFingerprint.slice("sha256:".length);
    const residuePath = join(
      historyDirectory,
      `${orphanHash}.json.skill-steward.residue.${suffix}`
    );
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory, 1);
    await writeFile(residuePath, `${JSON.stringify(orphan, null, 2)}\n`, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    expect((await readdir(historyDirectory)).filter((name) =>
      name.includes(".skill-steward."))).toEqual([]);
  });

  it("collapses an exact canonical report and restore-residue hard-link pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-report-pair-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const retained = historyReport(0);
    const orphan = report("b");
    const orphanHash = orphan.portfolioFingerprint.slice("sha256:".length);
    const canonicalPath = join(historyDirectory, `${orphanHash}.json`);
    const residuePath = `${canonicalPath}.skill-steward.residue.restore.discard`;
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory, 1);
    await writeFile(canonicalPath, `${JSON.stringify(orphan, null, 2)}\n`, { mode: 0o600 });
    await link(canonicalPath, residuePath);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    expect((await readdir(historyDirectory)).some((name) => name.includes(orphanHash))).toBe(false);
  });

  it.each(["mismatched", "forged", "link"] as const)(
    "preserves an unsafe canonical report transaction %s residue",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-report-unsafe-"));
      const stateDirectory = join(root, "state");
      const historyDirectory = join(stateDirectory, "history");
      const retained = historyReport(0);
      const orphan = report("b");
      const orphanHash = orphan.portfolioFingerprint.slice("sha256:".length);
      const suffix = kind === "forged" ? "unknown.claim" : "backup";
      const residuePath = join(
        historyDirectory,
        `${orphanHash}.json.skill-steward.residue.${suffix}`
      );
      await mkdir(stateDirectory, { mode: 0o700 });
      await seedIntegrationHistory(stateDirectory, 1);
      if (kind === "link") {
        const outside = join(root, "outside-report.json");
        await writeFile(outside, `${JSON.stringify(orphan, null, 2)}\n`, { mode: 0o600 });
        await symlink(outside, residuePath);
      } else {
        const bytes = kind === "mismatched"
          ? `${JSON.stringify(report("c"), null, 2)}\n`
          : `${JSON.stringify(orphan, null, 2)}\n`;
        await writeFile(residuePath, bytes, { mode: 0o600 });
      }

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, retained, {
          stateDirectory,
          leaseContext
        })).rejects.toBeDefined();
      });

      if (kind === "link") expect((await lstat(residuePath)).isSymbolicLink()).toBe(true);
      else expect(await readFile(residuePath, "utf8")).not.toBe("");
    }
  );

  it("reconciles report compensation residue after definite index publication failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-compensation-residue-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const expected = report("a");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.destination = join(historyDirectory, "index.json");
      fault.mode = "throw-before";
      fault.recoveryUnlinkFailureSuffix = ".restore.discard.cleanup.claim";
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(historyDirectory)).filter((name) =>
        name.startsWith(`${"a".repeat(64)}.json.skill-steward.`))).toHaveLength(1);

      fault.destination = null;
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    const entries = await readdir(historyDirectory);
    expect(entries.filter((name) => name.includes(".skill-steward."))).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(await readReportHistory(stateDirectory)).toEqual([expected]);
  });

  it("retries a deterministic history GC hard-link pair after both alias unlinks fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-pair-retry-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const evictedHash = historyReport(0).portfolioFingerprint.slice("sha256:".length);
    const evictedPath = join(stateDirectory, "history", `${evictedHash}.json`);
    await seedIntegrationHistory(stateDirectory);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.recoveryUnlinkFailureSequence = [
        evictedPath,
        `.history-gc.${evictedHash}.claim`
      ];
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      const claimPath = join(stateDirectory, "history", `.history-gc.${evictedHash}.claim`);
      expect((await lstat(evictedPath)).ino).toBe((await lstat(claimPath)).ino);

      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
    });

    const entries = await readdir(join(stateDirectory, "history"));
    expect(entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(50);
    expect(entries.some((name) => name.includes(".history-gc."))).toBe(false);
  });

  it("preserves a forged mismatched history GC hard-link pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-forged-pair-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const evictedHash = historyReport(0).portfolioFingerprint.slice("sha256:".length);
    const evictedPath = join(stateDirectory, "history", `${evictedHash}.json`);
    const claimPath = join(stateDirectory, "history", `.history-gc.${evictedHash}.claim`);
    await seedIntegrationHistory(stateDirectory);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.recoveryUnlinkFailureSequence = [evictedPath, claimPath];
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      await unlink(evictedPath);
      await unlink(claimPath);
      await writeFile(evictedPath, "forged history pair\n", { mode: 0o600 });
      await link(evictedPath, claimPath);

      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
    });

    expect(await readFile(evictedPath, "utf8")).toBe("forged history pair\n");
    expect((await lstat(evictedPath)).nlink).toBe(2);
    expect((await lstat(claimPath)).nlink).toBe(2);
  });

  it("preserves a history report replacement introduced before exact quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-replacement-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const evictedPath = join(
      stateDirectory,
      "history",
      `${historyReport(0).portfolioFingerprint.slice("sha256:".length)}.json`
    );
    await seedIntegrationHistory(stateDirectory);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      fault.replaceHistoryGcSourceBeforeLink = true;
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(50), {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
    });

    expect(await readFile(evictedPath, "utf8")).toBe("external history replacement\n");
  });

  it.each(["unknown", "malformed", "link"] as const)(
    "returns a history warning and preserves an unindexed %s artifact",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-unsafe-"));
      const stateDirectory = join(root, "state");
      const historyDirectory = join(stateDirectory, "history");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(historyDirectory, { mode: 0o700 });
      const artifactPath = kind === "unknown"
        ? join(historyDirectory, "unknown.json")
        : join(historyDirectory, `${"b".repeat(64)}.json`);
      if (kind === "link") {
        const outside = join(root, "outside.json");
        await writeFile(outside, `${JSON.stringify(report("b"), null, 2)}\n`, { mode: 0o600 });
        await symlink(outside, artifactPath);
      } else {
        await writeFile(artifactPath, "external history artifact\n", { mode: 0o600 });
      }

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const handle = await publishIntegrationReadiness(report("a"), {
          stateDirectory,
          leaseContext
        });
        await expect(finalizeIntegrationReadiness(handle, {
          stateDirectory,
          leaseContext
        })).resolves.toMatchObject({
          status: "committed-warning",
          warnings: [{ code: "INTEGRATION_READINESS_HISTORY_PENDING" }]
        });
        expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");
      });

      if (kind === "link") expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);
      else expect(await readFile(artifactPath, "utf8")).toBe("external history artifact\n");
    }
  );

  it("fails closed when the history directory exceeds its enumeration bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-gc-bound-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(historyDirectory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(join(historyDirectory, `noise-${index}`), "noise\n", { mode: 0o600 })));

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, historyReport(0), {
        stateDirectory,
        leaseContext
      })).rejects.toThrow(/entry limit/i);
    });

    expect((await readdir(historyDirectory)).filter((name) => name.startsWith("noise-")))
      .toHaveLength(257);
  });

  it("rejects an indexed history entry whose canonical fileName metadata drifts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-metadata-"));
      const stateDirectory = join(root, "state");
      const historyDirectory = join(stateDirectory, "history");
      const expected = report("a");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(historyDirectory, { mode: 0o700 });
      const entry = {
        portfolioFingerprint: expected.portfolioFingerprint,
        generatedAt: expected.generatedAt,
        fileName: `${"b".repeat(64)}.json`
      };
      const indexPath = join(historyDirectory, "index.json");
      const indexBytes = `${JSON.stringify([entry], null, 2)}\n`;
      await writeFile(indexPath, indexBytes, { mode: 0o600 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow("file name is not canonical");
      });

      expect(await readFile(indexPath, "utf8")).toBe(indexBytes);
      expect(await readdir(historyDirectory)).toEqual(["index.json"]);
    });

  it("rejects duplicate canonical history fingerprints before publishing report bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-duplicate-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    const expected = report("a");
    const entry = {
      portfolioFingerprint: expected.portfolioFingerprint,
      generatedAt: expected.generatedAt,
      fileName: `${"a".repeat(64)}.json`
    };
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(historyDirectory, { mode: 0o700 });
    const indexPath = join(historyDirectory, "index.json");
    const indexBytes = `${JSON.stringify([entry, entry], null, 2)}\n`;
    await writeFile(indexPath, indexBytes, { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
        stateDirectory,
        leaseContext
      })).rejects.toThrow("entries must be unique");
    });

    expect(await readFile(indexPath, "utf8")).toBe(indexBytes);
    expect(await readdir(historyDirectory)).toEqual(["index.json"]);
  });

  it.each(["not-committed", "committed"] as const)(
    "preserves the exact history report and converges after uncertain index %s publication",
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-retry-"));
      const stateDirectory = join(root, "state");
      const expected = report("a");
      await mkdir(stateDirectory, { mode: 0o700 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        if (outcome === "not-committed") {
          fault.destination = join(stateDirectory, "history", "index.json");
          fault.mode = "throw-before";
          fault.cleanupLeaseError = true;
        } else {
          fault.failHistoryIndexParentSync = true;
        }
        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
          stateDirectory,
          leaseContext
        })).rejects.toBeDefined();
        fault.destination = null;
        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, expected, {
          stateDirectory,
          leaseContext
        })).resolves.toBeUndefined();
      });

      expect(await readReportHistory(stateDirectory)).toEqual([expected]);
      expect((await readdir(join(stateDirectory, "history"))).filter((name) =>
        name.startsWith("index.json.skill-steward."))).toEqual([]);
    }
  );

  it("reconciles generic index backup residue after repeated post-rename fsync uncertainty", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-index-residue-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await appendIntegrationReportHistoryClaimed(stateDirectory, report("a"), {
        stateDirectory,
        leaseContext
      });
      for (const next of [report("b", 1), report("c", 2)]) {
        fault.historyIndexCommitted = false;
        fault.failHistoryIndexParentSync = true;
        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, next, {
          stateDirectory,
          leaseContext
        })).rejects.toBeDefined();
        const residues = (await readdir(historyDirectory)).filter((name) =>
          name.startsWith("index.json.skill-steward.")
          && (name.endsWith(".backup") || name.endsWith(".claim")));
        expect(residues).toHaveLength(1);

        await expect(appendIntegrationReportHistoryClaimed(stateDirectory, next, {
          stateDirectory,
          leaseContext
        })).resolves.toBeUndefined();
        expect((await readdir(historyDirectory)).filter((name) =>
          name.startsWith("index.json.skill-steward."))).toEqual([]);
      }
    });

    expect(await readReportHistory(stateDirectory)).toEqual([
      report("c", 2),
      report("b", 1),
      report("a")
    ]);
  });

  it.each(["unknown", "malformed", "link"] as const)(
    "warns and preserves an unsafe generic index %s residue",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-index-unsafe-"));
      const stateDirectory = join(root, "state");
      const historyDirectory = join(stateDirectory, "history");
      await mkdir(stateDirectory, { mode: 0o700 });
      await seedIntegrationHistory(stateDirectory, 1);
      const residuePath = kind === "unknown"
        ? join(historyDirectory, "index.json.skill-steward.forged.unknown.claim")
        : join(historyDirectory, "index.json.skill-steward.forged.backup");
      if (kind === "link") {
        const outside = join(root, "outside-index.json");
        await writeFile(outside, await readFile(join(historyDirectory, "index.json")), { mode: 0o600 });
        await symlink(outside, residuePath);
      } else {
        await writeFile(residuePath, "unsafe index residue\n", { mode: 0o600 });
      }

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const handle = await publishIntegrationReadiness(report("a"), {
          stateDirectory,
          leaseContext
        });
        await expect(finalizeIntegrationReadiness(handle, {
          stateDirectory,
          leaseContext
        })).resolves.toMatchObject({ status: "committed-warning" });
        expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");
      });

      if (kind === "link") expect((await lstat(residuePath)).isSymbolicLink()).toBe(true);
      else expect(await readFile(residuePath, "utf8")).toBe("unsafe index residue\n");
    }
  );

  it("warns and preserves a generic index residue replaced before quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-index-replacement-"));
    const stateDirectory = join(root, "state");
    const historyDirectory = join(stateDirectory, "history");
    await mkdir(stateDirectory, { mode: 0o700 });
    await seedIntegrationHistory(stateDirectory, 1);
    const residuePath = join(historyDirectory, "index.json.skill-steward.replaced.backup");
    await writeFile(residuePath, await readFile(join(historyDirectory, "index.json")), { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      fault.replaceHistoryIndexResidueBeforeLink = true;
      await expect(finalizeIntegrationReadiness(handle, {
        stateDirectory,
        leaseContext
      })).resolves.toMatchObject({ status: "committed-warning" });
      expect(integrationReadinessTransactionReceipt(handle).status).toBe("committed");
    });

    expect(await readFile(residuePath, "utf8")).toBe("external index residue replacement\n");
  });

  it.each(["EIO", "INTEGRATION_LEASE_LOST"] as const)(
    "returns a committed warning for mid-history %s failure",
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-boundary-"));
      const stateDirectory = join(root, "state");
      await mkdir(stateDirectory, { mode: 0o700 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const proof = await publishIntegrationReadiness(report("a"), {
          stateDirectory,
          leaseContext
        });
        fault.historySyncFailureCode = code;
        await expect(finalizeIntegrationReadiness(proof, {
          stateDirectory,
          leaseContext
        })).resolves.toMatchObject({
          status: "committed-warning",
          warnings: [{
            code: code === "INTEGRATION_LEASE_LOST"
              ? "INTEGRATION_READINESS_FINALIZE_UNCERTAIN"
              : "INTEGRATION_READINESS_HISTORY_PENDING"
          }]
        });
      });

      expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
      expect(await readReportHistory(stateDirectory)).toEqual([]);
    }
  );

  it.each(["index", "report"] as const)(
    "preserves drifted integration history %s bytes after commit",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "steward-readiness-history-drift-"));
      const stateDirectory = join(root, "state");
      const historyDirectory = join(stateDirectory, "history");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(historyDirectory, { mode: 0o700 });
      const path = kind === "index"
        ? join(historyDirectory, "index.json")
        : join(historyDirectory, `${"a".repeat(64)}.json`);
      await writeFile(path, "external\n", { mode: 0o600 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const proof = await publishIntegrationReadiness(report("a"), {
          stateDirectory,
          leaseContext
        });
        await expect(finalizeIntegrationReadiness(proof, {
          stateDirectory,
          leaseContext
        })).resolves.toMatchObject({
          status: "committed-warning",
          warnings: [{ code: "INTEGRATION_READINESS_HISTORY_PENDING" }]
        });
      });

      expect(await readFile(path, "utf8")).toBe("external\n");
    }
  );

  it("returns a post-commit state-drift warning without history or cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-cleanup-warning-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const next = report("a");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(next, { stateDirectory, leaseContext });
      const backupPath = await findReadinessBackup(stateDirectory);
      await unlink(backupPath);
      await writeFile(backupPath, "external\n", { mode: 0o600 });
      await expect(finalizeIntegrationReadiness(proof, {
        stateDirectory,
        leaseContext
      })).resolves.toMatchObject({
        status: "committed-warning",
        warnings: [{ code: "INTEGRATION_READINESS_STATE_DRIFT" }]
      });
      expect(await readReportHistory(stateDirectory)).toEqual([]);
      expect(await readFile(backupPath, "utf8")).toBe("external\n");
    });
  });

  it("reads the strict backup through its transaction proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-proof-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      expect(await readIntegrationReadinessBackup(proof, { stateDirectory, leaseContext })).toMatchObject({
        schemaVersion: 1,
        transactionId: integrationReadinessTransactionReceipt(proof).transactionId,
        latest: { state: "absent" },
        previous: { state: "absent" }
      });
    });
  });

  it("rejects a same-byte symlink replacement at the readiness backup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-proof-link-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationReadiness(report("a"), {
        stateDirectory,
        leaseContext
      });
      const backupPath = await findReadinessBackup(stateDirectory);
      const external = join(root, "same-bytes.json");
      await writeFile(external, await readFile(backupPath), { mode: 0o600 });
      await unlink(backupPath);
      await symlink(external, backupPath);

      await expect(readIntegrationReadinessBackup(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_READINESS_RECOVERY_INCOMPLETE"
      });
    });
  });

  it("maps lease loss at restore to readiness uncertainty without touching reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-lease-loss-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    let proof!: Awaited<ReturnType<typeof publishIntegrationReadiness>>;
    let expired!: Parameters<typeof restoreIntegrationReadiness>[1]["leaseContext"];
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      expired = leaseContext;
      proof = await publishIntegrationReadiness(report("a"), { stateDirectory, leaseContext });
    });

    await expect(restoreIntegrationReadiness(proof, {
      stateDirectory,
      leaseContext: expired
    })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
    expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
  });

  it("maps lease loss while reading the recovery backup to readiness uncertainty", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-read-lease-loss-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    let proof!: Awaited<ReturnType<typeof publishIntegrationReadiness>>;
    let expired!: Parameters<typeof readIntegrationReadinessBackup>[1]["leaseContext"];
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      expired = leaseContext;
      proof = await publishIntegrationReadiness(report("a"), { stateDirectory, leaseContext });
    });

    await expect(readIntegrationReadinessBackup(proof, {
      stateDirectory,
      leaseContext: expired
    })).rejects.toMatchObject({ code: "INTEGRATION_READINESS_UNCERTAIN" });
  });

  it("never appends history when finalize receives an expired lease context", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-readiness-finalize-lease-loss-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    let proof!: Awaited<ReturnType<typeof publishIntegrationReadiness>>;
    let expired!: Parameters<typeof finalizeIntegrationReadiness>[1]["leaseContext"];
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      expired = leaseContext;
      proof = await publishIntegrationReadiness(report("a"), { stateDirectory, leaseContext });
    });

    await expect(finalizeIntegrationReadiness(proof, {
      stateDirectory,
      leaseContext: expired
    })).resolves.toMatchObject({
      status: "committed-warning",
      warnings: [{ code: "INTEGRATION_READINESS_FINALIZE_UNCERTAIN" }]
    });
    expect(await readReportHistory(stateDirectory)).toEqual([]);
    expect(await readLatestReport(stateDirectory)).toEqual(report("a"));
  });
});
