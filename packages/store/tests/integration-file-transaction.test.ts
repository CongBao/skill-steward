import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendIntegrationRecord,
  appendIntegrationRecoveryTransition,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent,
  fingerprintIntegrationFileBytes,
  finalizeIntegrationFileTransaction,
  integrationFileTransactionReceipt,
  publishIntegrationFileTransaction,
  restoreIntegrationFileTransaction,
  withIntegrationMutationLease,
  type IntegrationFileContentState,
  type IntegrationRecordV2
} from "../src/index.js";
import { integrationFileRecoveryArtifactSchema } from "../src/integration-file-recovery-artifact.js";

const fault = vi.hoisted(() => ({
  destination: null as string | null,
  destinationSuffix: null as string | null,
  mode: null as
    | "throw-before"
    | "throw-after"
    | "replace-after"
    | "source-disappears"
    | "same-inode-alias"
    | "parent-swap"
    | "swap-source-before"
    | "insert-destination-before-link"
    | null,
  syncEvents: [] as string[],
  renameEvents: [] as string[],
  blockFirstRename: false,
  blocked: null as null | (() => void),
  release: null as null | (() => void),
  activeRenames: 0,
  maxActiveRenames: 0,
  renameCount: 0,
  syncFailureSuffix: null as string | null,
  syncFailureExact: null as string | null,
  syncFailureOccurrence: 1,
  matchingSyncs: 0,
  cleanupUnlinkFailure: false,
  unlinkFailureSequence: [] as string[],
  replaceOwnedAfterCloseSuffix: null as string | null,
  injectTargetAfterOwnedClose: null as string | null,
  replaceBackupAfterTempClose: false,
  readFailureExact: null as string | null,
  closeFailureAfterIoExact: null as string | null,
  failedIoPaths: new Set<string>()
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
              fault.syncEvents.push(path);
              const matchesFailure = path === fault.syncFailureExact
                || fault.syncFailureSuffix !== null
                  && path.includes(".skill-steward.")
                  && path.endsWith(fault.syncFailureSuffix);
              if (matchesFailure) fault.matchingSyncs += 1;
              if (matchesFailure && fault.matchingSyncs === fault.syncFailureOccurrence) {
                fault.failedIoPaths.add(path);
                fault.syncFailureExact = null;
                fault.syncFailureSuffix = null;
                throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
              }
              return target.sync();
            };
          }
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              if (path === fault.readFailureExact) {
                fault.readFailureExact = null;
                fault.failedIoPaths.add(path);
                throw Object.assign(new Error("injected read failure"), { code: "EIO" });
              }
              return (target.read as (...args: unknown[]) => unknown).call(target, ...readArgs);
            };
          }
          if (property === "close") {
            return async () => {
              await target.close();
              if (
                path === fault.closeFailureAfterIoExact
                && fault.failedIoPaths.has(path)
              ) {
                fault.closeFailureAfterIoExact = null;
                throw Object.assign(new Error("injected close failure"), { code: "EIO" });
              }
              if (
                fault.replaceOwnedAfterCloseSuffix !== null
                && path.includes(".skill-steward.")
                && path.endsWith(fault.replaceOwnedAfterCloseSuffix)
              ) {
                const bytes = await original.readFile(path);
                const mode = Number((await original.lstat(path)).mode & 0o777);
                fault.replaceOwnedAfterCloseSuffix = null;
                await original.unlink(path);
                await original.writeFile(path, bytes, { mode });
              }
              if (
                fault.injectTargetAfterOwnedClose !== null
                && path.includes(".skill-steward.")
                && path.endsWith(".tmp")
              ) {
                const targetPath = fault.injectTargetAfterOwnedClose;
                fault.injectTargetAfterOwnedClose = null;
                await original.writeFile(targetPath, "external\n", {
                  flag: "wx",
                  mode: 0o600
                });
              }
              if (
                fault.replaceBackupAfterTempClose
                && path.includes(".skill-steward.")
                && path.endsWith(".tmp")
              ) {
                fault.replaceBackupAfterTempClose = false;
                const parent = dirname(path);
                const backupName = (await original.readdir(parent)).find((name) =>
                  name.endsWith(".backup"));
                if (backupName) {
                  const backupPath = join(parent, backupName);
                  const bytes = await original.readFile(backupPath);
                  await original.unlink(backupPath);
                  await original.writeFile(backupPath, bytes, { mode: 0o600 });
                }
              }
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
        destination === fault.destination
        || fault.destinationSuffix !== null && destination.endsWith(fault.destinationSuffix)
      ) {
        const mode = fault.mode;
        fault.mode = null;
        if (mode === "throw-before") {
          throw Object.assign(new Error("injected link before commit"), { code: "EIO" });
        }
        if (mode === "swap-source-before") {
          await original.unlink(source);
          await original.writeFile(source, "external cleanup replacement\n", { mode: 0o600 });
        }
        if (mode === "insert-destination-before-link") {
          await original.writeFile(destination, "external immediate replacement\n", {
            flag: "wx",
            mode: 0o600
          });
        }
        const result = await original.link(...args);
        if (mode === "throw-after") throw new Error("injected link after commit");
        if (mode === "replace-after") {
          await original.unlink(destination);
          await original.writeFile(destination, "replacement\n", { mode: 0o600 });
          throw new Error("injected destination replacement after link");
        }
        return result;
      }
      return original.link(...args);
    },
    async rename(...args: Parameters<typeof original.rename>) {
      const source = String(args[0]);
      const destination = String(args[1]);
      fault.renameEvents.push(`${source}->${destination}`);
      if (
        destination === fault.destination
        || fault.destinationSuffix !== null && destination.endsWith(fault.destinationSuffix)
      ) {
        fault.renameCount += 1;
        fault.activeRenames += 1;
        fault.maxActiveRenames = Math.max(fault.maxActiveRenames, fault.activeRenames);
        try {
          if (fault.blockFirstRename && fault.renameCount === 1) {
            await new Promise<void>((resolve) => { fault.blocked = resolve; });
            await new Promise<void>((resolve) => { fault.release = resolve; });
          }
          const mode = fault.mode;
          fault.mode = null;
          if (mode === "throw-before") {
            throw Object.assign(new Error("injected rename before commit"), { code: "EIO" });
          }
          if (mode === "source-disappears") {
            await original.unlink(source);
            throw new Error("injected source disappearance");
          }
          if (mode === "swap-source-before") {
            await original.unlink(source);
            await original.writeFile(source, "external cleanup replacement\n", { mode: 0o600 });
          }
          const result = await original.rename(...args);
          if (mode === "throw-after") throw new Error("injected rename after commit");
          if (mode === "replace-after") {
            await original.unlink(destination);
            await original.writeFile(destination, "replacement\n", { mode: 0o600 });
            throw new Error("injected destination replacement");
          }
          if (mode === "same-inode-alias") {
            await original.link(destination, source);
            throw new Error("injected same-inode alias");
          }
          if (mode === "parent-swap") {
            const parent = dirname(destination);
            await original.rename(parent, `${parent}.swapped`);
            await original.mkdir(parent, { mode: 0o700 });
            throw new Error("injected parent replacement");
          }
          return result;
        } finally {
          fault.activeRenames -= 1;
        }
      }
      return original.rename(...args);
    },
    async unlink(...args: Parameters<typeof original.unlink>) {
      const path = String(args[0]);
      const nextFailure = fault.unlinkFailureSequence[0];
      if (
        nextFailure !== undefined
        && (path === nextFailure || path.endsWith(nextFailure))
      ) {
        fault.unlinkFailureSequence.shift();
        throw Object.assign(new Error("injected recovery alias unlink failure"), { code: "EIO" });
      }
      if (
        fault.cleanupUnlinkFailure
        && path.includes(".skill-steward.")
        && (path.endsWith(".tmp") || path.endsWith(".claim"))
      ) {
        fault.cleanupUnlinkFailure = false;
        throw Object.assign(new Error("injected cleanup unlink failure"), { code: "EACCES" });
      }
      return original.unlink(...args);
    }
  };
});

afterEach(() => {
  fault.destination = null;
  fault.destinationSuffix = null;
  fault.mode = null;
  fault.syncEvents = [];
  fault.renameEvents = [];
  fault.blockFirstRename = false;
  fault.blocked = null;
  fault.release = null;
  fault.activeRenames = 0;
  fault.maxActiveRenames = 0;
  fault.renameCount = 0;
  fault.syncFailureSuffix = null;
  fault.syncFailureExact = null;
  fault.syncFailureOccurrence = 1;
  fault.matchingSyncs = 0;
  fault.cleanupUnlinkFailure = false;
  fault.unlinkFailureSequence = [];
  fault.replaceOwnedAfterCloseSuffix = null;
  fault.injectTargetAfterOwnedClose = null;
  fault.replaceBackupAfterTempClose = false;
  fault.readFailureExact = null;
  fault.closeFailureAfterIoExact = null;
  fault.failedIoPaths.clear();
});

const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");

function file(value: string, mode = 0o600): IntegrationFileContentState {
  const content = bytes(value);
  return {
    state: "file",
    bytes: content,
    fingerprint: fingerprintIntegrationFileBytes(content),
    mode
  };
}

function boundLifecycleRecord(
  root: string,
  targetPath: string,
  overrides: Partial<IntegrationRecordV2> = {}
): IntegrationRecordV2 {
  const companionFingerprint = fingerprintIntegrationFileBytes(Buffer.from("same\n", "utf8"));
  const createdAt = "2026-07-05T00:00:00.000Z";
  return {
    schemaVersion: 2,
    id: "bound-lifecycle-record",
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath,
    beforeFingerprint: file("before\n", 0o640).fingerprint,
    afterFingerprint: file("after\n").fingerprint,
    installedEntryFingerprint: file("after\n").fingerprint,
    companion: {
      action: "none",
      path: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
      before: { state: "exact", fingerprint: companionFingerprint },
      after: { state: "exact", fingerprint: companionFingerprint },
      source: { fingerprint: companionFingerprint },
      proof: { category: "recorded" },
      installedFingerprint: companionFingerprint,
      consumers: ["codex"]
    },
    trigger: {
      planId: "bound-file-finalize-plan",
      harness: "codex",
      createdAt
    },
    createdAt,
    ...overrides
  };
}

async function findOwnedBackup(boundary: string): Promise<string> {
  const name = (await readdir(boundary)).find((entry) =>
    entry.includes(".skill-steward.") && entry.endsWith(".backup"));
  if (!name) throw new Error("Expected an owned backup");
  return join(boundary, name);
}

async function prepareBoundFileFinalize(
  records: (expected: IntegrationRecordV2) => IntegrationRecordV2[],
  recoveryState: "mutating" | "committed" = "committed"
): Promise<{
  root: string;
  stateDirectory: string;
  boundary: string;
  targetPath: string;
  transactionId: string;
  expected: IntegrationRecordV2;
}> {
  const root = await mkdtemp(join(tmpdir(), "steward-bound-file-finalize-"));
  const stateDirectory = join(root, "state");
  const boundary = join(root, "home");
  const targetPath = join(boundary, "config.json");
  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  const expected = boundLifecycleRecord(root, targetPath);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(boundary, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, "before\n", { mode: 0o640 });
  await chmod(targetPath, 0o640);
  const stateIdentity = await lstat(stateDirectory, { bigint: true });

  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    let recovery = await createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId: expected.trigger.planId,
      harness: expected.harness,
      action: "none",
      companionPath: expected.companion.path,
      configPath: targetPath,
      beforeFingerprint: expected.companion.before.state === "exact"
        ? expected.companion.before.fingerprint
        : null,
      afterFingerprint: expected.companion.after.state === "exact"
        ? expected.companion.after.fingerprint
        : null,
      createdAt: expected.createdAt,
      lifecycleRecordBinding: bindIntegrationRecordV2(expected),
      artifactHints: []
    }, { leaseContext });
    await publishIntegrationFileTransaction({
      targetPath,
      allowedBoundaryPath: boundary,
      expectedBefore: file("before\n", 0o640),
      after: file("after\n"),
      recovery: {
        transactionId,
        beforePublish: async (artifact) => {
          recovery = await appendIntegrationRecoveryTransition(stateDirectory, {
            transactionId,
            expectedSequence: recovery.sequence,
            expectedState: recovery.state,
            state: "mutating",
            transitionedAt: "2026-07-05T00:00:01.000Z",
            configurationArtifactAddition: artifact,
            readinessArtifactAddition: {
              schemaVersion: 1,
              recoveryTransactionId: transactionId,
              readinessTransactionId: expected.id,
              stateDirectory,
              stateDirectoryIdentity: {
                device: stateIdentity.dev.toString(),
                inode: stateIdentity.ino.toString()
              },
              reportFingerprint: `sha256:${"f".repeat(64)}`,
              trigger: expected.trigger,
              backup: {
                fingerprint: `sha256:${"e".repeat(64)}`,
                identity: { device: "1", inode: "1" }
              },
              latest: { observed: { state: "absent" } },
              previous: { observed: { state: "absent" } }
            }
          }, { leaseContext });
        }
      }
    }, { stateDirectory, leaseContext });
    if (recoveryState === "committed") {
      recovery = await appendIntegrationRecoveryTransition(stateDirectory, {
        transactionId,
        expectedSequence: recovery.sequence,
        expectedState: recovery.state,
        state: "committed",
        transitionedAt: "2026-07-05T00:00:02.000Z"
      }, { leaseContext });
    }
    for (const record of records(expected)) await appendIntegrationRecord(stateDirectory, record);
  });

  return { root, stateDirectory, boundary, targetPath, transactionId, expected };
}

function errorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((item) => errorMessages(item, seen))];
  }
  if (error instanceof Error) {
    return [error.message, ...errorMessages(error.cause, seen)];
  }
  return [];
}

describe("integration file transaction", () => {
  it("returns a frozen opaque authority handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-opaque-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath: join(boundary, "config.json"),
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.keys(handle)).toEqual([]);
      expect(() => {
        (handle as unknown as Record<string, unknown>).targetPath = "/forged";
      }).toThrow();
    });
  });

  it("rejects forged, cloned, receipt, and cross-state authorities before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-forged-"));
    const stateDirectory = join(root, "state");
    const otherState = join(root, "other-state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(otherState, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const receipt = integrationFileTransactionReceipt(handle);
      for (const forged of [{}, JSON.parse(JSON.stringify(handle)), receipt]) {
        await expect(restoreIntegrationFileTransaction(forged as never, {
          stateDirectory,
          leaseContext
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
        expect(await readFile(targetPath, "utf8")).toBe("after\n");
      }
    });

    await withIntegrationMutationLease(otherState, async (leaseContext) => {
      const namesBefore = await readdir(boundary);
      const authentic = await withIntegrationMutationLease(stateDirectory, async (stateLease) =>
        publishIntegrationFileTransaction({
          targetPath: join(boundary, "other.json"),
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("owned\n")
        }, { stateDirectory, leaseContext: stateLease }));
      await expect(restoreIntegrationFileTransaction(authentic, {
        stateDirectory: otherState,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      expect(await readFile(join(boundary, "other.json"), "utf8")).toBe("owned\n");
      await expect(finalizeIntegrationFileTransaction(authentic, {
        stateDirectory: otherState,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      expect((await readdir(boundary)).sort()).toEqual([...namesBefore, "other.json"].sort());
    });
  });

  it("publishes an absent target with a durable exact receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-transaction-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await Promise.all([
      import("node:fs/promises").then(({ mkdir }) => mkdir(stateDirectory, { mode: 0o700 })),
      import("node:fs/promises").then(({ mkdir }) => mkdir(boundary, { mode: 0o700 }))
    ]);
    const targetPath = join(boundary, "config.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });

      expect(integrationFileTransactionReceipt(proof)).toMatchObject({
        status: "published",
        beforeFingerprint: null,
        afterFingerprint: fingerprintIntegrationFileBytes(bytes("after\n"))
      });
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
      expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(0o600);

      await finalizeIntegrationFileTransaction(proof, { stateDirectory, leaseContext });
    });
  });

  it.each([
    ["absent", undefined],
    ["0644 file", 0o644],
    ["0640 file", 0o640]
  ] as const)(
    "checkpoints a frozen compact %s recovery binding before canonical publication",
    async (_label, beforeMode) => {
      const root = await mkdtemp(join(tmpdir(), "steward-file-recovery-checkpoint-"));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      const targetPath = join(boundary, "config.json");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(boundary, { recursive: true, mode: 0o700 });
      if (beforeMode !== undefined) {
        await writeFile(targetPath, "before\n", { mode: beforeMode });
        await chmod(targetPath, beforeMode);
      }
      let checkpoint: unknown;

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: beforeMode === undefined
            ? { state: "absent" }
            : file("before\n", beforeMode),
          after: file("after\n"),
          recovery: {
            transactionId: "123e4567-e89b-42d3-a456-426614174000",
            beforePublish: async (artifact: unknown) => {
              checkpoint = artifact;
              expect(Object.isFrozen(artifact)).toBe(true);
              if (beforeMode !== undefined) {
                expect(await readFile(targetPath, "utf8")).toBe("before\n");
              } else {
                await expect(readFile(targetPath, "utf8"))
                  .rejects.toMatchObject({ code: "ENOENT" });
              }
              expect((await readdir(boundary)).some((name) => name.endsWith(".tmp")))
                .toBe(true);
              expect((await readdir(boundary)).some((name) => name.endsWith(".backup")))
                .toBe(beforeMode !== undefined);
              if (beforeMode !== undefined) {
                expect(Number((await lstat((artifact as { backup: { path: string } }).backup.path))
                  .mode & 0o777)).toBe(0o600);
              }
            }
          }
        } as Parameters<typeof publishIntegrationFileTransaction>[0] & {
          recovery: {
            transactionId: string;
            beforePublish(artifact: unknown): Promise<void>;
          };
        }, { stateDirectory, leaseContext });
      });

      expect(checkpoint).toMatchObject({
        schemaVersion: 1,
        recoveryTransactionId: "123e4567-e89b-42d3-a456-426614174000",
        stateDirectory,
        targetPath,
        allowedBoundaryPath: boundary,
        before: {
          state: beforeMode === undefined ? "absent" : "file",
          ...(beforeMode === undefined ? {} : { mode: beforeMode })
        },
        after: { fingerprint: file("after\n").fingerprint },
        temporary: { path: expect.stringMatching(/\.tmp$/) }
      });
      expect(JSON.stringify(checkpoint).length).toBeLessThan(96 * 1024);
      if (beforeMode !== undefined) {
        const mismatched = structuredClone(checkpoint) as {
          before: { mode: number };
          backup: { mode: number };
        };
        expect(mismatched.backup.mode).toBe(0o600);
        mismatched.backup.mode = 0o640;
        expect(integrationFileRecoveryArtifactSchema.safeParse(mismatched).success).toBe(false);
      }
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
    }
  );

  it.each([
    ["absent", undefined],
    ["0644 file", 0o644],
    ["0640 file", 0o640]
  ] as const)(
    "restores %s configuration from a fresh Store-issued one-shot authority",
    async (beforeLabel, beforeMode) => {
      const api = await import("../src/index.js") as typeof import("../src/index.js") & {
        loadIntegrationFileRecoveryAuthority: Function;
        restoreIntegrationFileFromRecovery: Function;
      };
      expect(typeof api.loadIntegrationFileRecoveryAuthority).toBe("function");
      expect(typeof api.restoreIntegrationFileFromRecovery).toBe("function");

      const root = await mkdtemp(join(tmpdir(), "steward-file-recovery-authority-"));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      const targetPath = join(boundary, "config.json");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(boundary, { recursive: true, mode: 0o700 });
      if (beforeMode !== undefined) {
        await writeFile(targetPath, "before\n", { mode: beforeMode });
        await chmod(targetPath, beforeMode);
      }
      const transactionId = "123e4567-e89b-42d3-a456-426614174000";
      const planId = `file-recovery-${beforeLabel.replaceAll(" ", "-")}`;
      const lifecycleRecord = boundLifecycleRecord(root, targetPath, {
        trigger: {
          planId,
          harness: "codex",
          createdAt: "2026-07-05T00:00:00.000Z"
        }
      });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        let recovery = await api.createIntegrationRecoveryIntent(stateDirectory, {
          schemaVersion: 1,
          transactionId,
          planId,
          harness: "codex",
          action: "none",
          companionPath: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
          configPath: targetPath,
          beforeFingerprint: file("same\n").fingerprint,
          afterFingerprint: file("same\n").fingerprint,
          createdAt: "2026-07-05T00:00:00.000Z",
          lifecycleRecordBinding: bindIntegrationRecordV2(lifecycleRecord),
          artifactHints: []
        }, { leaseContext });
        await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: beforeMode === undefined
            ? { state: "absent" }
            : file("before\n", beforeMode),
          after: file("after\n"),
          recovery: {
            transactionId,
            beforePublish: async (artifact) => {
              recovery = await api.appendIntegrationRecoveryTransition(stateDirectory, {
                transactionId,
                expectedSequence: recovery.sequence,
                expectedState: recovery.state,
                state: "mutating",
                transitionedAt: "2026-07-05T00:00:01.000Z",
                configurationArtifactAddition: artifact
              }, { leaseContext });
            }
          }
        }, { stateDirectory, leaseContext });
      });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const restartedStore = api.createIntegrationRecoveryStore();
        if (beforeMode !== undefined) {
          const backupPath = await findOwnedBackup(boundary);
          expect(Number((await lstat(backupPath)).mode & 0o777)).toBe(0o600);
          const modeDriftAuthority = await (restartedStore as unknown as {
            loadIntegrationFileRecoveryAuthority: Function;
          }).loadIntegrationFileRecoveryAuthority(stateDirectory, {
            transactionId,
            operation: "restore"
          }, { leaseContext });
          await chmod(backupPath, 0o640);
          await expect(api.restoreIntegrationFileFromRecovery(modeDriftAuthority, {
            stateDirectory,
            leaseContext
          })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE" });
          expect(await readFile(targetPath, "utf8")).toBe("after\n");
          expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(0o600);
          await chmod(backupPath, 0o600);
        }
        const staleAuthority = await (restartedStore as unknown as {
          loadIntegrationFileRecoveryAuthority: Function;
        }).loadIntegrationFileRecoveryAuthority(stateDirectory, {
          transactionId,
          operation: "restore"
        }, { leaseContext });
        await api.appendIntegrationRecoveryTransition(stateDirectory, {
          transactionId,
          expectedSequence: 1,
          expectedState: "mutating",
          state: "recovery-required",
          transitionedAt: "2026-07-05T00:00:02.000Z"
        }, { leaseContext });
        await expect(api.restoreIntegrationFileFromRecovery(staleAuthority, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/stale|changed|authority/i);
        const authority = await (restartedStore as unknown as {
          loadIntegrationFileRecoveryAuthority: Function;
        }).loadIntegrationFileRecoveryAuthority(stateDirectory, {
          transactionId,
          operation: "restore"
        }, { leaseContext });
        const otherState = join(root, "other-state");
        await expect(api.restoreIntegrationFileFromRecovery(authority, {
          stateDirectory: otherState,
          leaseContext
        })).rejects.toThrow(/mismatched|authority/i);
        const clone = structuredClone(authority);
        await expect(api.restoreIntegrationFileFromRecovery(clone, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/Store-issued|forged|authority/i);
        await expect(api.restoreIntegrationFileFromRecovery({} as never, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/Store-issued|forged|authority/i);
        await api.restoreIntegrationFileFromRecovery(authority, { stateDirectory, leaseContext });
        await expect(api.restoreIntegrationFileFromRecovery(authority, {
          stateDirectory,
          leaseContext
        })).rejects.toThrow(/stale|consumed|authority/i);
      });

      if (beforeMode !== undefined) {
        expect(await readFile(targetPath, "utf8")).toBe("before\n");
        expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(beforeMode);
      } else {
        await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await readdir(boundary)).filter((name) => name.includes(".skill-steward.")))
        .toEqual([]);
    }
  );

  it.each([0o644, 0o640])(
    "finalizes a committed configuration whose original mode was %o from a fresh Store-issued authority",
    async (beforeMode) => {
    const api = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "steward-file-recovery-finalize-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    const targetPath = join(boundary, "config.json");
    const transactionId = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(boundary, { recursive: true, mode: 0o700 });
    await writeFile(targetPath, "before\n", { mode: beforeMode });
    await chmod(targetPath, beforeMode);
    const lifecycleRecord = boundLifecycleRecord(root, targetPath, {
      beforeFingerprint: file("before\n", beforeMode).fingerprint,
      trigger: {
        planId: `file-recovery-finalize-${beforeMode.toString(8)}`,
        harness: "codex",
        createdAt: "2026-07-05T00:00:00.000Z"
      }
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let recovery = await api.createIntegrationRecoveryIntent(stateDirectory, {
        schemaVersion: 1,
        transactionId,
        planId: `file-recovery-finalize-${beforeMode.toString(8)}`,
        harness: "codex",
        action: "none",
        companionPath: join(root, "home", ".agents", "skills", "skill-steward-preflight"),
        configPath: targetPath,
        beforeFingerprint: file("same\n").fingerprint,
        afterFingerprint: file("same\n").fingerprint,
        createdAt: "2026-07-05T00:00:00.000Z",
        lifecycleRecordBinding: bindIntegrationRecordV2(lifecycleRecord),
        artifactHints: []
      }, { leaseContext });
      await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n", beforeMode),
        after: file("after\n"),
        recovery: {
          transactionId,
          beforePublish: async (artifact) => {
            expect(artifact).toMatchObject({
              before: { state: "file", mode: beforeMode },
              backup: { mode: 0o600 }
            });
            recovery = await api.appendIntegrationRecoveryTransition(stateDirectory, {
              transactionId,
              expectedSequence: recovery.sequence,
              expectedState: recovery.state,
              state: "mutating",
              transitionedAt: "2026-07-05T00:00:01.000Z",
              configurationArtifactAddition: artifact
            }, { leaseContext });
          }
        }
      }, { stateDirectory, leaseContext });
      expect(Number((await lstat(await findOwnedBackup(boundary))).mode & 0o777)).toBe(0o600);
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
      const restartedStore = api.createIntegrationRecoveryStore();
      const authority = await restartedStore.loadIntegrationFileRecoveryAuthority(
        stateDirectory,
        { transactionId, operation: "finalize" },
        { leaseContext }
      );
      await api.finalizeIntegrationFileFromRecovery(authority, {
        stateDirectory,
        leaseContext
      });
    });

    expect(await readFile(targetPath, "utf8")).toBe("after\n");
    expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(0o600);
    expect((await readdir(boundary)).filter((name) => name.endsWith(".backup"))).toEqual([]);
    }
  );

  it.each([
    ["record identity", (record: IntegrationRecordV2) => ({ ...record, id: "other-record" })],
    ["Harness identity", (record: IntegrationRecordV2) => ({
      ...record,
      harness: "claude-code" as const,
      companion: { ...record.companion, consumers: ["claude-code" as const] },
      trigger: { ...record.trigger, harness: "claude-code" as const }
    })],
    ["operation status", (record: IntegrationRecordV2) => ({
      ...record,
      action: "remove" as const,
      status: "removed" as const,
      companion: {
        ...record.companion,
        action: "remove" as const,
        after: { state: "absent" as const },
        consumers: []
      }
    })],
    ["configuration", (record: IntegrationRecordV2) => ({
      ...record,
      targetPath: `${record.targetPath}.other`,
      beforeFingerprint: `sha256:${"1".repeat(64)}`,
      afterFingerprint: `sha256:${"2".repeat(64)}`,
      installedEntryFingerprint: `sha256:${"3".repeat(64)}`
    })],
    ["companion", (record: IntegrationRecordV2) => ({
      ...record,
      companion: { ...record.companion, path: `${record.companion.path}-other` }
    })],
    ["trigger", (record: IntegrationRecordV2) => ({
      ...record,
      trigger: { ...record.trigger, planId: "other-plan" }
    })],
    ["creation time", (record: IntegrationRecordV2) => ({
      ...record,
      trigger: { ...record.trigger, createdAt: "2026-07-05T00:00:03.000Z" },
      createdAt: "2026-07-05T00:00:03.000Z"
    })]
  ] as const)(
    "refuses fresh file finalize authority for a mismatched current %s field group",
    async (_label, mismatch) => {
      const fixture = await prepareBoundFileFinalize((expected) => [mismatch(expected)]);
      const backupPath = await findOwnedBackup(fixture.boundary);

      await withIntegrationMutationLease(fixture.stateDirectory, async (leaseContext) => {
        await expect((await import("../src/index.js")).loadIntegrationFileRecoveryAuthority(
          fixture.stateDirectory,
          { transactionId: fixture.transactionId, operation: "finalize" },
          { leaseContext }
        )).rejects.toThrow(/lifecycle|current|authority|state/i);
      });

      expect(await readFile(fixture.targetPath, "utf8")).toBe("after\n");
      expect(Number((await lstat(backupPath)).mode & 0o777)).toBe(0o600);
    }
  );

  it("rejects an exact lifecycle record that is older than the authoritative journal head", async () => {
    const fixture = await prepareBoundFileFinalize((expected) => [
      expected,
      {
        ...expected,
        id: "newer-record",
        trigger: {
          ...expected.trigger,
          planId: "newer-plan",
          createdAt: "2026-07-05T00:00:03.000Z"
        },
        createdAt: "2026-07-05T00:00:03.000Z"
      }
    ], "mutating");
    const backupPath = await findOwnedBackup(fixture.boundary);

    await withIntegrationMutationLease(fixture.stateDirectory, async (leaseContext) => {
      await expect((await import("../src/index.js")).loadIntegrationFileRecoveryAuthority(
        fixture.stateDirectory,
        { transactionId: fixture.transactionId, operation: "finalize" },
        { leaseContext }
      )).rejects.toThrow(/lifecycle|current|authority|state/i);
    });

    expect(await readFile(fixture.targetPath, "utf8")).toBe("after\n");
    expect(Number((await lstat(backupPath)).mode & 0o777)).toBe(0o600);
  });

  it("invalidates fresh file finalize authority when the journal head advances after issuance", async () => {
    const fixture = await prepareBoundFileFinalize((expected) => [expected]);
    const backupPath = await findOwnedBackup(fixture.boundary);

    await withIntegrationMutationLease(fixture.stateDirectory, async (leaseContext) => {
      const api = await import("../src/index.js");
      const authority = await api.loadIntegrationFileRecoveryAuthority(
        fixture.stateDirectory,
        { transactionId: fixture.transactionId, operation: "finalize" },
        { leaseContext }
      );
      await appendIntegrationRecord(fixture.stateDirectory, {
        ...fixture.expected,
        id: "advanced-head",
        trigger: {
          ...fixture.expected.trigger,
          planId: "advanced-plan",
          createdAt: "2026-07-05T00:00:04.000Z"
        },
        createdAt: "2026-07-05T00:00:04.000Z"
      });
      await expect(api.finalizeIntegrationFileFromRecovery(authority, {
        stateDirectory: fixture.stateDirectory,
        leaseContext
      })).rejects.toThrow(/lifecycle|current|authority|state/i);
    });

    expect(await readFile(fixture.targetPath, "utf8")).toBe("after\n");
    expect(Number((await lstat(backupPath)).mode & 0o777)).toBe(0o600);
  });

  it.each(["absent", "file"] as const)(
    "restores %s configuration after a real publisher process is killed",
    async (beforeState) => {
      const api = await import("../src/index.js");
      const root = await mkdtemp(join(tmpdir(), "steward-file-crash-recovery-"));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      const targetPath = join(boundary, "config.json");
      const markerPath = join(root, "published.marker");
      const workerPath = join(root, "file-crash-worker.cjs");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(boundary, { recursive: true, mode: 0o700 });
      if (beforeState === "file") await writeFile(targetPath, "before\n", { mode: 0o600 });
      await build({
        entryPoints: [fileURLToPath(new URL(
          "./fixtures/integration-file-crash-worker.ts",
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
            boundary,
            targetPath,
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
      expect(await readFile(targetPath, "utf8")).toBe("after\n");

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const restartedStore = api.createIntegrationRecoveryStore();
        const authority = await restartedStore.loadIntegrationFileRecoveryAuthority(
          stateDirectory,
          {
            transactionId: "123e4567-e89b-42d3-a456-426614174000",
            operation: "restore"
          },
          { leaseContext }
        );
        await api.restoreIntegrationFileFromRecovery(authority, {
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
        expect(await readFile(targetPath, "utf8")).toBe("before\n");
      } else {
        await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  , 10_000);

  it.each([0o644, 0o640])(
    "restores an original %o-mode configuration after a real prepublication crash",
    async (beforeMode) => {
      const api = await import("../src/index.js");
      const root = await mkdtemp(join(tmpdir(), "steward-file-prepublish-crash-"));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      const targetPath = join(boundary, "config.json");
      const markerPath = join(root, "checkpointed.marker");
      const workerPath = join(root, "file-crash-worker.cjs");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(boundary, { recursive: true, mode: 0o700 });
      await writeFile(targetPath, "before\n", { mode: beforeMode });
      await chmod(targetPath, beforeMode);
      await build({
        entryPoints: [fileURLToPath(new URL(
          "./fixtures/integration-file-crash-worker.ts",
          import.meta.url
        ))],
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        outfile: workerPath,
        logLevel: "silent"
      });

      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stderr: string;
      }>((resolveProcess, rejectProcess) => {
        const child = spawn(process.execPath, [
          workerPath,
          stateDirectory,
          boundary,
          targetPath,
          "file",
          markerPath,
          beforeMode.toString(8),
          "before-publish"
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.once("error", rejectProcess);
        child.once("exit", (code, signal) => resolveProcess({ code, signal, stderr }));
      });
      expect(result).toMatchObject({ code: null, signal: "SIGKILL", stderr: "" });
      expect(await readFile(markerPath, "utf8")).toBe("checkpointed\n");
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(beforeMode);
      expect(Number((await lstat(await findOwnedBackup(boundary))).mode & 0o777)).toBe(0o600);

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const authority = await api.loadIntegrationFileRecoveryAuthority(
          stateDirectory,
          {
            transactionId: "123e4567-e89b-42d3-a456-426614174000",
            operation: "restore"
          },
          { leaseContext }
        );
        await api.restoreIntegrationFileFromRecovery(authority, { stateDirectory, leaseContext });
      }, {
        waitMs: 2_000,
        pollMs: 2,
        staleMs: 10,
        hardStaleMs: 120_000
      });

      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(beforeMode);
      expect((await readdir(boundary)).filter((name) => name.includes(".skill-steward.")))
        .toEqual([]);
    },
    10_000
  );

  it("keeps an exact private backup and restores an existing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o640 });
    await chmod(targetPath, 0o640);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n", 0o640),
        after: file("after\n")
      }, { stateDirectory, leaseContext });

      const backupPath = await findOwnedBackup(boundary);
      expect(backupPath).toMatch(/\.skill-steward\.[0-9a-f-]+\.backup$/);
      expect(await readFile(backupPath, "utf8")).toBe("before\n");
      expect(Number((await lstat(backupPath)).mode & 0o777)).toBe(0o600);

      await restoreIntegrationFileTransaction(proof, { stateDirectory, leaseContext });
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(Number((await lstat(targetPath)).mode & 0o777)).toBe(0o640);
    });
  });

  it("classifies a rename failure before publication as definite and cleans owned artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-before-rename-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.mode = "throw-before";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_FAILED"
      });
    });

    expect(await readdir(boundary)).toEqual([]);
  });

  it("accepts a committed destination when rename throws after publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-after-rename-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.mode = "throw-after";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      expect(integrationFileTransactionReceipt(proof).status).toBe("published");
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
    });
  });

  it.each([
    "replace-after",
    "source-disappears",
    "same-inode-alias",
    "parent-swap"
  ] as const)("fails closed when rename probing observes %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `steward-file-${mode}-`));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.mode = mode;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_UNCERTAIN"
      });
    });
  });

  it("returns uncertainty when the post-publication parent fsync fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-post-fsync-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.syncFailureExact = boundary;
    fault.syncFailureOccurrence = 2;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_UNCERTAIN"
      });
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
    });
  });

  it("cleans an exact backup when its fsync fails before any target mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-backup-fsync-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });
    fault.syncFailureSuffix = ".backup";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_FAILED"
      });
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(await readdir(boundary)).toEqual(["config.json"]);
    });
  });

  it("refuses a same-byte owned temporary replacement after handle close", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-temp-close-replacement-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.replaceOwnedAfterCloseSuffix = ".tmp";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
      });
      expect(await readdir(boundary)).toHaveLength(1);
      expect(await readFile(join(boundary, (await readdir(boundary))[0]!), "utf8")).toBe("after\n");
      await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("revalidates an absent target after staging and never overwrites a new external file", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-target-after-stage-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.injectTargetAfterOwnedClose = targetPath;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });
      expect(await readFile(targetPath, "utf8")).toBe("external\n");
      expect(await readdir(boundary)).toEqual(["config.json"]);
    });
  });

  it("revalidates the exact backup after staging and before target publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-backup-after-stage-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });
    fault.replaceBackupAfterTempClose = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
      });
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      const backupName = (await readdir(boundary)).find((name) => name.endsWith(".backup"));
      expect(backupName).toBeDefined();
      expect(await readFile(join(boundary, backupName!), "utf8")).toBe("before\n");
    });
  });

  it("rejects links, special entries, oversized files, and linked ancestors before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-invalid-target-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    const physical = join(root, "physical");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    await mkdir(physical, { mode: 0o700 });
    const linkedTarget = join(boundary, "linked.json");
    await writeFile(join(physical, "target.json"), "before\n", { mode: 0o600 });
    await symlink(join(physical, "target.json"), linkedTarget);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath: linkedTarget,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });

      const oversized = join(boundary, "oversized.json");
      await writeFile(oversized, "0123456789", { mode: 0o600 });
      await expect(publishIntegrationFileTransaction({
        targetPath: oversized,
        allowedBoundaryPath: boundary,
        expectedBefore: file("0123456789"),
        after: file("after") ,
        maxBytes: 5
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_INVALID"
      });
    });

    const linkedParent = join(boundary, "linked-parent");
    await symlink(physical, linkedParent);
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath: join(linkedParent, "new.json"),
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });
    });
  });

  it("does not overwrite a replacement during restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-recovery-drift-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      await unlink(targetPath);
      await writeFile(targetPath, "external\n", { mode: 0o600 });
      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });

      const directoryTarget = join(boundary, "directory-target.json");
      await mkdir(directoryTarget, { mode: 0o700 });
      await expect(publishIntegrationFileTransaction({
        targetPath: directoryTarget,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });
      expect(await readFile(targetPath, "utf8")).toBe("external\n");

    });
  });

  it("proves the recovery backup before moving the installed target", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-backup-drift-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const backupPath = await findOwnedBackup(boundary);
      await unlink(backupPath);
      await writeFile(backupPath, "external backup\n", { mode: 0o600 });

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
      expect(await readFile(backupPath, "utf8")).toBe("external backup\n");
    });
  });

  it("never unlinks a replacement at the finalize cleanup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-finalize-drift-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const backupPath = await findOwnedBackup(boundary);
      await unlink(backupPath);
      await writeFile(backupPath, "external backup\n", { mode: 0o600 });

      await expect(finalizeIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
      });
      expect(await readFile(backupPath, "utf8")).toBe("external backup\n");
    });
  });

  it("retries restore after the deterministic backup cleanup claim unlink fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-final-claim-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [".restore.backup.cleanup.claim"];

      await expect(restoreIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(boundary)).some((name) =>
        name.endsWith(".restore.backup.cleanup.claim"))).toBe(true);
      await expect(restoreIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(await readdir(boundary)).toEqual(["config.json"]);
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
    });
  });

  it("retries restore after the deterministic discard cleanup claim unlink fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-discard-claim-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [".restore.discard.cleanup.claim"];

      await expect(restoreIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(boundary)).some((name) =>
        name.endsWith(".restore.discard.cleanup.claim"))).toBe(true);
      await expect(restoreIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(await readdir(boundary)).toEqual(["config.json"]);
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
    });
  });

  it("retries finalize after the deterministic backup cleanup claim unlink fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-finalize-claim-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [".finalize.backup.cleanup.claim"];

      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect((await readdir(boundary)).some((name) =>
        name.endsWith(".finalize.backup.cleanup.claim"))).toBe(true);
      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(await readdir(boundary)).toEqual(["config.json"]);
      expect(await readFile(targetPath, "utf8")).toBe("after\n");
    });
  });

  it("retries finalize when the final claim unlink committed but parent fsync failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-finalize-fsync-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.matchingSyncs = 0;
      fault.syncFailureExact = boundary;
      fault.syncFailureOccurrence = 2;

      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      expect(await readdir(boundary)).toEqual(["config.json"]);
      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(integrationFileTransactionReceipt(handle).status).toBe("finalized");
    });
  });

  it("preserves a forged same-byte finalize claim with the wrong inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-finalize-forged-claim-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [".finalize.backup.cleanup.claim"];
      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toBeDefined();
      const claimName = (await readdir(boundary)).find((name) =>
        name.endsWith(".finalize.backup.cleanup.claim"))!;
      const claimPath = join(boundary, claimName);
      const claimBytes = await readFile(claimPath);
      await unlink(claimPath);
      await writeFile(claimPath, claimBytes, { mode: 0o600 });

      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING" });
      expect(await readFile(claimPath)).toEqual(claimBytes);
    });
  });

  it.each([
    ["throw-before", "before\n"],
    ["swap-source-before", "external cleanup replacement\n"]
  ] as const)("preserves cleanup evidence when claim rename is %s", async (mode, expected) => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-cleanup-claim-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const backupPath = await findOwnedBackup(boundary);
      fault.destinationSuffix = ".claim";
      fault.mode = mode;
      await expect(finalizeIntegrationFileTransaction(handle, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING" });
      expect(await readFile(backupPath, "utf8")).toBe(expected);
    });
  });

  it("fsyncs the owned temporary before rename and the parent after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-order-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
    });

    const temporarySync = fault.syncEvents.findIndex((path) => path.endsWith(".tmp"));
    const firstParentSync = fault.syncEvents.indexOf(boundary);
    const renameIndex = fault.renameEvents.findIndex((event) => event.endsWith(`->${targetPath}`));
    expect(temporarySync).toBeGreaterThanOrEqual(0);
    expect(firstParentSync).toBeGreaterThan(temporarySync);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(fault.syncEvents.filter((path) => path === boundary)).toHaveLength(2);
  });

  it.each([
    ["owned temporary", ".tmp", null],
    ["parent before rename", null, "boundary"]
  ] as const)("returns a definite typed failure when %s fsync fails", async (_label, suffix, exact) => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-fsync-failure-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.syncFailureSuffix = suffix;
    fault.syncFailureExact = exact === "boundary" ? boundary : null;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_FAILED"
      });
    });
    expect(await readdir(boundary)).toEqual([]);
  });

  it("preserves primary and cleanup causes when definite publication cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-dual-failure-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.mode = "throw-before";
    fault.cleanupUnlinkFailure = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let failure: unknown;
      try {
        await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("after\n")
        }, { stateDirectory, leaseContext });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING" });
      const cause = (failure as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toHaveLength(2);
    });
  });

  it("keeps a recoverable cleanup-pending artifact out of serialized errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-private-recovery-error-"));
    const stateDirectory = join(root, "private-state");
    const boundary = join(root, "private-home");
    const targetPath = join(boundary, "config.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    fault.destination = targetPath;
    fault.mode = "throw-before";
    fault.cleanupUnlinkFailure = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const failure = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n"),
        recovery: {
          transactionId: "123e4567-e89b-42d3-a456-426614174000",
          beforePublish: async () => undefined
        }
      }, { stateDirectory, leaseContext }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING",
        recoveryArtifact: { targetPath }
      });
      expect(JSON.stringify(failure)).not.toContain(root);
    });
  });

  it("preserves read and close failures in one typed cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-read-close-dual-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    const targetPath = join(boundary, "config.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    await writeFile(targetPath, "before\n", { mode: 0o600 });
    fault.readFailureExact = targetPath;
    fault.closeFailureAfterIoExact = targetPath;

    let failure: unknown;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      try {
        await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: file("before\n"),
          after: file("after\n")
        }, { stateDirectory, leaseContext });
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      "injected read failure",
      "injected close failure"
    ]));
  });

  it("preserves sync and close failures in one typed cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-sync-close-dual-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    const targetPath = join(boundary, "config.json");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    fault.syncFailureExact = boundary;
    fault.closeFailureAfterIoExact = boundary;

    let failure: unknown;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      try {
        await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("after\n")
        }, { stateDirectory, leaseContext });
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toMatchObject({ code: "INTEGRATION_CONFIGURATION_FAILED" });
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      "injected fsync failure",
      "injected close failure"
    ]));
  });

  it.each(["throw-before", "swap-source-before"] as const)(
    "quarantines a failed write when cleanup claim rename is %s",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "steward-file-failed-write-claim-"));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(boundary, { mode: 0o700 });
      fault.syncFailureSuffix = ".tmp";
      fault.destinationSuffix = ".claim";
      fault.mode = mode;

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(publishIntegrationFileTransaction({
          targetPath: join(boundary, "config.json"),
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("after\n")
        }, { stateDirectory, leaseContext })).rejects.toMatchObject({
          code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
        });
      });
      const residues = await readdir(boundary);
      expect(residues).toHaveLength(1);
      if (mode === "swap-source-before") {
        expect(await readFile(join(boundary, residues[0]!), "utf8"))
          .toBe("external cleanup replacement\n");
      }
    }
  );

  it("restores an originally absent target without broad unlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-absent-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      await restoreIntegrationFileTransaction(proof, { stateDirectory, leaseContext });
      expect(await readdir(boundary)).toEqual([]);
    });
  });

  it.each([
    ["throw-before", "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE", "after\n"],
    ["throw-after", null, null]
  ] as const)(
    "classifies restore discard rename %s",
    async (mode, expectedCode, expectedTarget) => {
      const root = await mkdtemp(join(tmpdir(), `steward-file-restore-${mode}-`));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(boundary, { mode: 0o700 });
      const targetPath = join(boundary, "config.json");

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const proof = await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("after\n")
        }, { stateDirectory, leaseContext });
        fault.destinationSuffix = ".discard";
        fault.mode = mode;
        const restoring = restoreIntegrationFileTransaction(proof, {
          stateDirectory,
          leaseContext
        });
        if (expectedCode) {
          await expect(restoring).rejects.toMatchObject({ code: expectedCode });
          expect(await readFile(targetPath, "utf8")).toBe(expectedTarget);
        } else {
          await expect(restoring).resolves.toBeUndefined();
          expect(await readdir(boundary)).toEqual([]);
        }
      });
    }
  );

  it("revalidates restore destination absence and never overwrites an inserted external file", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-target-insert-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const backupPath = await findOwnedBackup(boundary);
      fault.injectTargetAfterOwnedClose = targetPath;

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
      expect(await readFile(targetPath, "utf8")).toBe("external\n");
      expect(await readFile(backupPath, "utf8")).toBe("before\n");
    });
  });

  it("preserves a destination inserted immediately before the no-overwrite recovery link", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-link-eexist-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.destination = targetPath;
      fault.mode = "insert-destination-before-link";

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE" });
      expect(await readFile(targetPath, "utf8")).toBe("external immediate replacement\n");
    });
  });

  it("retries an exact target-to-discard hard-link pair after alias unlink and rollback both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-discard-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [targetPath, ".restore.discard"];

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_UNCERTAIN" });
      const discardName = (await readdir(boundary)).find((name) => name.endsWith(".restore.discard"));
      expect(discardName).toBeDefined();
      expect((await lstat(targetPath)).ino).toBe((await lstat(join(boundary, discardName!))).ino);

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(await readdir(boundary)).toEqual(["config.json"]);
    });
  });

  it("retries an exact temporary-to-target hard-link pair after alias unlink and rollback both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-target-retry-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [".restore.tmp", targetPath];

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_UNCERTAIN" });
      const temporaryName = (await readdir(boundary)).find((name) => name.endsWith(".restore.tmp"));
      expect(temporaryName).toBeDefined();
      expect((await lstat(targetPath)).ino).toBe((await lstat(join(boundary, temporaryName!))).ino);

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).resolves.toBeUndefined();
      expect(await readFile(targetPath, "utf8")).toBe("before\n");
      expect(await readdir(boundary)).toEqual(["config.json"]);
    });
  });

  it("does not collapse a forged same-byte hard-link pair outside transaction inode authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-forged-pair-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      fault.unlinkFailureSequence = [targetPath, ".restore.discard"];
      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_UNCERTAIN" });
      const discardName = (await readdir(boundary)).find((name) => name.endsWith(".restore.discard"))!;
      const discardPath = join(boundary, discardName);
      await unlink(targetPath);
      await unlink(discardPath);
      await writeFile(targetPath, "after\n", { mode: 0o600 });
      await link(targetPath, discardPath);

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      expect((await lstat(targetPath)).nlink).toBe(2);
      expect((await lstat(discardPath)).nlink).toBe(2);
    });
  });

  it("preserves the verified backup when restore publication becomes uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-restore-uncertain-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const backupPath = await findOwnedBackup(boundary);
      fault.destinationSuffix = ".discard";
      fault.mode = "replace-after";

      await expect(restoreIntegrationFileTransaction(proof, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_UNCERTAIN" });
      expect(await readFile(backupPath, "utf8")).toBe("before\n");
    });
  });

  it.each([
    ["throw-before", "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE", null],
    ["throw-after", null, "before\n"],
    ["replace-after", "INTEGRATION_CONFIGURATION_UNCERTAIN", "replacement\n"]
  ] as const)(
    "classifies restore target rename %s",
    async (mode, expectedCode, expectedTarget) => {
      const root = await mkdtemp(join(tmpdir(), `steward-file-restore-target-${mode}-`));
      const stateDirectory = join(root, "state");
      const boundary = join(root, "home");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(boundary, { mode: 0o700 });
      const targetPath = join(boundary, "config.json");
      await writeFile(targetPath, "before\n", { mode: 0o600 });

      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const proof = await publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: file("before\n"),
          after: file("after\n")
        }, { stateDirectory, leaseContext });
        const backupPath = await findOwnedBackup(boundary);
        fault.destination = targetPath;
        fault.mode = mode;
        const restoring = restoreIntegrationFileTransaction(proof, {
          stateDirectory,
          leaseContext
        });
        if (expectedCode) {
          await expect(restoring).rejects.toMatchObject({ code: expectedCode });
          if (expectedTarget === null) {
            await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(await readFile(targetPath, "utf8")).toBe(expectedTarget);
          }
          expect(await readFile(backupPath, "utf8")).toBe("before\n");
        } else {
          await expect(restoring).resolves.toBeUndefined();
          expect(await readFile(targetPath, "utf8")).toBe(expectedTarget);
        }
      });
    }
  );

  it("rejects an expired authentic context before creating owned files", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-expired-lease-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    let expired!: Parameters<typeof publishIntegrationFileTransaction>[1]["leaseContext"];
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      expired = leaseContext;
    });

    await expect(publishIntegrationFileTransaction({
      targetPath,
      allowedBoundaryPath: boundary,
      expectedBefore: { state: "absent" },
      after: file("after\n")
    }, { stateDirectory, leaseContext: expired })).rejects.toMatchObject({
      code: "INTEGRATION_LEASE_LOST"
    });
    expect(await readdir(boundary)).toEqual([]);
  });

  it("fails closed on Windows before creating transaction artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-windows-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(publishIntegrationFileTransaction({
          targetPath,
          allowedBoundaryPath: boundary,
          expectedBefore: { state: "absent" },
          after: file("after\n")
        }, { stateDirectory, leaseContext })).rejects.toMatchObject({
          code: "INTEGRATION_CONFIGURATION_INVALID"
        });
      });
    } finally {
      platform.mockRestore();
    }
    expect(await readdir(boundary)).toEqual([]);
  });

  it("returns a frozen sanitized receipt that has no mutation authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-recovery-proof-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    await writeFile(targetPath, "before\n", { mode: 0o600 });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const proof = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("before\n"),
        after: file("after\n")
      }, { stateDirectory, leaseContext });
      const receipt = integrationFileTransactionReceipt(proof);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        status: "published",
        beforeFingerprint: fingerprintIntegrationFileBytes(bytes("before\n")),
        afterFingerprint: fingerprintIntegrationFileBytes(bytes("after\n"))
      });
      expect(receipt).not.toHaveProperty("path");
      await expect(finalizeIntegrationFileTransaction(
        receipt as never,
        { stateDirectory, leaseContext }
      )).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
    });
  });

  it("makes successful file transaction transitions terminal before any later mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-terminal-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const finalizedPath = join(boundary, "finalized.json");
    const restoredPath = join(boundary, "restored.json");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const finalized = await publishIntegrationFileTransaction({
        targetPath: finalizedPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("finalized\n")
      }, { stateDirectory, leaseContext });
      await finalizeIntegrationFileTransaction(finalized, { stateDirectory, leaseContext });
      expect(integrationFileTransactionReceipt(finalized).status).toBe("finalized");
      await expect(restoreIntegrationFileTransaction(finalized, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      expect(await readFile(finalizedPath, "utf8")).toBe("finalized\n");

      const restored = await publishIntegrationFileTransaction({
        targetPath: restoredPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("restored\n")
      }, { stateDirectory, leaseContext });
      await restoreIntegrationFileTransaction(restored, { stateDirectory, leaseContext });
      expect(integrationFileTransactionReceipt(restored).status).toBe("restored");
      await expect(finalizeIntegrationFileTransaction(restored, {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      await expect(readFile(restoredPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("releases a failed same-context claim so the next transition can proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-failed-claim-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.mode = "throw-before";

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("first\n")
      }, { stateDirectory, leaseContext })).rejects.toBeDefined();
      const handle = await publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("second\n")
      }, { stateDirectory, leaseContext });
      expect(integrationFileTransactionReceipt(handle).status).toBe("published");
    });
    expect(await readFile(targetPath, "utf8")).toBe("second\n");
  });

  it("serializes concurrent transitions using the same authentic lease context", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-file-concurrency-"));
    const stateDirectory = join(root, "state");
    const boundary = join(root, "home");
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(boundary, { mode: 0o700 });
    const targetPath = join(boundary, "config.json");
    fault.destination = targetPath;
    fault.blockFirstRename = true;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const first = publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: { state: "absent" },
        after: file("first\n")
      }, { stateDirectory, leaseContext });
      while (!fault.blocked) await new Promise((resolve) => setTimeout(resolve, 1));
      fault.blocked();
      const second = publishIntegrationFileTransaction({
        targetPath,
        allowedBoundaryPath: boundary,
        expectedBefore: file("first\n"),
        after: file("second\n")
      }, { stateDirectory, leaseContext });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fault.renameCount).toBe(1);
      fault.release?.();
      await Promise.all([first, second]);
    });

    expect(fault.maxActiveRenames).toBe(1);
    expect(await readFile(targetPath, "utf8")).toBe("second\n");
  });
});
