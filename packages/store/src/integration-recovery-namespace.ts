import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  integrationRecoveryStateSchema,
  MAX_RECOVERY_DIRECTORY_ENTRIES,
  MAX_RECOVERY_FRAGMENT_BYTES,
  MAX_RECOVERY_FRAGMENTS,
  MAX_RECOVERY_TOTAL_BYTES,
  recoveryFragmentNamePattern,
  validateRecoveryHistory,
  type IntegrationRecoveryState
} from "./integration-recovery-domain.js";

const RECOVERY_DIRECTORY = "integration-recovery";
const RECOVERY_GUARD = "integration-recovery.namespace.json";
const MAX_GUARD_BYTES = 16 * 1024;
const decimalIdentitySchema = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);

const guardSchema = z.object({
  schemaVersion: z.literal(1),
  namespaceId: z.string().uuid(),
  directory: z.object({
    name: z.literal(RECOVERY_DIRECTORY),
    device: decimalIdentitySchema,
    inode: decimalIdentitySchema,
    physicalPath: z.string().min(1).max(4_096)
  }).strict(),
  guardIdentity: z.object({
    device: decimalIdentitySchema,
    inode: decimalIdentitySchema
  }).strict()
}).strict();

export interface RecoveryStoreContext {
  platform: NodeJS.Platform;
}

export interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}

export interface RecoveryStateRoot {
  path: string;
  physicalPath: string;
  identity: DirectoryIdentity;
}

export interface RecoveryStorage {
  state: RecoveryStateRoot;
  path: string;
  physicalPath: string;
  identity: DirectoryIdentity;
}

export interface RecoverySnapshot {
  entryCount: number;
  storage?: RecoveryStorage;
  states: IntegrationRecoveryState[];
}

export class RecoveryNamespaceCommitUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryNamespaceCommitUncertainError";
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameRecoveryFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

export function sameLinkedRecoveryFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function assertSupported(context: RecoveryStoreContext): void {
  if (context.platform === "win32") {
    throw new Error("Integration recovery storage is unavailable on this platform");
  }
}

function recoveryPath(stateDirectory: string): string {
  const statePath = resolve(stateDirectory);
  const path = resolve(statePath, RECOVERY_DIRECTORY);
  if (dirname(path) !== statePath) throw new Error("Recovery directory escaped state storage");
  return path;
}

function guardPath(stateDirectory: string): string {
  const statePath = resolve(stateDirectory);
  const path = resolve(statePath, RECOVERY_GUARD);
  if (dirname(path) !== statePath) throw new Error("Recovery guard escaped state storage");
  return path;
}

async function inspectDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a physical directory`);
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function inspectStateRoot(stateDirectory: string): Promise<RecoveryStateRoot> {
  const path = resolve(stateDirectory);
  const identity = await inspectDirectory(path, "Integration recovery state directory");
  const metadata = await lstat(path, { bigint: true });
  if ((metadata.mode & 0o777n) !== 0o700n) {
    throw new Error("Integration recovery state directory must have private permissions");
  }
  const physicalPath = await realpath(path);
  const after = await inspectDirectory(path, "Integration recovery state directory");
  if (!sameDirectory(identity, after) || await realpath(path) !== physicalPath) {
    throw new Error("Integration recovery state directory changed during inspection");
  }
  return { path, physicalPath, identity };
}

export async function assertRecoveryStateRoot(root: RecoveryStateRoot): Promise<void> {
  const [identity, physicalPath] = await Promise.all([
    inspectDirectory(root.path, "Integration recovery state directory"),
    realpath(root.path)
  ]);
  if (!sameDirectory(root.identity, identity) || physicalPath !== root.physicalPath) {
    throw new Error("Integration recovery state directory identity changed");
  }
}

async function inspectStorage(root: RecoveryStateRoot, path: string): Promise<RecoveryStorage> {
  const identity = await inspectDirectory(path, "Integration recovery directory");
  const metadata = await lstat(path, { bigint: true });
  if ((metadata.mode & 0o777n) !== 0o700n) {
    throw new Error("Integration recovery directory must have private permissions");
  }
  const physicalPath = await realpath(path);
  if (dirname(physicalPath) !== root.physicalPath) {
    throw new Error("Integration recovery directory escaped state storage");
  }
  await assertRecoveryStateRoot(root);
  return { state: root, path, physicalPath, identity };
}

export async function assertRecoveryStorage(storage: RecoveryStorage): Promise<void> {
  await assertRecoveryStateRoot(storage.state);
  const [identity, physicalPath] = await Promise.all([
    inspectDirectory(storage.path, "Integration recovery directory"),
    realpath(storage.path)
  ]);
  if (
    !sameDirectory(storage.identity, identity)
    || physicalPath !== storage.physicalPath
    || dirname(physicalPath) !== storage.state.physicalPath
  ) {
    throw new Error("Integration recovery directory identity changed");
  }
}

export async function syncRecoveryDirectory(
  path: string,
  expected: DirectoryIdentity
): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory() || before.dev !== expected.device || before.ino !== expected.inode) {
      throw new Error("Integration recovery directory sync identity changed before fsync");
    }
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!after.isDirectory() || after.dev !== expected.device || after.ino !== expected.inode) {
      throw new Error("Integration recovery directory sync identity changed during fsync");
    }
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, limit: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > limit) throw new Error("Integration recovery file exceeds its byte bound");
  return buffer.subarray(0, offset);
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function readGuard(root: RecoveryStateRoot, path: string) {
  await assertRecoveryStateRoot(root);
  const initial = await lstat(path, { bigint: true });
  if (
    initial.isSymbolicLink()
    || !initial.isFile()
    || initial.nlink !== 1n
    || (initial.mode & 0o777n) !== 0o600n
    || initial.size > BigInt(MAX_GUARD_BYTES)
  ) {
    throw new Error("Integration recovery namespace guard is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameRecoveryFile(initial, opened)) throw new Error("Recovery guard changed before read");
    const guard = guardSchema.parse(decodeJson(
      await readBounded(handle, MAX_GUARD_BYTES),
      "Integration recovery namespace guard"
    ));
    const after = await handle.stat({ bigint: true });
    if (!sameRecoveryFile(opened, after)) throw new Error("Recovery guard changed during read");
    await assertRecoveryStateRoot(root);
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameRecoveryFile(after, pathAfter)) throw new Error("Recovery guard path changed");
    if (
      guard.guardIdentity.device !== after.dev.toString()
      || guard.guardIdentity.inode !== after.ino.toString()
    ) {
      throw new Error("Recovery guard identity does not match its opened file");
    }
    return guard;
  } finally {
    await handle.close();
  }
}

async function removeExactFile(path: string, expected: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!sameRecoveryFile(current, expected)) throw new Error("Owned recovery file changed");
  await unlink(path);
}

async function publishGuard(
  root: RecoveryStateRoot,
  storage: RecoveryStorage,
  beforePublish: () => Promise<void>
): Promise<void> {
  const destination = guardPath(root.path);
  const temporary = join(root.path, `.integration-recovery-namespace.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  let temporaryIdentity: BigIntStats | undefined;
  let primary: unknown;
  try {
    temporaryIdentity = await handle.stat({ bigint: true });
    const guard = guardSchema.parse({
      schemaVersion: 1,
      namespaceId: randomUUID(),
      directory: {
        name: RECOVERY_DIRECTORY,
        device: storage.identity.device.toString(),
        inode: storage.identity.inode.toString(),
        physicalPath: storage.physicalPath
      },
      guardIdentity: {
        device: temporaryIdentity.dev.toString(),
        inode: temporaryIdentity.ino.toString()
      }
    });
    await handle.writeFile(`${JSON.stringify(guard, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    temporaryIdentity = await handle.stat({ bigint: true });
    await handle.close();
    await beforePublish();
    await assertRecoveryStorage(storage);
    await link(temporary, destination);
    const linkedTemporary = await lstat(temporary, { bigint: true });
    temporaryIdentity = linkedTemporary;
    await syncRecoveryDirectory(root.path, root.identity);
    await removeExactFile(temporary, linkedTemporary);
    temporaryIdentity = undefined;
    await syncRecoveryDirectory(root.path, root.identity);
    await readGuard(root, destination);
    return;
  } catch (error) {
    primary = error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  let cleanupError: unknown;
  if (temporaryIdentity) {
    try {
      await removeExactFile(temporary, temporaryIdentity);
    } catch (error) {
      cleanupError = error;
    }
  }
  throw new RecoveryNamespaceCommitUncertainError(
    "Integration recovery namespace initialization could not be proven durable",
    {
      cause: cleanupError === undefined
        ? primary
        : new AggregateError([primary, cleanupError], "Guard publication and cleanup failed")
    }
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path, { bigint: true });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function openRecoveryNamespace(
  stateDirectory: string,
  create: boolean,
  context: RecoveryStoreContext,
  beforeNamespaceMutation: () => Promise<void> = async () => undefined
): Promise<RecoveryStorage | undefined> {
  assertSupported(context);
  let root: RecoveryStateRoot;
  try {
    root = await inspectStateRoot(stateDirectory);
  } catch (error) {
    if (!create && isMissing(error)) return undefined;
    throw error;
  }
  const directoryPath = recoveryPath(stateDirectory);
  const namespaceGuardPath = guardPath(stateDirectory);
  const [directoryExists, guardExists] = await Promise.all([
    pathExists(directoryPath),
    pathExists(namespaceGuardPath)
  ]);
  if (!directoryExists && !guardExists) {
    if (!create) return undefined;
    await beforeNamespaceMutation();
    await mkdir(directoryPath, { mode: 0o700 });
    const storage = await inspectStorage(root, directoryPath);
    try {
      await syncRecoveryDirectory(root.path, root.identity);
      await publishGuard(root, storage, beforeNamespaceMutation);
    } catch (error) {
      if (error instanceof RecoveryNamespaceCommitUncertainError) throw error;
      throw new RecoveryNamespaceCommitUncertainError(
        "Integration recovery namespace root durability could not be proven",
        { cause: error }
      );
    }
    return storage;
  }
  if (directoryExists !== guardExists) {
    throw new Error("Integration recovery namespace guard and directory must both exist");
  }
  const storage = await inspectStorage(root, directoryPath);
  const guard = await readGuard(root, namespaceGuardPath);
  if (
    guard.directory.device !== storage.identity.device.toString()
    || guard.directory.inode !== storage.identity.inode.toString()
    || guard.directory.physicalPath !== storage.physicalPath
  ) {
    throw new Error("Integration recovery directory does not match its namespace guard");
  }
  await assertRecoveryStorage(storage);
  return storage;
}

export function assertPrivateRecoveryFile(metadata: BigIntStats): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Integration recovery fragment must be a regular file");
  }
  if ((metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 1n) {
    throw new Error("Integration recovery fragment must be private and singly linked");
  }
  if (metadata.size > BigInt(MAX_RECOVERY_FRAGMENT_BYTES)) {
    throw new Error("Integration recovery fragment exceeds the byte bound");
  }
}

export async function readRecoveryFragment(
  storage: RecoveryStorage,
  fileName: string
): Promise<{ state: IntegrationRecoveryState; metadata: BigIntStats }> {
  const match = recoveryFragmentNamePattern.exec(fileName);
  if (!match) throw new Error("Integration recovery fragment name is invalid");
  const path = join(storage.path, fileName);
  await assertRecoveryStorage(storage);
  const initial = await lstat(path, { bigint: true });
  assertPrivateRecoveryFile(initial);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertPrivateRecoveryFile(opened);
    if (!sameRecoveryFile(initial, opened)) throw new Error("Recovery fragment changed before read");
    const state = integrationRecoveryStateSchema.parse(decodeJson(
      await readBounded(handle, MAX_RECOVERY_FRAGMENT_BYTES),
      "Integration recovery fragment"
    ));
    const after = await handle.stat({ bigint: true });
    if (!sameRecoveryFile(opened, after)) throw new Error("Recovery fragment changed during read");
    await assertRecoveryStorage(storage);
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameRecoveryFile(after, pathAfter)) throw new Error("Recovery fragment path changed");
    if (state.transactionId !== match[1] || state.sequence !== Number(match[2])) {
      throw new Error("Recovery fragment name does not match its body");
    }
    return { state, metadata: pathAfter };
  } finally {
    await handle.close();
  }
}

async function enumerate(storage: RecoveryStorage) {
  await assertRecoveryStorage(storage);
  const directory = await opendir(storage.path);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (names.length >= MAX_RECOVERY_DIRECTORY_ENTRIES) {
        throw new Error("Integration recovery directory exceeds the entry bound");
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  const fragments = names.filter((name) => recoveryFragmentNamePattern.test(name)).sort();
  if (fragments.length > MAX_RECOVERY_FRAGMENTS) {
    throw new Error("Integration recovery history exceeds the fragment bound");
  }
  await assertRecoveryStorage(storage);
  return { entryCount: names.length, fragments };
}

export async function readRecoverySnapshot(
  stateDirectory: string,
  context: RecoveryStoreContext,
  expectedStorage?: RecoveryStorage
): Promise<RecoverySnapshot> {
  const storage = expectedStorage ?? await openRecoveryNamespace(stateDirectory, false, context);
  if (!storage) return { entryCount: 0, states: [] };
  const initial = await enumerate(storage);
  let totalBytes = 0n;
  const entries: Array<{ name: string; state: IntegrationRecoveryState; metadata: BigIntStats }> = [];
  for (const name of initial.fragments) {
    const fragment = await readRecoveryFragment(storage, name);
    totalBytes += fragment.metadata.size;
    if (totalBytes > BigInt(MAX_RECOVERY_TOTAL_BYTES)) {
      throw new Error("Integration recovery history exceeds the total byte bound");
    }
    entries.push({ name, ...fragment });
  }
  const final = await enumerate(storage);
  if (JSON.stringify(final.fragments) !== JSON.stringify(initial.fragments)) {
    throw new Error("Integration recovery snapshot changed during read");
  }
  for (const entry of entries) {
    const current = await lstat(join(storage.path, entry.name), { bigint: true });
    if (!sameRecoveryFile(entry.metadata, current)) {
      throw new Error("Integration recovery fragment changed during snapshot validation");
    }
  }
  await assertRecoveryStorage(storage);
  const states = entries.map(({ state }) => state);
  validateRecoveryHistory(states);
  return { entryCount: final.entryCount, storage, states };
}

export async function removeOwnedRecoveryTemporary(
  storage: RecoveryStorage,
  path: string,
  expected: BigIntStats
): Promise<void> {
  await assertRecoveryStorage(storage);
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameRecoveryFile(expected, current)) {
    throw new Error("Integration recovery temporary ownership changed");
  }
  await unlink(path);
  await assertRecoveryStorage(storage);
}
