import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendIntegrationRecord,
  createIntegrationRecordStore,
  IntegrationJournalCommitUncertainError,
  latestIntegrationRecord,
  readIntegrationRecordJournal,
  readIntegrationRecords,
  type IntegrationRecord,
  type IntegrationRecordV1,
  type IntegrationRecordV2
} from "../src/integration-store.js";

const publicationGate = vi.hoisted(() => ({
  ageTemporary: false,
  armed: false,
  blocked: null as (() => void) | null,
  wait: null as Promise<void> | null,
  publishedPath: null as string | null,
  temporaryCtime: null as bigint | null,
  afterPublish: null as ((publishedPath: string) => Promise<void>) | null,
  failOwnedUnlink: false,
  hardLinkDestinationBeforeRename: false,
  hardLinkNoOpObserved: false,
  replaceRecordsAfterPublishedMetadata: false,
  recordsReplaced: false,
  renameCollisionSource: null as Uint8Array | null,
  renameSourceReplacement: null as Uint8Array | null,
  throwAfterPublishRename: false,
  zeroTemporaryIdentity: false
}));

const readRaceGate = vi.hoisted(() => ({
  mode: null as
    | "remove-target-before-read"
    | "remove-target-during-final-identity"
    | "remove-target-during-path-revalidation"
    | "replace-target-before-read"
    | "replace-directory-after-read"
    | null,
  target: null as string | null,
  directory: null as string | null,
  replacement: null as Uint8Array | null,
  pathLstatCalls: 0,
  triggered: false,
  zeroIdentityPath: null as string | null
}));

const stateSwapGate = vi.hoisted(() => ({
  armed: false,
  initialStateSamples: 0,
  legacyMissing: false,
  legacyReady: null as Promise<void> | null,
  markLegacyReady: null as (() => void) | null,
  samplesReady: null as Promise<void> | null,
  markSamplesReady: null as (() => void) | null,
  state: null as string | null,
  outside: null as string | null,
  swapped: false
}));

const journalSplitStateGate = vi.hoisted(() => ({
  armed: false,
  finalPhysicalReady: null as Promise<void> | null,
  legacyWait: null as Promise<void> | null,
  lstatCalls: 0,
  markFinalPhysicalReady: null as (() => void) | null,
  releaseLegacy: null as (() => void) | null,
  replacement: null as string | null,
  realpathCalls: 0,
  state: null as string | null,
  swapped: false
}));

const appendRootGapGate = vi.hoisted(() => ({
  armed: false,
  enumerations: 0,
  fragmentIdentityDone: false,
  fragmentTerminalDone: false,
  legacyDone: false,
  legacyRealpaths: 0,
  markSwapped: null as (() => void) | null,
  markTerminalLstatReady: null as (() => void) | null,
  outsideTouched: false,
  replacement: null as string | null,
  state: null as string | null,
  swapped: false,
  swappedReady: null as Promise<void> | null,
  terminalLstatReady: null as Promise<void> | null
}));

const publicationOwnershipGate = vi.hoisted(() => ({
  cleanupArmDirectoryLstat: false,
  cleanupDirectory: null as string | null,
  cleanupDirectorySamples: 0,
  cleanupEnumerations: 0,
  cleanupReplacement: null as Uint8Array | null,
  cleanupTarget: null as string | null,
  cleanupTriggered: false,
  laterMalformedName: null as string | null,
  laterReplacement: null as Uint8Array | null,
  laterTriggered: false
}));

const postValidationJournalGate = vi.hoisted(() => ({
  armed: false,
  fragmentSource: null as Uint8Array | null,
  mode: null as "records" | "legacy" | null,
  state: null as string | null,
  triggered: false
}));

const temporaryOpenGapGate = vi.hoisted(() => ({
  armed: false,
  state: null as string | null,
  triggered: false
}));

const enumerationGate = vi.hoisted(() => ({
  afterEnumeration: null as (() => Promise<void>) | null,
  beforeSecondEnumeration: null as (() => Promise<void>) | null,
  calls: 0,
  directory: null as string | null,
  fixedCtimeNs: null as bigint | null,
  fixedMtimeNs: null as bigint | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  async function replaceTargetBeforeRead(path: string): Promise<void> {
    if (
      (readRaceGate.mode !== "replace-target-before-read"
        && readRaceGate.mode !== "remove-target-before-read")
      || readRaceGate.triggered
      || path !== readRaceGate.target
    ) return;
    readRaceGate.triggered = true;
    if (readRaceGate.mode === "remove-target-before-read") {
      await original.unlink(path);
      return;
    }
    await original.rename(path, `${path}.original`);
    await original.writeFile(path, readRaceGate.replacement!, { mode: 0o600 });
  }
  async function replaceDirectoryAfterRead(): Promise<void> {
    if (
      readRaceGate.mode !== "replace-directory-after-read"
      || readRaceGate.triggered
      || readRaceGate.directory === null
    ) return;
    readRaceGate.triggered = true;
    await original.rename(readRaceGate.directory, `${readRaceGate.directory}.original`);
    await original.mkdir(readRaceGate.directory, { mode: 0o700 });
  }
  async function replaceJournalSplitState(): Promise<void> {
    await original.rename(
      journalSplitStateGate.state!,
      `${journalSplitStateGate.state}.initial`
    );
    await original.rename(
      journalSplitStateGate.replacement!,
      journalSplitStateGate.state!
    );
    journalSplitStateGate.swapped = true;
  }
  return {
    ...original,
    async mkdir(...args: Parameters<typeof original.mkdir>) {
      const path = String(args[0]);
      const recordsDirectory = postValidationJournalGate.state === null
        ? null
        : join(postValidationJournalGate.state, "integration-records");
      if (
        postValidationJournalGate.armed
        && !postValidationJournalGate.triggered
        && path === recordsDirectory
      ) {
        postValidationJournalGate.triggered = true;
        if (postValidationJournalGate.mode === "records") {
          await original.mkdir(path, { mode: 0o700 });
          await original.writeFile(join(path, "sentinel"), "untouched\n", { mode: 0o600 });
          await original.writeFile(join(
            path,
            `1-${process.pid}-000000000001-55555555-5555-4555-8555-555555555555.json`
          ), postValidationJournalGate.fragmentSource!, { mode: 0o600 });
        } else {
          await original.writeFile(
            join(postValidationJournalGate.state!, "integrations.json"),
            "not-json\n",
            { mode: 0o600 }
          );
        }
      }
      return original.mkdir(...args);
    },
    async lstat(...args: Parameters<typeof original.lstat>) {
      const path = String(args[0]);
      if (publicationGate.zeroTemporaryIdentity && path.endsWith(".tmp")) {
        const metadata = await original.lstat(...args);
        return new Proxy(metadata, {
          get(target, property, receiver) {
            if (property === "ino" || property === "dev") {
              return typeof target.ino === "bigint" ? 0n : 0;
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      if (
        publicationOwnershipGate.cleanupArmDirectoryLstat
        && path === publicationOwnershipGate.cleanupDirectory
      ) {
        publicationOwnershipGate.cleanupDirectorySamples += 1;
        if (publicationOwnershipGate.cleanupDirectorySamples === 2) {
          publicationOwnershipGate.cleanupArmDirectoryLstat = false;
          await original.rename(
            publicationOwnershipGate.cleanupTarget!,
            `${publicationOwnershipGate.cleanupTarget}.snapshot`
          );
          await original.writeFile(
            publicationOwnershipGate.cleanupTarget!,
            publicationOwnershipGate.cleanupReplacement!,
            { mode: 0o600 }
          );
          publicationOwnershipGate.cleanupTriggered = true;
        }
      }
      if (appendRootGapGate.armed) {
        const recordsDirectory = join(appendRootGapGate.state!, "integration-records");
        if (
          path.startsWith(`${recordsDirectory}/`)
          && path.endsWith(".json")
          && appendRootGapGate.enumerations >= 2
        ) {
          appendRootGapGate.fragmentIdentityDone = true;
        } else if (
          path === recordsDirectory
          && appendRootGapGate.fragmentIdentityDone
        ) {
          appendRootGapGate.fragmentTerminalDone = true;
        } else if (
          path === appendRootGapGate.state
          && appendRootGapGate.fragmentTerminalDone
          && appendRootGapGate.legacyDone
          && !appendRootGapGate.swapped
        ) {
          const metadata = await original.lstat(...args);
          appendRootGapGate.markTerminalLstatReady?.();
          await appendRootGapGate.swappedReady;
          return metadata;
        }
      }
      if (
        publicationGate.replaceRecordsAfterPublishedMetadata
        && !publicationGate.recordsReplaced
        && path === publicationGate.publishedPath
      ) {
        const metadata = await original.lstat(...args);
        const directory = dirname(path);
        await original.rename(directory, `${directory}.published`);
        await original.mkdir(directory, { mode: 0o700 });
        await original.writeFile(join(directory, "sentinel"), "untouched\n", {
          mode: 0o600
        });
        publicationGate.recordsReplaced = true;
        return metadata;
      }
      if (journalSplitStateGate.armed && path === journalSplitStateGate.state) {
        journalSplitStateGate.lstatCalls += 1;
        const call = journalSplitStateGate.lstatCalls;
        if (call === 2 && journalSplitStateGate.realpathCalls === 0) {
          await journalSplitStateGate.legacyWait;
        }
        if (call === 12) await journalSplitStateGate.finalPhysicalReady;
        const metadata = await original.lstat(...args);
        if (
          call === 2
          && journalSplitStateGate.realpathCalls > 0
          && !journalSplitStateGate.swapped
        ) {
          await replaceJournalSplitState();
        } else if (call === 12 && !journalSplitStateGate.swapped) {
          await replaceJournalSplitState();
          journalSplitStateGate.releaseLegacy?.();
        }
        return metadata;
      }
      if (stateSwapGate.armed) {
        const recordsPath = join(stateSwapGate.state!, "integration-records");
        const legacyPath = join(stateSwapGate.state!, "integrations.json");
        if (path === recordsPath && !stateSwapGate.swapped) {
          await stateSwapGate.legacyReady;
          await original.rename(stateSwapGate.state!, `${stateSwapGate.state}.initial`);
          await original.symlink(
            stateSwapGate.outside!,
            stateSwapGate.state!,
            process.platform === "win32" ? "junction" : "dir"
          );
          stateSwapGate.swapped = true;
        } else if (path === legacyPath) {
          await stateSwapGate.samplesReady;
          try {
            return await original.lstat(...args);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              stateSwapGate.legacyMissing = true;
            }
            throw error;
          }
        } else if (path === stateSwapGate.state) {
          const metadata = await original.lstat(...args);
          if (stateSwapGate.legacyMissing) {
            stateSwapGate.markLegacyReady?.();
          } else {
            stateSwapGate.initialStateSamples += 1;
            if (stateSwapGate.initialStateSamples >= 2) {
              stateSwapGate.markSamplesReady?.();
            }
          }
          return metadata;
        }
      }
      if (
        (readRaceGate.mode === "remove-target-during-path-revalidation"
          || readRaceGate.mode === "remove-target-during-final-identity")
        && path === readRaceGate.target
      ) {
        readRaceGate.pathLstatCalls += 1;
        const metadata = await original.lstat(...args);
        const triggerCall = readRaceGate.mode === "remove-target-during-path-revalidation"
          ? 2
          : 3;
        if (!readRaceGate.triggered && readRaceGate.pathLstatCalls === triggerCall) {
          readRaceGate.triggered = true;
          await original.unlink(path);
          return new Proxy(metadata, {
            get(target, property, receiver) {
              if (property === "ctimeNs") {
                const ctimeNs = Reflect.get(target, property, receiver);
                return typeof ctimeNs === "bigint" ? ctimeNs + 1n : ctimeNs;
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        }
        return metadata;
      }
      const metadata = await original.lstat(...args);
      if (
        path === enumerationGate.directory
        && enumerationGate.fixedCtimeNs !== null
        && enumerationGate.fixedMtimeNs !== null
      ) {
        return new Proxy(metadata, {
          get(target, property, receiver) {
            if (property === "ctimeNs") return enumerationGate.fixedCtimeNs;
            if (property === "mtimeNs") return enumerationGate.fixedMtimeNs;
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      if (path !== readRaceGate.zeroIdentityPath) return metadata;
      return new Proxy(metadata, {
        get(target, property, receiver) {
          if (property === "ino") return typeof target.ino === "bigint" ? 0n : 0;
          if (property === "dev") return typeof target.dev === "bigint" ? 0n : 0;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    async realpath(...args: Parameters<typeof original.realpath>) {
      const path = String(args[0]);
      if (appendRootGapGate.armed) {
        const legacyPath = join(appendRootGapGate.state!, "integrations.json");
        if (path === legacyPath) {
          appendRootGapGate.legacyRealpaths += 1;
          const physicalPath = await original.realpath(...args);
          if (appendRootGapGate.legacyRealpaths >= 2) {
            appendRootGapGate.legacyDone = true;
          }
          return physicalPath;
        }
        if (
          path === appendRootGapGate.state
          && appendRootGapGate.fragmentTerminalDone
          && appendRootGapGate.legacyDone
          && !appendRootGapGate.swapped
        ) {
          const physicalPath = await original.realpath(...args);
          await appendRootGapGate.terminalLstatReady;
          await original.rename(
            appendRootGapGate.state!,
            `${appendRootGapGate.state}.validated`
          );
          await original.rename(
            appendRootGapGate.replacement!,
            appendRootGapGate.state!
          );
          appendRootGapGate.swapped = true;
          appendRootGapGate.markSwapped?.();
          return physicalPath;
        }
      }
      if (journalSplitStateGate.armed && path === journalSplitStateGate.state) {
        journalSplitStateGate.realpathCalls += 1;
        const physicalPath = await original.realpath(...args);
        if (journalSplitStateGate.realpathCalls === 11) {
          journalSplitStateGate.markFinalPhysicalReady?.();
        }
        return physicalPath;
      }
      return original.realpath(...args);
    },
    async opendir(...args: Parameters<typeof original.opendir>) {
      const path = String(args[0]);
      if (
        appendRootGapGate.armed
        && path === join(appendRootGapGate.state!, "integration-records")
      ) {
        appendRootGapGate.enumerations += 1;
      }
      if (
        publicationGate.publishedPath !== null
        && path === dirname(publicationGate.publishedPath)
        && publicationOwnershipGate.laterReplacement !== null
        && !publicationOwnershipGate.laterTriggered
      ) {
        await original.rename(
          publicationGate.publishedPath,
          `${publicationGate.publishedPath}.owned-later`
        );
        await original.writeFile(
          publicationGate.publishedPath,
          publicationOwnershipGate.laterReplacement,
          { mode: 0o600 }
        );
        if (publicationOwnershipGate.laterMalformedName !== null) {
          await original.writeFile(
            join(path, publicationOwnershipGate.laterMalformedName),
            "not-json\n",
            { mode: 0o600 }
          );
        }
        publicationOwnershipGate.laterTriggered = true;
      }
      if (
        publicationGate.publishedPath !== null
        && path === publicationOwnershipGate.cleanupDirectory
        && publicationOwnershipGate.cleanupTarget !== null
      ) {
        publicationOwnershipGate.cleanupEnumerations += 1;
        const call = publicationOwnershipGate.cleanupEnumerations;
        const handle = await original.opendir(...args);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "read") {
              return async (...readArgs: unknown[]) => {
                const entry = await Reflect.apply(target.read, target, readArgs);
                if (entry === null && call === 2) {
                  publicationOwnershipGate.cleanupArmDirectoryLstat = true;
                }
                return entry;
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      if (path !== enumerationGate.directory) return original.opendir(...args);
      enumerationGate.calls += 1;
      const call = enumerationGate.calls;
      if (call === 2) {
        const before = enumerationGate.beforeSecondEnumeration;
        enumerationGate.beforeSecondEnumeration = null;
        await before?.();
      }
      const handle = await original.opendir(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              const entry = await Reflect.apply(target.read, target, readArgs);
              if (entry === null && call === 1) {
                const after = enumerationGate.afterEnumeration;
                enumerationGate.afterEnumeration = null;
                await after?.();
              }
              return entry;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    async open(...args: Parameters<typeof original.open>) {
      const path = String(args[0]);
      if (
        temporaryOpenGapGate.armed
        && !temporaryOpenGapGate.triggered
        && path.startsWith(`${join(temporaryOpenGapGate.state!, "integration-records")}/.`)
        && path.endsWith(".tmp")
      ) {
        const directory = dirname(path);
        await original.rename(directory, `${directory}.bound`);
        await original.mkdir(directory, { mode: 0o700 });
        await original.writeFile(join(directory, "sentinel"), "untouched\n", {
          mode: 0o600
        });
        temporaryOpenGapGate.triggered = true;
      }
      if (
        appendRootGapGate.armed
        && appendRootGapGate.swapped
        && path.startsWith(`${join(appendRootGapGate.state!, "integration-records")}/.`)
        && path.endsWith(".tmp")
      ) {
        appendRootGapGate.outsideTouched = true;
      }
      await replaceTargetBeforeRead(path);
      const handle = await original.open(...args);
      if (publicationGate.zeroTemporaryIdentity && path.endsWith(".tmp")) {
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "stat") {
              return async (...statArgs: unknown[]) => {
                const metadata = await Reflect.apply(target.stat, target, statArgs);
                return new Proxy(metadata, {
                  get(statTarget, statProperty, statReceiver) {
                    if (statProperty === "ino" || statProperty === "dev") {
                      return typeof statTarget.ino === "bigint" ? 0n : 0;
                    }
                    const value = Reflect.get(statTarget, statProperty, statReceiver);
                    return typeof value === "function" ? value.bind(statTarget) : value;
                  }
                });
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      if (
        publicationGate.ageTemporary
        && path.includes("integration-records")
        && path.endsWith(".tmp")
      ) {
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "sync") {
              return async () => {
                await target.sync();
                const oldTime = new Date("2000-01-01T00:00:00.000Z");
                await original.utimes(path, oldTime, oldTime);
                publicationGate.temporaryCtime = (
                  await original.stat(path, { bigint: true })
                ).ctimeNs;
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      if (
        readRaceGate.mode !== "replace-directory-after-read"
        || path !== readRaceGate.target
      ) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              const result = await Reflect.apply(target.read, target, readArgs);
              if (result.bytesRead > 0) await replaceDirectoryAfterRead();
              return result;
            };
          }
          if (property === "readFile") {
            return async (...readArgs: unknown[]) => {
              const result = await Reflect.apply(target.readFile, target, readArgs);
              await replaceDirectoryAfterRead();
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    async readFile(...args: Parameters<typeof original.readFile>) {
      const path = String(args[0]);
      await replaceTargetBeforeRead(path);
      const result = await original.readFile(...args);
      if (path === readRaceGate.target) await replaceDirectoryAfterRead();
      return result;
    },
    async rename(...args: Parameters<typeof original.rename>) {
      const [temporary, published] = args;
      const isPublicationRename = String(temporary).includes("integration-records")
        && String(temporary).endsWith(".tmp");
      let hardLinkNoOp = false;
      if (isPublicationRename && publicationGate.renameCollisionSource !== null) {
        publicationGate.publishedPath = String(published);
        const replacement = publicationGate.renameCollisionSource;
        publicationGate.renameCollisionSource = null;
        await original.writeFile(published, replacement, { mode: 0o600 });
        throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
      }
      if (isPublicationRename && publicationGate.hardLinkDestinationBeforeRename) {
        publicationGate.hardLinkDestinationBeforeRename = false;
        publicationGate.publishedPath = String(published);
        await original.link(temporary, published);
        hardLinkNoOp = true;
      }
      if (
        publicationGate.armed
        && isPublicationRename
      ) {
        publicationGate.armed = false;
        publicationGate.publishedPath = String(published);
        publicationGate.blocked?.();
        if (publicationGate.wait) await publicationGate.wait;
      }
      await original.rename(...args);
      if (isPublicationRename && publicationGate.renameSourceReplacement !== null) {
        const replacement = publicationGate.renameSourceReplacement;
        publicationGate.renameSourceReplacement = null;
        await original.writeFile(temporary, replacement, { mode: 0o600 });
      }
      if (hardLinkNoOp) {
        const [temporaryMetadata, publishedMetadata] = await Promise.all([
          original.lstat(temporary, { bigint: true }),
          original.lstat(published, { bigint: true })
        ]);
        publicationGate.hardLinkNoOpObserved = temporaryMetadata.dev === publishedMetadata.dev
          && temporaryMetadata.ino === publishedMetadata.ino;
      }
      const afterPublish = publicationGate.afterPublish;
      publicationGate.afterPublish = null;
      await afterPublish?.(String(published));
      if (publicationGate.throwAfterPublishRename && isPublicationRename) {
        publicationGate.throwAfterPublishRename = false;
        throw Object.assign(new Error("rename outcome unavailable"), { code: "EIO" });
      }
    },
    async unlink(...args: Parameters<typeof original.unlink>) {
      if (
        publicationGate.failOwnedUnlink
        && String(args[0]) === publicationGate.publishedPath
      ) {
        throw Object.assign(new Error("owned fragment unlink denied"), { code: "EACCES" });
      }
      return original.unlink(...args);
    }
  };
});

const writerFixtureSource = fileURLToPath(
  new URL("./fixtures/integration-writer.mjs", import.meta.url)
);
const readerFixtureSource = fileURLToPath(
  new URL("./fixtures/integration-reader.mjs", import.meta.url)
);
let fixtureDirectory = "";
let writerFixture = "";
let readerFixture = "";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "steward-store-fixtures-"));
  writerFixture = join(fixtureDirectory, "integration-writer.mjs");
  readerFixture = join(fixtureDirectory, "integration-reader.mjs");
  await Promise.all([
    build({
      entryPoints: [writerFixtureSource],
      outfile: writerFixture,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent"
    }),
    build({
      entryPoints: [readerFixtureSource],
      outfile: readerFixture,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent"
    })
  ]);
});

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

afterEach(() => {
  publicationGate.ageTemporary = false;
  publicationGate.armed = false;
  publicationGate.blocked = null;
  publicationGate.wait = null;
  publicationGate.publishedPath = null;
  publicationGate.temporaryCtime = null;
  publicationGate.afterPublish = null;
  publicationGate.failOwnedUnlink = false;
  publicationGate.hardLinkDestinationBeforeRename = false;
  publicationGate.hardLinkNoOpObserved = false;
  publicationGate.replaceRecordsAfterPublishedMetadata = false;
  publicationGate.recordsReplaced = false;
  publicationGate.renameCollisionSource = null;
  publicationGate.renameSourceReplacement = null;
  publicationGate.throwAfterPublishRename = false;
  publicationGate.zeroTemporaryIdentity = false;
  readRaceGate.mode = null;
  readRaceGate.target = null;
  readRaceGate.directory = null;
  readRaceGate.replacement = null;
  readRaceGate.pathLstatCalls = 0;
  readRaceGate.triggered = false;
  readRaceGate.zeroIdentityPath = null;
  stateSwapGate.armed = false;
  stateSwapGate.initialStateSamples = 0;
  stateSwapGate.legacyMissing = false;
  stateSwapGate.legacyReady = null;
  stateSwapGate.markLegacyReady = null;
  stateSwapGate.samplesReady = null;
  stateSwapGate.markSamplesReady = null;
  stateSwapGate.state = null;
  stateSwapGate.outside = null;
  stateSwapGate.swapped = false;
  journalSplitStateGate.armed = false;
  journalSplitStateGate.finalPhysicalReady = null;
  journalSplitStateGate.legacyWait = null;
  journalSplitStateGate.lstatCalls = 0;
  journalSplitStateGate.markFinalPhysicalReady = null;
  journalSplitStateGate.releaseLegacy = null;
  journalSplitStateGate.replacement = null;
  journalSplitStateGate.realpathCalls = 0;
  journalSplitStateGate.state = null;
  journalSplitStateGate.swapped = false;
  appendRootGapGate.armed = false;
  appendRootGapGate.enumerations = 0;
  appendRootGapGate.fragmentIdentityDone = false;
  appendRootGapGate.fragmentTerminalDone = false;
  appendRootGapGate.legacyDone = false;
  appendRootGapGate.legacyRealpaths = 0;
  appendRootGapGate.markSwapped = null;
  appendRootGapGate.markTerminalLstatReady = null;
  appendRootGapGate.outsideTouched = false;
  appendRootGapGate.replacement = null;
  appendRootGapGate.state = null;
  appendRootGapGate.swapped = false;
  appendRootGapGate.swappedReady = null;
  appendRootGapGate.terminalLstatReady = null;
  publicationOwnershipGate.cleanupArmDirectoryLstat = false;
  publicationOwnershipGate.cleanupDirectory = null;
  publicationOwnershipGate.cleanupDirectorySamples = 0;
  publicationOwnershipGate.cleanupEnumerations = 0;
  publicationOwnershipGate.cleanupReplacement = null;
  publicationOwnershipGate.cleanupTarget = null;
  publicationOwnershipGate.cleanupTriggered = false;
  publicationOwnershipGate.laterMalformedName = null;
  publicationOwnershipGate.laterReplacement = null;
  publicationOwnershipGate.laterTriggered = false;
  postValidationJournalGate.armed = false;
  postValidationJournalGate.fragmentSource = null;
  postValidationJournalGate.mode = null;
  postValidationJournalGate.state = null;
  postValidationJournalGate.triggered = false;
  temporaryOpenGapGate.armed = false;
  temporaryOpenGapGate.state = null;
  temporaryOpenGapGate.triggered = false;
  enumerationGate.afterEnumeration = null;
  enumerationGate.beforeSecondEnumeration = null;
  enumerationGate.calls = 0;
  enumerationGate.directory = null;
  enumerationGate.fixedCtimeNs = null;
  enumerationGate.fixedMtimeNs = null;
});

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function writer(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerFixture, ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

function reader(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [readerFixture, ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`reader exited ${code}: ${stderr}`)));
  });
}

function record(id: string, createdAt: string): IntegrationRecordV1 {
  return {
    schemaVersion: 1,
    id,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: "/tmp/home/.codex/hooks.json",
    backupPath: "/tmp/home/.codex/hooks.backup.json",
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    createdAt
  };
}

function recordV2(
  id: string,
  createdAt: string,
  overrides: Partial<IntegrationRecordV2> = {}
): IntegrationRecordV2 {
  return {
    schemaVersion: 2,
    id,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: "/tmp/home/.codex/hooks.json",
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    companion: {
      action: "upgrade",
      path: "/tmp/home/.agents/skills/skill-steward-preflight",
      before: {
        state: "exact",
        fingerprint: `sha256:${"d".repeat(64)}`
      },
      after: { state: "exact", fingerprint: `sha256:${"e".repeat(64)}` },
      source: { fingerprint: `sha256:${"e".repeat(64)}` },
      proof: { category: "recorded" },
      installedFingerprint: `sha256:${"e".repeat(64)}`,
      consumers: ["claude-code", "codex"]
    },
    trigger: {
      planId: `plan-${id}`,
      harness: "codex",
      createdAt
    },
    createdAt,
    ...overrides
  };
}

function removalRecordV2(
  id: string,
  transition: "retain" | "remove"
): IntegrationRecordV2 {
  const createdAt = "2026-07-03T02:00:00.000Z";
  return {
    ...recordV2(id, createdAt),
    action: "remove",
    status: "removed",
    companion: {
      action: transition,
      path: "/tmp/home/.agents/skills/skill-steward-preflight",
      before: { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` },
      after: transition === "retain"
        ? { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` }
        : { state: "absent" },
      source: { fingerprint: `sha256:${"e".repeat(64)}` },
      proof: { category: "recorded" },
      installedFingerprint: `sha256:${"d".repeat(64)}`,
      consumers: transition === "retain" ? ["claude-code"] : []
    }
  } as IntegrationRecordV2;
}

describe("integration store", () => {
  it("runs child-process fixtures from current source instead of package dist", async () => {
    for (const fixture of [readerFixtureSource, writerFixtureSource]) {
      const source = await readFile(fixture, "utf8");
      expect(source).toContain("../../src/integration-store.ts");
      expect(source).not.toContain("../../dist/");
    }
  });
  it("writes private bounded records and returns the latest Harness record", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-store-"));
    await appendIntegrationRecord(state, record("one", "2026-07-03T00:00:00.000Z"), { limit: 2 });
    await appendIntegrationRecord(state, record("two", "2026-07-03T01:00:00.000Z"), { limit: 2 });
    await appendIntegrationRecord(state, record("three", "2026-07-03T02:00:00.000Z"), { limit: 2 });
    const records = await readIntegrationRecords(state);
    expect(records.map(({ id }) => id)).toEqual(["three", "two"]);
    const fragments = await readdir(join(state, "integration-records"));
    expect(fragments.length).toBe(3);
    if (process.platform !== "win32") {
      await expect(Promise.all(fragments.map(async (file) =>
        (await stat(join(state, "integration-records", file))).mode & 0o777
      ))).resolves.toEqual([0o600, 0o600, 0o600]);
    }
  });

  it("keeps concurrent pure-reader snapshots unchanged", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-pure-readers-"));
    await appendIntegrationRecord(
      state,
      record("stable", "2026-07-03T00:00:00.000Z")
    );

    const snapshots = await Promise.all(Array.from({ length: 20 }, async () => {
      const changed: boolean[] = [];
      for (let index = 0; index < 100; index += 1) {
        changed.push((await readIntegrationRecordJournal(state)).changedDuringRead);
      }
      return changed;
    }));

    expect(snapshots.flat().every((changed) => changed === false)).toBe(true);
  }, 30_000);

  it("orders same-process apply then remove when domain timestamps are fixed", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-order-"));
    const createdAt = "2026-07-03T00:00:00.000Z";
    await appendIntegrationRecord(state, record("apply", createdAt));
    await appendIntegrationRecord(state, {
      ...record("remove", createdAt),
      action: "remove",
      status: "removed"
    });
    await expect(latestIntegrationRecord(state, "codex")).resolves.toMatchObject({
      id: "remove",
      status: "removed"
    });
  });

  it("merges legacy JSON records behind newly committed fragments", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-"));
    const legacy = record("legacy", "2026-07-03T00:00:00.000Z");
    await writeFile(join(state, "integrations.json"), `${JSON.stringify({
      schemaVersion: 1,
      records: [legacy]
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await appendIntegrationRecord(
      state,
      record("fragment", "2026-07-03T01:00:00.000Z")
    );
    expect((await readIntegrationRecords(state)).map(({ id }) => id))
      .toEqual(["fragment", "legacy"]);
  });

  it("coexists with v1 in one ordered journal without rewriting legacy bytes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-v2-order-"));
    const legacy = record("legacy-v1", "2026-07-03T00:00:00.000Z");
    const legacySource = `${JSON.stringify({
      schemaVersion: 1,
      records: [legacy]
    }, null, 4)}\n`;
    const legacyPath = join(state, "integrations.json");
    await writeFile(legacyPath, legacySource, { encoding: "utf8", mode: 0o600 });

    const current = recordV2("current-v2", "2026-07-03T01:00:00.000Z");
    await appendIntegrationRecord(state, current);

    await expect(readIntegrationRecords(state)).resolves.toEqual([current, legacy]);
    await expect(latestIntegrationRecord(state, "codex")).resolves.toEqual(current);
    await expect(readFile(legacyPath, "utf8")).resolves.toBe(legacySource);
    const [fragmentName] = await readdir(join(state, "integration-records"));
    const fragment = JSON.parse(await readFile(
      join(state, "integration-records", fragmentName!),
      "utf8"
    ));
    expect(fragment).toMatchObject({ schemaVersion: 2, record: { schemaVersion: 2 } });
  });

  it("rejects one ID reused across v1 and v2 before deduplication", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-cross-version-id-"));
    const original = recordV2("reused-record-id", "2026-07-03T01:00:00.000Z");
    await appendIntegrationRecord(
      state,
      original
    );
    publicationGate.armed = true;
    await expect(appendIntegrationRecord(
      state,
      record("reused-record-id", "2026-07-03T02:00:00.000Z")
    )).rejects.toThrow("Integration record ID cannot be reused across schema versions");

    expect(publicationGate.publishedPath).toBeNull();
    await expect(readIntegrationRecords(state)).resolves.toEqual([original]);
  });

  it("rejects extra, unsorted, duplicate, and contradictory v2 lifecycle evidence", async () => {
    const createdAt = "2026-07-03T01:00:00.000Z";
    const valid = recordV2("strict-v2", createdAt);
    const invalid: unknown[] = [
      { ...valid, unexpected: true },
      {
        ...valid,
        companion: { ...valid.companion, consumers: ["codex", "claude-code"] }
      },
      {
        ...valid,
        companion: { ...valid.companion, consumers: ["codex", "codex"] }
      },
      {
        ...valid,
        trigger: { ...valid.trigger, harness: "claude-code" }
      },
      {
        ...valid,
        trigger: { ...valid.trigger, createdAt: "2026-07-03T01:00:01.000Z" }
      },
      {
        ...valid,
        companion: {
          ...valid.companion,
          action: "create",
          proof: { category: "new" }
        }
      },
      {
        ...valid,
        companion: {
          ...valid.companion,
          action: "none",
          proof: { category: "recorded" }
        }
      },
      {
        ...valid,
        companion: {
          ...valid.companion,
          proof: { category: "new" }
        }
      },
      {
        ...valid,
        companion: {
          ...valid.companion,
          source: { fingerprint: `sha256:${"f".repeat(64)}` }
        }
      },
      {
        ...valid,
        companion: { ...valid.companion, path: "relative/companion" }
      }
    ];

    for (const [index, candidate] of invalid.entries()) {
      const state = await mkdtemp(join(tmpdir(), `steward-integration-v2-invalid-${index}-`));
      await expect(appendIntegrationRecord(
        state,
        candidate as IntegrationRecord
      )).rejects.toBeDefined();
      await expect(access(join(state, "integration-records")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("represents retained-consumer and final-removal transitions without enabling product writes", async () => {
    const retainedState = await mkdtemp(join(tmpdir(), "steward-integration-v2-retain-"));
    const retained = removalRecordV2("retained", "retain");
    await appendIntegrationRecord(retainedState, retained);
    await expect(readIntegrationRecords(retainedState)).resolves.toEqual([retained]);

    const removedState = await mkdtemp(join(tmpdir(), "steward-integration-v2-remove-"));
    const removed = removalRecordV2("removed", "remove");
    await appendIntegrationRecord(removedState, removed);
    await expect(readIntegrationRecords(removedState)).resolves.toEqual([removed]);

    const contradictory: IntegrationRecordV2[] = [
      {
        ...retained,
        companion: { ...retained.companion, consumers: ["codex"] }
      },
      {
        ...removed,
        companion: { ...removed.companion, consumers: ["claude-code"] }
      },
      {
        ...removed,
        companion: {
          ...removed.companion,
          after: { state: "exact", fingerprint: removed.companion.installedFingerprint }
        }
      },
      {
        ...recordV2("apply-retain", "2026-07-03T02:00:00.000Z"),
        companion: retained.companion
      }
    ];
    for (const [index, candidate] of contradictory.entries()) {
      const state = await mkdtemp(join(tmpdir(), `steward-integration-v2-remove-invalid-${index}-`));
      await expect(appendIntegrationRecord(state, candidate)).rejects.toBeDefined();
    }
  });

  it("rejects a v2 record wrapped in a v1 fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-v2-fragment-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, `1-${process.pid}-000000000001-55555555-5555-4555-8555-555555555555.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        limit: 100,
        record: recordV2("wrong-wrapper", "2026-07-03T01:00:00.000Z")
      })}\n`,
      { mode: 0o600 }
    );

    await expect(readIntegrationRecords(state)).rejects.toBeDefined();
  });

  it("keeps v1 strict without changing valid historical bytes", async () => {
    const contradictory = {
      ...record("contradictory-v1", "2026-07-03T01:00:00.000Z"),
      status: "removed" as const
    };
    const extra = {
      ...record("extra-v1", "2026-07-03T01:00:00.000Z"),
      companionFingerprint: `sha256:${"f".repeat(64)}`
    };
    for (const [index, candidate] of [contradictory, extra].entries()) {
      const state = await mkdtemp(join(tmpdir(), `steward-integration-v1-strict-${index}-`));
      await expect(appendIntegrationRecord(
        state,
        candidate as IntegrationRecord
      )).rejects.toBeDefined();
      await expect(access(join(state, "integration-records")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("validates the legacy journal before publishing a fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-bad-legacy-"));
    await writeFile(join(state, "integrations.json"), "not-json\n", "utf8");

    await expect(appendIntegrationRecord(
      state,
      record("not-published", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    await expect(access(join(state, "integration-records")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized serialized record before creating state", async () => {
    const parent = await mkdtemp(join(tmpdir(), "steward-integration-oversized-append-"));
    const state = join(parent, "state");
    const oversized = {
      ...record("oversized-append", "2026-07-03T00:00:00.000Z"),
      targetPath: `/tmp/${"x".repeat(1024 * 1024)}`
    };

    await expect(appendIntegrationRecord(state, oversized)).rejects.toThrow(
      "exceeds the byte limit"
    );
    await expect(access(state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a static legacy journal symlink instead of reading outside state", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-link-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-integration-legacy-outside-"));
    const outsidePath = join(outside, "integrations.json");
    await writeFile(outsidePath, `${JSON.stringify({
      schemaVersion: 1,
      records: [record("outside", "2026-07-03T00:00:00.000Z")]
    })}\n`, { mode: 0o600 });
    await symlink(outsidePath, join(state, "integrations.json"));

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Legacy integration journal must be a regular file"
    );
  });

  it("rejects deterministic legacy target replacement between lstat and open", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-swap-"));
    const target = join(state, "integrations.json");
    await writeFile(target, `${JSON.stringify({
      schemaVersion: 1,
      records: [record("original", "2026-07-03T00:00:00.000Z")]
    })}\n`, { mode: 0o600 });
    readRaceGate.mode = "replace-target-before-read";
    readRaceGate.target = target;
    readRaceGate.replacement = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      records: [record("replacement", "2026-07-03T01:00:00.000Z")]
    })}\n`);
    readRaceGate.triggered = false;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Legacy integration journal changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
    readRaceGate.mode = null;
  });

  it("does not reinterpret a sampled legacy journal deletion as initial absence", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-delete-"));
    const target = join(state, "integrations.json");
    await writeFile(target, `${JSON.stringify({
      schemaVersion: 1,
      records: [record("sampled", "2026-07-03T00:00:00.000Z")]
    })}\n`, { mode: 0o600 });
    readRaceGate.mode = "remove-target-before-read";
    readRaceGate.target = target;
    readRaceGate.triggered = false;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Legacy integration journal changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
  });

  it("rejects replacement of the state directory after reading the legacy journal", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-parent-swap-"));
    const target = join(state, "integrations.json");
    await writeFile(target, `${JSON.stringify({
      schemaVersion: 1,
      records: [record("original", "2026-07-03T00:00:00.000Z")]
    })}\n`, { mode: 0o600 });
    readRaceGate.mode = "replace-directory-after-read";
    readRaceGate.target = target;
    readRaceGate.directory = state;
    readRaceGate.triggered = false;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration state directory changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
    readRaceGate.mode = null;
  });

  it("rejects malformed UTF-8 and oversized legacy journal bytes", async () => {
    const invalidState = await mkdtemp(join(tmpdir(), "steward-integration-legacy-utf8-"));
    const prefix = Buffer.from('{"schemaVersion":1,"records":[{"schemaVersion":1,"id":"');
    const suffix = Buffer.from(`","harness":"codex","action":"apply","status":"installed","targetPath":"/tmp/home/.codex/hooks.json","beforeFingerprint":"sha256:${"a".repeat(64)}","afterFingerprint":"sha256:${"b".repeat(64)}","installedEntryFingerprint":"sha256:${"c".repeat(64)}","createdAt":"2026-07-03T00:00:00.000Z"}]}\n`);
    await writeFile(
      join(invalidState, "integrations.json"),
      Buffer.concat([prefix, Buffer.from([0xff]), suffix]),
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(invalidState)).rejects.toThrow(
      "Legacy integration journal must contain valid UTF-8"
    );

    const oversizedState = await mkdtemp(join(tmpdir(), "steward-integration-legacy-large-"));
    await writeFile(
      join(oversizedState, "integrations.json"),
      `${JSON.stringify({ schemaVersion: 1, records: [] })}${" ".repeat(2 * 1024 * 1024)}\n`,
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(oversizedState)).rejects.toThrow(
      "Legacy integration journal exceeds the byte limit"
    );
  });

  it("refuses directory and unreadable legacy journals before publishing", async () => {
    const directoryState = await mkdtemp(join(tmpdir(), "steward-integration-dir-legacy-"));
    await mkdir(join(directoryState, "integrations.json"));
    await expect(appendIntegrationRecord(
      directoryState,
      record("directory-legacy", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    await expect(access(join(directoryState, "integration-records")))
      .rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform !== "win32") {
      const unreadableState = await mkdtemp(join(tmpdir(), "steward-integration-mode-legacy-"));
      const legacyPath = join(unreadableState, "integrations.json");
      await writeFile(legacyPath, '{"schemaVersion":1,"records":[]}\n', "utf8");
      await chmod(legacyPath, 0o000);
      try {
        await expect(appendIntegrationRecord(
          unreadableState,
          record("unreadable-legacy", "2026-07-03T00:00:00.000Z")
        )).rejects.toMatchObject({ code: "EACCES" });
        await expect(access(join(unreadableState, "integration-records")))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await chmod(legacyPath, 0o600);
      }
    }
  });

  it("secures the fragment directory and refuses unsafe storage paths", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-private-"));
    const recordsDirectory = join(state, "integration-records");
    await mkdir(recordsDirectory, { mode: 0o755 });
    await appendIntegrationRecord(state, record("private", "2026-07-03T00:00:00.000Z"));
    if (process.platform !== "win32") {
      expect((await stat(recordsDirectory)).mode & 0o777).toBe(0o700);
    }

    const symlinkState = await mkdtemp(join(tmpdir(), "steward-integration-link-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-integration-outside-"));
    await symlink(
      outside,
      join(symlinkState, "integration-records"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(readIntegrationRecords(symlinkState)).rejects.toBeDefined();
    await expect(appendIntegrationRecord(
      symlinkState,
      record("escaped", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual([]);

    const fileState = await mkdtemp(join(tmpdir(), "steward-integration-file-"));
    await writeFile(join(fileState, "integration-records"), "not a directory", "utf8");
    await expect(appendIntegrationRecord(
      fileState,
      record("blocked", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
  });

  it("binds the state root across legacy absence and records access", async () => {
    for (const platform of [process.platform, "win32"] as NodeJS.Platform[]) {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-state-root-"));
      const outside = await mkdtemp(join(tmpdir(), "steward-integration-state-outside-"));
      await appendIntegrationRecord(
        outside,
        record("outside-record", "2026-07-03T00:00:00.000Z")
      );
      let markSamplesReady!: () => void;
      let markLegacyReady!: () => void;
      stateSwapGate.samplesReady = new Promise<void>((resolve) => {
        markSamplesReady = resolve;
      });
      stateSwapGate.legacyReady = new Promise<void>((resolve) => {
        markLegacyReady = resolve;
      });
      stateSwapGate.markSamplesReady = markSamplesReady;
      stateSwapGate.markLegacyReady = markLegacyReady;
      stateSwapGate.state = state;
      stateSwapGate.outside = outside;
      stateSwapGate.armed = true;
      const store = createIntegrationRecordStore({ platform });

      await expect(store.readIntegrationRecords(state)).rejects.toThrow(
        "Integration state directory changed during the operation"
      );
      expect(stateSwapGate.swapped).toBe(true);

      stateSwapGate.armed = false;
      stateSwapGate.initialStateSamples = 0;
      stateSwapGate.legacyMissing = false;
      stateSwapGate.state = null;
      stateSwapGate.outside = null;
      stateSwapGate.swapped = false;
    }
  });

  it("uses one state-root proof across parallel legacy and fragment branches", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-common-root-"));
    await mkdir(join(state, "integration-records"), { mode: 0o700 });
    const replacement = await mkdtemp(join(
      tmpdir(),
      "steward-integration-common-root-replacement-"
    ));
    await writeFile(join(replacement, "integrations.json"), `${JSON.stringify({
      schemaVersion: 1,
      records: [record("replacement-legacy", "2026-07-03T00:00:00.000Z")]
    })}\n`, { mode: 0o600 });
    let releaseLegacy!: () => void;
    let markFinalPhysicalReady!: () => void;
    journalSplitStateGate.legacyWait = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    journalSplitStateGate.finalPhysicalReady = new Promise<void>((resolve) => {
      markFinalPhysicalReady = resolve;
    });
    journalSplitStateGate.releaseLegacy = releaseLegacy;
    journalSplitStateGate.markFinalPhysicalReady = markFinalPhysicalReady;
    journalSplitStateGate.state = state;
    journalSplitStateGate.replacement = replacement;
    journalSplitStateGate.armed = true;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration state directory changed during the operation"
    );
    expect(journalSplitStateGate.swapped).toBe(true);
  }, 10_000);

  it.each(["malformed fragment", "cross-version duplicate"])(
    "keeps one publication proof across prevalidation with a %s replacement root",
    async (replacementKind) => {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-append-root-"));
      await appendIntegrationRecord(
        state,
        record("validated-fragment", "2026-07-03T00:00:00.000Z")
      );
      await writeFile(join(state, "integrations.json"), `${JSON.stringify({
        schemaVersion: 1,
        records: [record("validated-legacy", "2026-07-03T00:01:00.000Z")]
      })}\n`, { mode: 0o600 });

      const replacement = await mkdtemp(join(
        tmpdir(),
        "steward-integration-append-root-replacement-"
      ));
      const replacementRecords = join(replacement, "integration-records");
      await mkdir(replacementRecords, { mode: 0o700 });
      await writeFile(join(replacementRecords, "sentinel"), "untouched\n", { mode: 0o600 });
      if (replacementKind === "malformed fragment") {
        await writeFile(join(
          replacementRecords,
          `1-${process.pid}-000000000001-11111111-1111-4111-8111-111111111111.json`
        ), "not-json\n", { mode: 0o600 });
      } else {
        const duplicateV1 = record("replacement-duplicate", "2026-07-03T00:02:00.000Z");
        const duplicateV2 = recordV2(
          "replacement-duplicate",
          "2026-07-03T00:03:00.000Z"
        );
        await writeFile(join(replacement, "integrations.json"), `${JSON.stringify({
          schemaVersion: 1,
          records: [duplicateV1]
        })}\n`, { mode: 0o600 });
        await writeFile(join(
          replacementRecords,
          `1-${process.pid}-000000000001-22222222-2222-4222-8222-222222222222.json`
        ), `${JSON.stringify({
          schemaVersion: 2,
          limit: 100,
          record: duplicateV2
        })}\n`, { mode: 0o600 });
      }

      let markTerminalLstatReady!: () => void;
      let markSwapped!: () => void;
      appendRootGapGate.terminalLstatReady = new Promise<void>((resolve) => {
        markTerminalLstatReady = resolve;
      });
      appendRootGapGate.swappedReady = new Promise<void>((resolve) => {
        markSwapped = resolve;
      });
      appendRootGapGate.markTerminalLstatReady = markTerminalLstatReady;
      appendRootGapGate.markSwapped = markSwapped;
      appendRootGapGate.state = state;
      appendRootGapGate.replacement = replacement;
      appendRootGapGate.armed = true;

      await expect(appendIntegrationRecord(
        state,
        record("must-not-publish", "2026-07-03T00:04:00.000Z")
      )).rejects.toBeDefined();
      expect(appendRootGapGate.swapped).toBe(true);
      expect(appendRootGapGate.outsideTouched).toBe(false);
      await expect(readFile(join(state, "integration-records", "sentinel"), "utf8"))
        .resolves.toBe("untouched\n");
    },
    10_000
  );

  it.each(["records", "legacy"] as const)(
    "revalidates the complete %s journal after acquiring publication storage",
    async (mode) => {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-post-validation-"));
      const duplicateV1 = record("post-validation-duplicate", "2026-07-03T00:00:00.000Z");
      await writeFile(join(state, "integrations.json"), `${JSON.stringify({
        schemaVersion: 1,
        records: [duplicateV1]
      })}\n`, { mode: 0o600 });
      postValidationJournalGate.mode = mode;
      postValidationJournalGate.state = state;
      if (mode === "records") {
        const duplicateV2 = recordV2(
          "post-validation-duplicate",
          "2026-07-03T00:01:00.000Z"
        );
        postValidationJournalGate.fragmentSource = Buffer.from(`${JSON.stringify({
          schemaVersion: 2,
          limit: 100,
          record: duplicateV2
        })}\n`);
      }
      postValidationJournalGate.armed = true;

      await expect(appendIntegrationRecord(
        state,
        record("must-not-survive-revalidation", "2026-07-03T00:02:00.000Z")
      )).rejects.toBeDefined();
      expect(postValidationJournalGate.triggered).toBe(true);
      const files = await readdir(join(state, "integration-records"));
      expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
      const sources = await Promise.all(files.filter((file) => file.endsWith(".json"))
        .map((file) => readFile(join(state, "integration-records", file), "utf8")));
      expect(sources.every((source) => !source.includes("must-not-survive-revalidation")))
        .toBe(true);
      if (mode === "records") {
        await expect(readFile(join(state, "integration-records", "sentinel"), "utf8"))
          .resolves.toBe("untouched\n");
      }
    }
  );

  it("validates an opened temporary parent before writing journal bytes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-temp-parent-"));
    await appendIntegrationRecord(
      state,
      record("temp-parent-seed", "2026-07-03T00:00:00.000Z")
    );
    temporaryOpenGapGate.state = state;
    temporaryOpenGapGate.armed = true;

    await expect(appendIntegrationRecord(
      state,
      record("sensitive-temp-payload", "2026-07-03T00:01:00.000Z")
    )).rejects.toBeDefined();
    expect(temporaryOpenGapGate.triggered).toBe(true);
    expect(await readdir(join(state, "integration-records"))).toEqual(["sentinel"]);
    await expect(readFile(join(state, "integration-records", "sentinel"), "utf8"))
      .resolves.toBe("untouched\n");
  });

  it("uses Windows-compatible containment without POSIX flags or mode equality", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-windows-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const existing = record("windows-existing", "2026-07-03T00:00:00.000Z");
    const existingPath = join(
      directory,
      `1-${process.pid}-000000000001-44444444-4444-4444-8444-444444444444.json`
    );
    await writeFile(
      existingPath,
      `${JSON.stringify({ schemaVersion: 1, limit: 100, record: existing })}\n`,
      { mode: 0o644 }
    );
    await chmod(existingPath, 0o644);
    const inheritedMode = (await stat(directory)).mode & 0o777;
    const windowsStore = createIntegrationRecordStore({ platform: "win32" });

    await expect(windowsStore.readIntegrationRecords(state)).resolves.toEqual([existing]);
    const windowsV2 = recordV2("windows-appended", "2026-07-03T01:00:00.000Z");
    await windowsStore.appendIntegrationRecord(
      state,
      windowsV2
    );
    await expect(windowsStore.latestIntegrationRecord(state, "codex"))
      .resolves.toEqual(windowsV2);
    expect((await stat(directory)).mode & 0o777).toBe(inheritedMode);

    const linkedState = await mkdtemp(join(tmpdir(), "steward-integration-windows-link-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-integration-windows-outside-"));
    await symlink(
      outside,
      join(linkedState, "integration-records"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(windowsStore.readIntegrationRecords(linkedState)).rejects.toBeDefined();
  });

  it("does not compensate a temporary through unprovable Windows identity", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-windows-temp-identity-"));
    const windowsStore = createIntegrationRecordStore({ platform: "win32" });
    publicationGate.zeroTemporaryIdentity = true;

    await expect(windowsStore.appendIntegrationRecord(
      state,
      record("windows-zero-temp", "2026-07-03T00:00:00.000Z")
    )).rejects.toThrow("identity cannot be proven");
    const files = await readdir(join(state, "integration-records"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\..+\.tmp$/);
    await expect(readFile(join(state, "integration-records", files[0]!)))
      .resolves.toHaveLength(0);
  });

  it("uses opened identity to reject a Windows-path fragment replacement", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-windows-swap-"));
    const windowsStore = createIntegrationRecordStore({ platform: "win32" });
    await windowsStore.appendIntegrationRecord(
      state,
      record("windows-original", "2026-07-03T00:00:00.000Z")
    );
    const directory = join(state, "integration-records");
    const [fileName] = await readdir(directory);
    const target = join(directory, fileName!);
    readRaceGate.mode = "replace-target-before-read";
    readRaceGate.target = target;
    readRaceGate.replacement = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("windows-replacement", "2026-07-03T01:00:00.000Z")
    })}\n`);
    readRaceGate.triggered = false;

    await expect(windowsStore.readIntegrationRecords(state)).rejects.toThrow(
      "Integration record fragment changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
  });

  it("fails closed when Windows state or records directory identity is unavailable", async () => {
    for (const boundary of ["state", "records"] as const) {
      const state = await mkdtemp(join(tmpdir(), `steward-integration-windows-${boundary}-zero-`));
      const windowsStore = createIntegrationRecordStore({ platform: "win32" });
      await windowsStore.appendIntegrationRecord(
        state,
        record(`windows-${boundary}`, "2026-07-03T00:00:00.000Z")
      );
      readRaceGate.zeroIdentityPath = boundary === "state"
        ? state
        : join(state, "integration-records");

      await expect(windowsStore.readIntegrationRecords(state)).rejects.toThrow(
        "Integration directory identity cannot be proven on this platform"
      );
      readRaceGate.zeroIdentityPath = null;
    }
  });

  it("does not hide malformed recognized fragments", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-corrupt-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, `1-${process.pid}-000000000001-00000000-0000-0000-0000-000000000000.json`),
      "not-json\n",
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(state)).rejects.toBeDefined();
  });

  it("rejects a recognized fragment symlink instead of silently ignoring it", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-fragment-link-"));
    const directory = join(state, "integration-records");
    const outside = await mkdtemp(join(tmpdir(), "steward-integration-fragment-outside-"));
    const outsidePath = join(outside, "record.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(outsidePath, `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("outside", "2026-07-03T00:00:00.000Z")
    })}\n`, { mode: 0o600 });
    await symlink(
      outsidePath,
      join(directory, `1-${process.pid}-000000000001-66666666-6666-4666-8666-666666666666.json`)
    );

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record fragment must be a regular file"
    );
  });

  it("rejects deterministic fragment replacement between lstat and open", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-fragment-swap-"));
    await appendIntegrationRecord(
      state,
      record("original", "2026-07-03T00:00:00.000Z")
    );
    const [fileName] = await readdir(join(state, "integration-records"));
    const target = join(state, "integration-records", fileName!);
    readRaceGate.mode = "replace-target-before-read";
    readRaceGate.target = target;
    readRaceGate.replacement = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("replacement", "2026-07-03T01:00:00.000Z")
    })}\n`);
    readRaceGate.triggered = false;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record fragment changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
    readRaceGate.mode = null;
  });

  it.each([
    "remove-target-during-path-revalidation",
    "remove-target-during-final-identity"
  ] as const)("retries ordinary cleanup observed during %s", async (mode) => {
    const state = await mkdtemp(join(tmpdir(), `steward-integration-${mode}-`));
    await appendIntegrationRecord(
      state,
      record("cleanup-race", "2026-07-03T00:00:00.000Z")
    );
    const directory = join(state, "integration-records");
    const [fileName] = await readdir(directory);
    readRaceGate.mode = mode;
    readRaceGate.target = join(directory, fileName!);

    const journal = await readIntegrationRecordJournal(state);

    expect(readRaceGate.triggered).toBe(true);
    expect(journal.changedDuringRead).toBe(true);
    expect(journal.records).toEqual([]);
  });

  it("rejects replacement of the records directory after reading a fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-fragment-parent-swap-"));
    await appendIntegrationRecord(
      state,
      record("original", "2026-07-03T00:00:00.000Z")
    );
    const directory = join(state, "integration-records");
    const [fileName] = await readdir(directory);
    readRaceGate.mode = "replace-directory-after-read";
    readRaceGate.target = join(directory, fileName!);
    readRaceGate.directory = directory;
    readRaceGate.triggered = false;

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record directory changed during the operation"
    );
    expect(readRaceGate.triggered).toBe(true);
    readRaceGate.mode = null;
  });

  it("rejects malformed UTF-8 and oversized recognized fragment bytes", async () => {
    const invalidState = await mkdtemp(join(tmpdir(), "steward-integration-fragment-utf8-"));
    const invalidDirectory = join(invalidState, "integration-records");
    await mkdir(invalidDirectory, { mode: 0o700 });
    const valid = JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("invalid-byte", "2026-07-03T00:00:00.000Z")
    });
    const marker = valid.indexOf("invalid-byte");
    await writeFile(
      join(invalidDirectory, `1-${process.pid}-000000000001-77777777-7777-4777-8777-777777777777.json`),
      Buffer.concat([
        Buffer.from(valid.slice(0, marker)),
        Buffer.from([0xff]),
        Buffer.from(valid.slice(marker + "invalid-byte".length))
      ]),
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(invalidState)).rejects.toThrow(
      "Integration record fragment must contain valid UTF-8"
    );

    const oversizedState = await mkdtemp(join(tmpdir(), "steward-integration-fragment-large-"));
    const oversizedDirectory = join(oversizedState, "integration-records");
    await mkdir(oversizedDirectory, { mode: 0o700 });
    await writeFile(
      join(oversizedDirectory, `1-${process.pid}-000000000001-88888888-8888-4888-8888-888888888888.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        limit: 100,
        record: record("large", "2026-07-03T00:00:00.000Z")
      })}${" ".repeat(2 * 1024 * 1024)}\n`,
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(oversizedState)).rejects.toThrow(
      "Integration record fragment exceeds the byte limit"
    );
  });

  it("bounds total directory entries before collecting fragment names", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-entry-bound-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(join(directory, `junk-${String(index).padStart(3, "0")}`), "", { mode: 0o600 })
    ));

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record directory exceeds the entry limit"
    );
  });

  it("bounds recognized fragments before starting content reads", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-fragment-bound-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      writeFile(
        join(
          directory,
          `1-1-${String(index + 1).padStart(12, "0")}-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.json`
        ),
        "not-json\n",
        { mode: 0o600 }
      )
    ));

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record directory exceeds the fragment limit"
    );
  });

  it("retries when a second bounded enumeration sees additions despite unchanged times", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-set-retry-"));
    await appendIntegrationRecord(
      state,
      record("original", "2026-07-03T00:00:00.000Z")
    );
    const directory = join(state, "integration-records");
    const metadata = await stat(directory, { bigint: true });
    enumerationGate.directory = directory;
    enumerationGate.fixedCtimeNs = metadata.ctimeNs;
    enumerationGate.fixedMtimeNs = metadata.mtimeNs;
    enumerationGate.afterEnumeration = async () => {
      await Promise.all(["addition-a", "addition-b"].map((id, index) =>
        writeFile(
          join(
            directory,
            `9999999999999-1-${String(index + 1).padStart(12, "0")}-aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}.json`
          ),
          `${JSON.stringify({
            schemaVersion: 1,
            limit: 100,
            record: record(id, `2026-07-03T00:0${index + 1}:00.000Z`)
          })}\n`,
          { mode: 0o600 }
        )
      ));
    };

    const journal = await readIntegrationRecordJournal(state);
    expect(journal.changedDuringRead).toBe(true);
    expect(journal.records.map(({ id }) => id)).toHaveLength(3);
    expect(journal.records.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "addition-a",
      "addition-b",
      "original"
    ]));
    expect(enumerationGate.calls).toBeGreaterThanOrEqual(4);
  });

  it("rejects same-name replacement after the second name-set sample", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-final-identity-"));
    await appendIntegrationRecord(
      state,
      record("original", "2026-07-03T00:00:00.000Z")
    );
    const directory = join(state, "integration-records");
    const [fileName] = await readdir(directory);
    const target = join(directory, fileName!);
    enumerationGate.directory = directory;
    enumerationGate.afterEnumeration = async () => {
      await writeFile(join(directory, ".snapshot-jitter"), "jitter\n", { mode: 0o600 });
    };
    enumerationGate.beforeSecondEnumeration = async () => {
      await rename(target, `${target}.original`);
      await writeFile(target, `${JSON.stringify({
        schemaVersion: 1,
        limit: 100,
        record: record("replacement", "2026-07-03T00:01:00.000Z")
      })}\n`, { mode: 0o600 });
    };

    await expect(readIntegrationRecords(state)).rejects.toThrow(
      "Integration record fragment changed during the operation"
    );
    expect(enumerationGate.calls).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "rejects broadly readable fragments on POSIX",
    async () => {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-fragment-mode-"));
      await appendIntegrationRecord(
        state,
        record("private-mode", "2026-07-03T00:00:00.000Z")
      );
      const directory = join(state, "integration-records");
      const [fragment] = await readdir(directory);
      await chmod(join(directory, fragment!), 0o644);

      await expect(readIntegrationRecords(state)).rejects.toThrow(
        "Integration record fragment must have private permissions"
      );
    }
  );

  it("bounds immutable fragment storage to the newest 100 records", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-bound-"));
    for (let index = 0; index < 105; index += 1) {
      await appendIntegrationRecord(
        state,
        recordV2(
          `record-${index}`,
          new Date(Date.UTC(2026, 6, 3) + index * 60_000).toISOString()
        )
      );
    }
    expect(await readIntegrationRecords(state)).toHaveLength(100);
    expect(await readdir(join(state, "integration-records"))).toHaveLength(100);
  }, 15_000);

  it("retains a late-published fragment whose temporary file had an old mtime", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-publish-order-"));
    for (let index = 0; index < 100; index += 1) {
      await appendIntegrationRecord(
        state,
        record(`seed-${index}`, new Date(Date.UTC(2026, 6, 3) + index).toISOString())
      );
    }
    let markBlocked!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    publicationGate.ageTemporary = true;
    publicationGate.armed = true;
    publicationGate.blocked = markBlocked;
    publicationGate.wait = wait;
    publicationGate.publishedPath = null;
    publicationGate.temporaryCtime = null;
    publicationGate.afterPublish = null;
    const lateAppend = appendIntegrationRecord(
      state,
      record("late-publish", "2026-07-03T02:00:00.000Z")
    );
    await blocked;
    try {
      for (let index = 0; index <= 100; index += 1) {
        await appendIntegrationRecord(
          state,
          record(
            `newer-${index}`,
            new Date(Date.UTC(2026, 6, 3, 3) + index).toISOString()
          )
        );
      }
    } finally {
      release();
    }
    await lateAppend;
    const metadata = await stat(publicationGate.publishedPath!, { bigint: true });
    expect(metadata.ctimeNs).toBeGreaterThan(publicationGate.temporaryCtime!);

    const records = await readIntegrationRecords(state);
    expect(records.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "late-publish",
      "newer-100"
    ]));
    expect(records).toHaveLength(100);
    expect(await readdir(join(state, "integration-records"))).toHaveLength(100);
  }, 60_000);

  it("removes its owned fragment when validation fails after publication", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-post-publish-"));
    let ownedPath = "";
    publicationGate.afterPublish = async (publishedPath) => {
      ownedPath = publishedPath;
      await writeFile(
        join(
          dirname(publishedPath),
          `${Date.now()}-${process.pid}-999999999999-22222222-2222-4222-8222-222222222222.json`
        ),
        "not-json\n",
        { mode: 0o600 }
      );
    };

    const failure = await appendIntegrationRecord(
      state,
      record("post-publish", "2026-07-03T04:00:00.000Z")
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyntaxError);
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports commit uncertainty when its owned fragment cannot be removed", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-uncertain-"));
    publicationGate.publishedPath = null;
    publicationGate.failOwnedUnlink = true;
    publicationGate.afterPublish = async (publishedPath) => {
      publicationGate.publishedPath = publishedPath;
      await writeFile(
        join(
          dirname(publishedPath),
          `${Date.now()}-${process.pid}-999999999999-33333333-3333-4333-8333-333333333333.json`
        ),
        "not-json\n",
        { mode: 0o600 }
      );
    };

    const failure = await appendIntegrationRecord(
      state,
      record("uncertain-publish", "2026-07-03T05:00:00.000Z")
    ).catch((error: unknown) => error);
    publicationGate.failOwnedUnlink = false;

    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    expect(failure).toMatchObject({ code: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[1])
      .toMatchObject({ code: "EACCES" });
    await expect(access(publicationGate.publishedPath!)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "removes its source name after a POSIX same-inode rename no-op",
    async () => {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-rename-noop-"));
      publicationGate.armed = true;
      publicationGate.hardLinkDestinationBeforeRename = true;

      await appendIntegrationRecord(
        state,
        record("rename-noop", "2026-07-03T05:10:00.000Z")
      );

      expect(publicationGate.hardLinkNoOpObserved).toBe(true);
      await expect(readdir(join(state, "integration-records")))
        .resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/u));
      await expect(readIntegrationRecords(state)).resolves.toMatchObject([
        { id: "rename-noop" }
      ]);
    }
  );

  it("preserves an unowned source replacement after rename as typed uncertainty", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-rename-source-"));
    const replacementSource = Buffer.from("unowned temporary replacement\n");
    publicationGate.armed = true;
    publicationGate.renameSourceReplacement = replacementSource;

    const failure = await appendIntegrationRecord(
      state,
      record("rename-source-replacement", "2026-07-03T05:12:00.000Z")
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    expect(publicationGate.publishedPath).not.toBeNull();
    const files = await readdir(join(state, "integration-records"));
    const [temporary] = files.filter((fileName) => fileName.endsWith(".tmp"));
    expect(temporary).toBeDefined();
    await expect(readFile(join(state, "integration-records", temporary!), "utf8"))
      .resolves.toBe(replacementSource.toString("utf8"));
    await expect(access(publicationGate.publishedPath!)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "removes its source name when a POSIX same-inode rename no-op reports failure",
    async () => {
      const state = await mkdtemp(join(tmpdir(), "steward-integration-rename-noop-error-"));
      publicationGate.armed = true;
      publicationGate.hardLinkDestinationBeforeRename = true;
      publicationGate.throwAfterPublishRename = true;

      const failure = await appendIntegrationRecord(
        state,
        record("rename-noop-error", "2026-07-03T05:15:00.000Z")
      ).catch((error: unknown) => error);

      expect(publicationGate.hardLinkNoOpObserved).toBe(true);
      expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
      await expect(readdir(join(state, "integration-records"))).resolves.toEqual([]);
    }
  );

  it("treats a committed rename with a thrown outcome as typed uncertainty", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-rename-outcome-"));
    publicationGate.armed = true;
    publicationGate.throwAfterPublishRename = true;

    const failure = await appendIntegrationRecord(
      state,
      record("rename-outcome", "2026-07-03T05:20:00.000Z")
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    expect(publicationGate.publishedPath).not.toBeNull();
    await expect(access(publicationGate.publishedPath!))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a mismatched rename destination and removes its owned temporary", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-rename-collision-"));
    const replacementSource = `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("rename-collision", "2026-07-03T05:21:00.000Z")
    }, null, 2)}\n`;
    publicationGate.armed = true;
    publicationGate.renameCollisionSource = Buffer.from(replacementSource);

    const failure = await appendIntegrationRecord(
      state,
      record("rename-collision-owned", "2026-07-03T05:20:30.000Z")
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    expect(publicationGate.publishedPath).not.toBeNull();
    await expect(readFile(publicationGate.publishedPath!, "utf8"))
      .resolves.toBe(replacementSource);
    await expect(readdir(join(state, "integration-records")))
      .resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/u));
  });

  it("keeps the publication storage proof through post-commit cleanup", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-cleanup-root-"));
    publicationGate.armed = true;
    publicationGate.replaceRecordsAfterPublishedMetadata = true;

    const failure = await appendIntegrationRecord(
      state,
      record("cleanup-root", "2026-07-03T05:30:00.000Z")
    ).catch((error: unknown) => error);

    expect(publicationGate.recordsReplaced).toBe(true);
    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    await expect(readFile(join(state, "integration-records", "sentinel"), "utf8"))
      .resolves.toBe("untouched\n");
  });

  it("does not accept a valid same-name replacement as its published fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-published-owner-"));
    const replacementSource = `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("same-name-replacement", "2026-07-03T05:31:00.000Z")
    }, null, 2)}\n`;
    publicationGate.armed = true;
    publicationGate.afterPublish = async (publishedPath) => {
      await rename(publishedPath, `${publishedPath}.owned`);
      await writeFile(publishedPath, replacementSource, { mode: 0o600 });
    };

    const failure = await appendIntegrationRecord(
      state,
      record("owned-publication", "2026-07-03T05:30:00.000Z")
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    await expect(readFile(publicationGate.publishedPath!, "utf8"))
      .resolves.toBe(replacementSource);
  });

  it("preserves a published-path replacement when a later validation fails", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-later-owner-"));
    const replacementSource = `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("later-replacement", "2026-07-03T05:41:00.000Z")
    }, null, 2)}\n`;
    publicationGate.armed = true;
    publicationOwnershipGate.laterReplacement = Buffer.from(replacementSource);
    publicationOwnershipGate.laterMalformedName =
      `1-${process.pid}-999999999998-33333333-3333-4333-8333-333333333333.json`;

    const failure = await appendIntegrationRecord(
      state,
      record("later-owner", "2026-07-03T05:40:00.000Z")
    ).catch((error: unknown) => error);

    expect(publicationOwnershipGate.laterTriggered).toBe(true);
    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    await expect(readFile(publicationGate.publishedPath!, "utf8"))
      .resolves.toBe(replacementSource);
  });

  it("rechecks publication ownership after cleanup before returning success", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-final-owner-"));
    const replacementSource = `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("final-replacement", "2026-07-03T05:51:00.000Z")
    }, null, 2)}\n`;
    publicationGate.armed = true;
    publicationOwnershipGate.laterReplacement = Buffer.from(replacementSource);

    const failure = await appendIntegrationRecord(
      state,
      record("final-owner", "2026-07-03T05:50:00.000Z")
    ).catch((error: unknown) => error);

    expect(publicationOwnershipGate.laterTriggered).toBe(true);
    expect(failure).toBeInstanceOf(IntegrationJournalCommitUncertainError);
    await expect(readFile(publicationGate.publishedPath!, "utf8"))
      .resolves.toBe(replacementSource);
  });

  it("does not unlink a same-name replacement of a cleanup snapshot fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-cleanup-owner-"));
    for (let index = 0; index < 100; index += 1) {
      await appendIntegrationRecord(
        state,
        record(`cleanup-seed-${index}`, new Date(Date.UTC(2026, 6, 3) + index).toISOString())
      );
    }
    const directory = join(state, "integration-records");
    const files = await readdir(directory);
    const identities = await Promise.all(files.map(async (fileName) => ({
      fileName,
      metadata: await stat(join(directory, fileName), { bigint: true })
    })));
    identities.sort((left, right) => left.metadata.ctimeNs < right.metadata.ctimeNs ? -1 : 1);
    const target = join(directory, identities[0]!.fileName);
    const manualRecord = record("cleanup-manual-new", "2026-07-03T06:00:00.000Z");
    await writeFile(join(
      directory,
      `${Date.now()}-${process.pid}-999999999997-44444444-4444-4444-8444-444444444444.json`
    ), `${JSON.stringify({ schemaVersion: 1, limit: 100, record: manualRecord })}\n`, {
      mode: 0o600
    });
    const replacementSource = `${JSON.stringify({
      schemaVersion: 1,
      limit: 100,
      record: record("cleanup-same-name", "2026-07-03T06:01:00.000Z")
    })}\n`;
    publicationGate.armed = true;
    publicationOwnershipGate.cleanupDirectory = directory;
    publicationOwnershipGate.cleanupTarget = target;
    publicationOwnershipGate.cleanupReplacement = Buffer.from(replacementSource);

    const failure = await appendIntegrationRecord(
      state,
      record("cleanup-trigger", "2026-07-03T06:02:00.000Z")
    ).catch((error: unknown) => error);
    expect(publicationOwnershipGate.cleanupTriggered).toBe(true);
    expect(failure).toMatchObject({
      message: "Integration record fragment changed before cleanup"
    });
    await expect(readFile(target, "utf8")).resolves.toBe(replacementSource);
  }, 15_000);

  it("preserves different-Harness records across real concurrent processes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-concurrent-"));
    const barrier = join(state, "barrier");
    const readyA = join(state, "ready-a");
    const readyB = join(state, "ready-b");
    const count = 40;
    const writers = [
      writer([state, "codex", "codex", readyA, barrier, String(count), "v2"]),
      writer([state, "claude-code", "claude", readyB, barrier, String(count), "v2"])
    ];
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(writers);

    const records = await readIntegrationRecords(state);
    expect(records).toHaveLength(count * 2);
    expect(new Set(records.map(({ id }) => id)).size).toBe(count * 2);
    expect(records.some(({ id }) => id === "codex-039")).toBe(true);
    expect(records.some(({ id }) => id === "claude-039")).toBe(true);
    expect(records.every(({ schemaVersion }) => schemaVersion === 2)).toBe(true);
  }, 15_000);

  it("preserves same-Harness no-op records across real concurrent processes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-same-"));
    const barrier = join(state, "barrier");
    const readyA = join(state, "ready-a");
    const readyB = join(state, "ready-b");
    const count = 20;
    const writers = [
      writer([state, "codex", "left", readyA, barrier, String(count)]),
      writer([state, "codex", "right", readyB, barrier, String(count)])
    ];
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(writers);

    const records = await readIntegrationRecords(state);
    expect(records).toHaveLength(count * 2);
    expect(new Set(records.map(({ id }) => id))).toEqual(new Set([
      ...Array.from({ length: count }, (_, index) => `left-${String(index).padStart(3, "0")}`),
      ...Array.from({ length: count }, (_, index) => `right-${String(index).padStart(3, "0")}`)
    ]));
    await expect(latestIntegrationRecord(state, "codex")).resolves.toMatchObject({
      harness: "codex",
      status: "installed"
    });
  }, 15_000);

  it("keeps readers healthy while real writers publish and clean more than 100 records", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-read-race-"));
    for (let index = 0; index < 100; index += 1) {
      await appendIntegrationRecord(
        state,
        record(`seed-${index}`, new Date(Date.UTC(2026, 6, 3) + index).toISOString())
      );
    }
    const barrier = join(state, "barrier");
    const readyWriter = join(state, "ready-writer");
    const readyReaderA = join(state, "ready-reader-a");
    const readyReaderB = join(state, "ready-reader-b");
    const processes = [
      writer([state, "codex", "race", readyWriter, barrier, "40"]),
      reader([state, readyReaderA, barrier, "80"]),
      reader([state, readyReaderB, barrier, "80"])
    ];
    await Promise.all([waitFor(readyWriter), waitFor(readyReaderA), waitFor(readyReaderB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(processes);

    const records = await readIntegrationRecords(state);
    expect(records.some(({ id }) => id === "race-039")).toBe(true);
    expect(await readdir(join(state, "integration-records"))).toHaveLength(100);
  }, 30_000);
});
