import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  IntegrationFileTransactionError,
  assertIntegrationMutationLeaseOwned
} from "@skill-steward/store";
import type {
  OwnedTreeDirectoryProof,
  OwnedTreeMutationBoundary,
  OwnedTreeMutationOptions,
  OwnedTreePhysicalIdentity,
  OwnedTreeVerificationBoundary
} from "./companion-owned-tree-domain.js";

export function invalidOwnedTree(message: string, cause?: unknown): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}
export function driftedOwnedTree(message: string, cause?: unknown): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_DRIFT",
    message,
    cause === undefined ? undefined : { cause }
  );
}

export function uncertainOwnedTree(message: string, causes: unknown[]): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_UNCERTAIN",
    message,
    { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message) }
  );
}

export function incompleteOwnedTreeRecovery(
  message: string,
  causes: unknown[]
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE",
    message,
    { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message) }
  );
}

export function pendingOwnedTreeCleanup(
  message: string,
  causes: unknown[]
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_CLEANUP_PENDING",
    message,
    { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message) }
  );
}

export function sameOwnedTreeIdentity(
  left: OwnedTreePhysicalIdentity,
  right: OwnedTreePhysicalIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function identityFromStats(metadata: BigIntStats): OwnedTreePhysicalIdentity {
  if (metadata.dev <= 0n || metadata.ino <= 0n) {
    throw invalidOwnedTree("Companion filesystem identity is unavailable");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

export function normalizeOwnedTreePath(path: string, label: string): string {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || path.includes("\0")
    || Buffer.byteLength(path, "utf8") > 4_096
    || resolve(path) !== path
  ) {
    throw invalidOwnedTree(`${label} must be a bounded normalized absolute path`);
  }
  return path;
}

export function assertOwnedTreeChild(boundary: string, child: string): void {
  const relativePath = relative(boundary, child);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw invalidOwnedTree("Companion path must remain inside its home boundary");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function lstatOwnedTree(
  path: string,
  options: OwnedTreeMutationOptions
): Promise<BigIntStats | undefined> {
  try {
    return await (options.hooks?.lstatPath ?? ((target: string) => lstat(target, { bigint: true })))(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw driftedOwnedTree("Companion filesystem state could not be inspected", error);
  }
}

export async function assertOwnedTreeLeaseBoundary(
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeMutationBoundary,
  paths: readonly string[]
): Promise<void> {
  await options.hooks?.beforeBoundary?.(boundary, Object.freeze([...paths]));
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
}

export async function assertOwnedTreeMutationCompleted(
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeMutationBoundary,
  paths: readonly string[]
): Promise<void> {
  await options.hooks?.afterBoundary?.(boundary, Object.freeze([...paths]));
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
}

export async function beforeOwnedTreeVerification(
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeVerificationBoundary,
  paths: readonly string[]
): Promise<void> {
  await options.hooks?.beforeVerification?.(boundary, Object.freeze([...paths]));
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
}

export async function afterOwnedTreeVerification(
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeVerificationBoundary,
  paths: readonly string[]
): Promise<void> {
  await options.hooks?.afterVerification?.(boundary, Object.freeze([...paths]));
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
}

export async function assertOwnedTreeVerificationBoundary(
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeVerificationBoundary,
  paths: readonly string[],
  verify: () => void | Promise<void>
): Promise<void> {
  try {
    await beforeOwnedTreeVerification(options, boundary, paths);
    await verify();
    await afterOwnedTreeVerification(options, boundary, paths);
    await verify();
  } catch (error) {
    if (error instanceof IntegrationFileTransactionError) throw error;
    throw driftedOwnedTree("Companion full-tree verification could not complete", error);
  }
}

async function openDirectory(
  path: string,
  options: OwnedTreeMutationOptions
): Promise<FileHandle> {
  const openPath = options.hooks?.openPath
    ?? ((target: string, flags: number, mode?: number) => open(target, flags, mode));
  return openPath(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

export async function assertOwnedTreeDirectoryHandle(
  handle: FileHandle,
  expected: OwnedTreeDirectoryProof
): Promise<void> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isDirectory() || !sameOwnedTreeIdentity(identityFromStats(opened), expected.identity)) {
    throw driftedOwnedTree("Opened companion directory identity changed");
  }
}

export async function openOwnedTreeDirectoryHandle(
  expected: OwnedTreeDirectoryProof,
  options: OwnedTreeMutationOptions
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await openDirectory(expected.path, options);
  } catch (error) {
    throw driftedOwnedTree("Companion directory could not be opened safely", error);
  }
  try {
    await assertOwnedTreeDirectoryHandle(handle, expected);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function proveOwnedTreeDirectory(
  path: string,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeDirectoryProof> {
  const before = await lstatOwnedTree(path, options);
  if (before === undefined || before.isSymbolicLink() || !before.isDirectory()) {
    throw driftedOwnedTree("Companion directory proof is unavailable");
  }
  const identity = identityFromStats(before);
  const provisionalProof = Object.freeze({
    path,
    physicalPath: path,
    identity: Object.freeze(identity),
    mode: Number(before.mode & 0o777n)
  });
  const handle = await openOwnedTreeDirectoryHandle(provisionalProof, options);
  try {
    await assertOwnedTreeDirectoryHandle(handle, provisionalProof);
  } finally {
    await handle.close().catch(() => undefined);
  }
  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch (error) {
    throw driftedOwnedTree("Companion directory physical path is unavailable", error);
  }
  const after = await lstatOwnedTree(path, options);
  if (
    after === undefined
    || after.isSymbolicLink()
    || !after.isDirectory()
    || !sameOwnedTreeIdentity(identity, identityFromStats(after))
  ) {
    throw driftedOwnedTree("Companion directory changed during proof");
  }
  return Object.freeze({
    path,
    physicalPath,
    identity: Object.freeze(identity),
    mode: Number(after.mode & 0o777n)
  });
}

export async function reproveOwnedTreeDirectory(
  expected: OwnedTreeDirectoryProof,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeDirectoryProof> {
  const current = await proveOwnedTreeDirectory(expected.path, options);
  if (
    current.physicalPath !== expected.physicalPath
    || !sameOwnedTreeIdentity(current.identity, expected.identity)
  ) {
    throw driftedOwnedTree("Companion directory identity changed");
  }
  return current;
}

export async function withOwnedTreeWritableDirectory<T>(
  handle: FileHandle,
  proof: OwnedTreeDirectoryProof,
  expectedMode: number,
  options: OwnedTreeMutationOptions,
  operation: () => Promise<T>
): Promise<T> {
  const assertExactMode = async (mode: number): Promise<void> => {
    await assertOwnedTreeDirectoryHandle(handle, proof);
    const current = await handle.stat({ bigint: true });
    if (Number(current.mode & 0o777n) !== mode) {
      throw driftedOwnedTree("Companion cleanup parent permission mode changed");
    }
  };
  await assertExactMode(expectedMode);
  if ((expectedMode & 0o300) === 0o300) return operation();
  await assertOwnedTreeLeaseBoundary(
    options,
    "cleanup-parent-chmod-writable",
    [proof.path]
  );
  await reproveOwnedTreeDirectory(proof, options);
  await assertExactMode(expectedMode);
  await handle.chmod(0o700);
  let operationError: unknown;
  let result: T | undefined;
  try {
    await assertOwnedTreeMutationCompleted(
      options,
      "cleanup-parent-chmod-writable",
      [proof.path]
    );
    await assertExactMode(0o700);
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let restoreError: unknown;
  try {
    await assertOwnedTreeLeaseBoundary(
      options,
      "cleanup-parent-chmod-restore",
      [proof.path]
    );
    await assertExactMode(0o700);
    await handle.chmod(expectedMode);
    await handle.sync();
    let completionError: unknown;
    try {
      await assertOwnedTreeMutationCompleted(
        options,
        "cleanup-parent-chmod-restore",
        [proof.path]
      );
    } catch (error) {
      completionError = error;
    }
    try {
      await assertExactMode(expectedMode);
      await reproveOwnedTreeDirectory(proof, options);
    } catch (error) {
      throw uncertainOwnedTree(
        "Companion cleanup parent permission restoration is uncertain",
        completionError === undefined ? [error] : [completionError, error]
      );
    }
  } catch (error) {
    restoreError = error;
  }
  if (restoreError !== undefined) {
    throw uncertainOwnedTree(
      "Companion cleanup parent permission restoration failed",
      operationError === undefined ? [restoreError] : [operationError, restoreError]
    );
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

export async function fsyncOwnedTreeDirectory(
  proof: OwnedTreeDirectoryProof,
  options: OwnedTreeMutationOptions,
  boundary: OwnedTreeMutationBoundary
): Promise<void> {
  await assertOwnedTreeLeaseBoundary(options, boundary, [proof.path]);
  await beforeOwnedTreeVerification(options, "directory-fsync-verify", [proof.path]);
  await reproveOwnedTreeDirectory(proof, options);
  await afterOwnedTreeVerification(options, "directory-fsync-verify", [proof.path]);
  await reproveOwnedTreeDirectory(proof, options);
  if (options.hooks?.fsyncDirectory) {
    await options.hooks.fsyncDirectory(proof.path, proof.identity);
    await assertOwnedTreeMutationCompleted(options, boundary, [proof.path]);
    return;
  }
  let handle: FileHandle;
  try {
    handle = await openDirectory(proof.path, options);
  } catch (error) {
    throw uncertainOwnedTree("Companion directory durability could not be established", [error]);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameOwnedTreeIdentity(identityFromStats(opened), proof.identity)) {
      throw driftedOwnedTree("Companion directory changed before durability sync");
    }
    await handle.sync();
    await assertOwnedTreeMutationCompleted(options, boundary, [proof.path]);
  } catch (error) {
    throw uncertainOwnedTree("Companion directory durability could not be established", [error]);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
