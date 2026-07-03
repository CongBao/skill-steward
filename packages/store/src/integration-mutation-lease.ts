import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const LEASE_FILE = "integration-mutation.lease";
const RECOVERY_GUARD_FILE = "integration-mutation-recovery.guard";
const recoveryIntentPattern = /^\.integration-mutation-guard-recovery\.[1-9][0-9]*-[0-9a-f-]{36}\.intent$/;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_STALE_MS = 30 * 60_000;
const DEFAULT_HARD_STALE_MS = 24 * 60 * 60_000;

const ownerSchema = z.object({
  schemaVersion: z.literal(1),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  acquiredAt: z.string().datetime()
}).strict();

type LeaseOwner = z.infer<typeof ownerSchema>;
type LeaseErrorCode =
  | "INTEGRATION_BUSY"
  | "INTEGRATION_LEASE_LOST"
  | "INTEGRATION_LEASE_UNSAFE";

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface ObservedOwner {
  owner: LeaseOwner;
  identity: FileIdentity;
  mtimeMs: number;
}

interface PublishedOwner extends ObservedOwner {
  handle: FileHandle;
  path: string;
}

export interface IntegrationMutationLeaseOptions {
  waitMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  hardStaleMs?: number;
}

interface NormalizedOptions {
  waitMs: number;
  pollMs: number;
  heartbeatMs: number;
  staleMs: number;
  hardStaleMs: number;
}

export class IntegrationMutationLeaseError extends Error {
  public readonly code: LeaseErrorCode;

  constructor(
    code: LeaseErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IntegrationMutationLeaseError";
    this.code = code;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function unsafe(message: string, cause?: unknown): IntegrationMutationLeaseError {
  return new IntegrationMutationLeaseError(
    "INTEGRATION_LEASE_UNSAFE",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function normalizeOptions(input: IntegrationMutationLeaseOptions): NormalizedOptions {
  const options = {
    waitMs: input.waitMs ?? DEFAULT_WAIT_MS,
    pollMs: input.pollMs ?? DEFAULT_POLL_MS,
    heartbeatMs: input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    staleMs: input.staleMs ?? DEFAULT_STALE_MS,
    hardStaleMs: input.hardStaleMs ?? DEFAULT_HARD_STALE_MS
  };
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 1) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
  if (options.hardStaleMs <= options.staleMs) {
    throw new TypeError("hardStaleMs must be greater than staleMs");
  }
  return options;
}

function ownedPath(statePath: string, name: string, token: string): string {
  return resolve(statePath, `.${name}.${process.pid}-${token}.owned`);
}

function temporaryPath(statePath: string, name: string, token: string): string {
  return resolve(statePath, `.${name}.${process.pid}-${token}.tmp`);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function secureStateDirectory(stateDirectory: string): Promise<string> {
  const statePath = resolve(stateDirectory);
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const before = await lstat(statePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw unsafe("Integration mutation state must be a regular directory");
  }
  if (process.platform !== "win32") {
    const handle = await open(
      statePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isDirectory()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
      ) {
        throw unsafe("Integration mutation state changed while it was opened");
      }
      await handle.chmod(0o700);
      const secured = await handle.stat({ bigint: true });
      if ((secured.mode & 0o777n) !== 0o700n) {
        throw unsafe("Integration mutation state must have private permissions");
      }
    } finally {
      await handle.close();
    }
  } else {
    const physical = await realpath(statePath);
    if ((await realpath(statePath)).toLowerCase() !== physical.toLowerCase()) {
      throw unsafe("Integration mutation state changed while it was resolved");
    }
  }
  const after = await lstat(statePath, { bigint: true });
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || after.dev !== before.dev
    || after.ino !== before.ino
  ) {
    throw unsafe("Integration mutation state changed during validation");
  }
  return statePath;
}

async function observeOwner(path: string): Promise<ObservedOwner | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw unsafe("Integration mutation lease paths must be regular files");
  }
  if (process.platform !== "win32" && (pathMetadata.mode & 0o777n) !== 0o600n) {
    throw unsafe("Integration mutation lease files must have private permissions");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const opened = await handle.stat({ bigint: true });
    const identity = { device: opened.dev, inode: opened.ino };
    if (!opened.isFile()) {
      throw unsafe("Integration mutation lease paths must be regular files");
    }
    if (!sameIdentity(identity, { device: pathMetadata.dev, inode: pathMetadata.ino })) {
      return undefined;
    }
    let owner: LeaseOwner;
    try {
      owner = ownerSchema.parse(JSON.parse(await handle.readFile({ encoding: "utf8" })));
    } catch (error) {
      if (error instanceof IntegrationMutationLeaseError) throw error;
      throw unsafe("Integration mutation lease owner metadata is invalid", error);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(identity, { device: after.dev, inode: after.ino })) {
      throw unsafe("Integration mutation lease changed while it was read");
    }
    return {
      owner,
      identity,
      mtimeMs: Number(after.mtimeMs)
    };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ESRCH")) return false;
    return true;
  }
}

async function mayRecover(
  observed: ObservedOwner,
  options: NormalizedOptions
): Promise<boolean> {
  const age = Date.now() - observed.mtimeMs;
  if (age >= options.hardStaleMs) return true;
  return age >= options.staleMs && !await processIsAlive(observed.owner.pid);
}

async function publishOwnerFile(
  statePath: string,
  name: string,
  publicationBlocked?: () => Promise<boolean>
): Promise<PublishedOwner | undefined> {
  const token = randomUUID();
  const owner = ownerSchema.parse({
    schemaVersion: 1,
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  });
  const temporary = temporaryPath(statePath, name, token);
  const destination = resolve(statePath, name);
  if (dirname(temporary) !== statePath || dirname(destination) !== statePath) {
    throw unsafe("Integration mutation lease path escaped private state");
  }
  let temporaryExists = false;
  let published = false;
  let retained = false;
  let publishedIdentity: FileIdentity | undefined;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      if (process.platform !== "win32") await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const temporaryMetadata = await lstat(temporary, { bigint: true });
    const identity = { device: temporaryMetadata.dev, inode: temporaryMetadata.ino };
    publishedIdentity = identity;
    if (publicationBlocked && await publicationBlocked()) return undefined;
    try {
      await link(temporary, destination);
      published = true;
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) return undefined;
      throw error;
    }
    if (publicationBlocked && await publicationBlocked()) {
      const current = await observeOwner(destination);
      if (current && sameIdentity(current.identity, identity)) {
        await removeFile(destination);
        published = false;
      }
      return undefined;
    }
    const opened = await open(destination, "r+");
    const openedMetadata = await opened.stat({ bigint: true });
    if (!sameIdentity(identity, { device: openedMetadata.dev, inode: openedMetadata.ino })) {
      await opened.close();
      throw unsafe("Integration mutation lease changed during publication");
    }
    await removeFile(temporary);
    temporaryExists = false;
    retained = true;
    return {
      path: destination,
      owner,
      identity,
      mtimeMs: Number(openedMetadata.mtimeMs),
      handle: opened
    };
  } finally {
    if (temporaryExists) await removeFile(temporary);
    if (published && !retained) {
      const current = await observeOwner(destination);
      if (
        current?.owner.token === token
        && publishedIdentity !== undefined
        && sameIdentity(current.identity, publishedIdentity)
      ) {
        await removeFile(destination);
      }
    }
  }
}

async function renameOwned(
  path: string,
  statePath: string,
  name: string,
  expected: ObservedOwner
): Promise<string> {
  const owned = ownedPath(statePath, name, expected.owner.token);
  try {
    await rename(path, owned);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new IntegrationMutationLeaseError(
        "INTEGRATION_LEASE_LOST",
        "Integration mutation lease disappeared before ownership transfer"
      );
    }
    throw error;
  }
  const moved = await observeOwner(owned);
  if (
    moved === undefined
    || moved.owner.token !== expected.owner.token
    || !sameIdentity(moved.identity, expected.identity)
  ) {
    throw new IntegrationMutationLeaseError(
      "INTEGRATION_LEASE_LOST",
      "Integration mutation lease ownership changed during transfer"
    );
  }
  return owned;
}

async function recoverGuardIfSafe(
  statePath: string,
  options: NormalizedOptions
): Promise<void> {
  const intentName = `.integration-mutation-guard-recovery.${process.pid}-${randomUUID()}.intent`;
  const intent = await publishOwnerFile(statePath, intentName);
  if (!intent) throw unsafe("Integration mutation recovery intent could not be published");
  try {
    const guardPath = resolve(statePath, RECOVERY_GUARD_FILE);
    const observed = await observeOwner(guardPath);
    if (!observed || !await mayRecover(observed, options)) return;
    try {
      const owned = await renameOwned(
        guardPath,
        statePath,
        RECOVERY_GUARD_FILE,
        observed
      );
      await removeFile(owned);
    } catch (error) {
      if (
        error instanceof IntegrationMutationLeaseError
        && error.code === "INTEGRATION_LEASE_LOST"
        && await observeOwner(guardPath) === undefined
      ) {
        return;
      }
      throw error;
    }
  } finally {
    await releasePublishedOwner(intent, statePath, intentName);
  }
}

async function recoveryIntentExists(
  statePath: string,
  options: NormalizedOptions
): Promise<boolean> {
  const entries = await readdir(statePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !recoveryIntentPattern.test(entry.name)) continue;
    const path = resolve(statePath, entry.name);
    const observed = await observeOwner(path);
    if (!observed) continue;
    if (!await mayRecover(observed, options)) return true;
    try {
      const owned = await renameOwned(path, statePath, entry.name, observed);
      await removeFile(owned);
    } catch (error) {
      if (
        error instanceof IntegrationMutationLeaseError
        && error.code === "INTEGRATION_LEASE_LOST"
        && await observeOwner(path) === undefined
      ) {
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function acquireRecoveryGuard(
  statePath: string,
  options: NormalizedOptions,
  deadline: number
): Promise<PublishedOwner> {
  while (Date.now() <= deadline) {
    const published = await publishOwnerFile(statePath, RECOVERY_GUARD_FILE, () =>
      recoveryIntentExists(statePath, options)
    );
    if (published) return published;
    const observed = await observeOwner(resolve(statePath, RECOVERY_GUARD_FILE));
    if (observed && await mayRecover(observed, options)) {
      await recoverGuardIfSafe(statePath, options);
    }
    await delay(options.pollMs);
  }
  throw new IntegrationMutationLeaseError(
    "INTEGRATION_BUSY",
    "Another integration mutation is completing lease recovery"
  );
}

async function releasePublishedOwner(
  published: PublishedOwner,
  statePath: string,
  name: string
): Promise<void> {
  await published.handle.close();
  const current = await observeOwner(published.path);
  if (
    current === undefined
    || current.owner.token !== published.owner.token
    || !sameIdentity(current.identity, published.identity)
  ) {
    throw new IntegrationMutationLeaseError(
      "INTEGRATION_LEASE_LOST",
      "Integration mutation lease is no longer owned by this operation"
    );
  }
  const owned = await renameOwned(published.path, statePath, name, current);
  await removeFile(owned);
}

async function withRecoveryGuard<T>(
  statePath: string,
  options: NormalizedOptions,
  deadline: number,
  operation: () => Promise<T>
): Promise<T> {
  const guard = await acquireRecoveryGuard(statePath, options, deadline);
  try {
    return await operation();
  } finally {
    await releasePublishedOwner(guard, statePath, RECOVERY_GUARD_FILE);
  }
}

async function recoverLeaseIfSafe(
  statePath: string,
  options: NormalizedOptions,
  deadline: number
): Promise<void> {
  await withRecoveryGuard(statePath, options, deadline, async () => {
    const leasePath = resolve(statePath, LEASE_FILE);
    const observed = await observeOwner(leasePath);
    if (!observed || !await mayRecover(observed, options)) return;
    const owned = await renameOwned(leasePath, statePath, LEASE_FILE, observed);
    await removeFile(owned);
  });
}

async function acquireLease(
  statePath: string,
  options: NormalizedOptions,
  deadline: number
): Promise<PublishedOwner> {
  while (Date.now() <= deadline) {
    const published = await publishOwnerFile(statePath, LEASE_FILE, async () =>
      await observeOwner(resolve(statePath, RECOVERY_GUARD_FILE)) !== undefined
    );
    if (published) return published;
    const guard = await observeOwner(resolve(statePath, RECOVERY_GUARD_FILE));
    if (guard && await mayRecover(guard, options)) {
      await recoverGuardIfSafe(statePath, options);
    }
    const observed = await observeOwner(resolve(statePath, LEASE_FILE));
    if (observed && await mayRecover(observed, options)) {
      await recoverLeaseIfSafe(statePath, options, deadline);
    }
    await delay(options.pollMs);
  }
  throw new IntegrationMutationLeaseError(
    "INTEGRATION_BUSY",
    "Another integration mutation is already in progress"
  );
}

function startHeartbeat(
  lease: PublishedOwner,
  heartbeatMs: number
): { stop: () => Promise<void> } {
  let inFlight = Promise.resolve();
  let heartbeatError: unknown;
  const timer = setInterval(() => {
    inFlight = inFlight.then(async () => {
      const now = new Date();
      await lease.handle.utimes(now, now);
    }).catch((error: unknown) => {
      heartbeatError ??= error;
    });
  }, heartbeatMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
      if (heartbeatError !== undefined) throw heartbeatError;
    }
  };
}

async function releaseLease(
  lease: PublishedOwner,
  statePath: string,
  options: NormalizedOptions,
  deadline: number,
  stopHeartbeat: () => Promise<void>
): Promise<void> {
  await withRecoveryGuard(statePath, options, deadline, async () => {
    await stopHeartbeat();
    await releasePublishedOwner(lease, statePath, LEASE_FILE);
  });
}

export async function withIntegrationMutationLease<T>(
  stateDirectory: string,
  operation: () => Promise<T>,
  inputOptions: IntegrationMutationLeaseOptions = {}
): Promise<T> {
  const options = normalizeOptions(inputOptions);
  const statePath = await secureStateDirectory(stateDirectory);
  const deadline = Date.now() + options.waitMs;
  const lease = await acquireLease(statePath, options, deadline);
  const heartbeat = startHeartbeat(lease, options.heartbeatMs);
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLease(
        lease,
        statePath,
        options,
        Date.now() + options.waitMs,
        heartbeat.stop
      );
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          "Integration mutation and lease release both failed"
        );
      }
      throw releaseError;
    }
  }
}
