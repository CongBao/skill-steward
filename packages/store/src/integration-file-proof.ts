import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  link,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  driftedFileTransaction,
  failedFileTransaction,
  fingerprintIntegrationFileBytes,
  invalidFileTransaction,
  IntegrationFileTransactionError,
  normalizeIntegrationMaxBytes,
  normalizeIntegrationPath,
  pendingFileCleanup,
  uncertainFileTransaction,
  type IntegrationDirectoryProof,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationOwnedFileProof,
  type IntegrationPhysicalIdentity
} from "./integration-file-domain.js";
import { assertIntegrationMutationLeaseOwned } from "./integration-mutation-lease.js";

export interface ExactIntegrationFile {
  state: "file";
  bytes: Buffer;
  fingerprint: string;
  mode: number;
  metadata: BigIntStats;
}

export type ExactIntegrationSnapshot =
  | { state: "absent" }
  | ExactIntegrationFile;

export type IntegrationRenameOutcome =
  | { state: "not-published"; cause: unknown }
  | { state: "published"; destination: ExactIntegrationFile }
  | { state: "uncertain"; error: ReturnType<typeof uncertainFileTransaction> };

export interface ExactIntegrationMoveInput {
  sourcePath: string;
  destinationPath: string;
  source: ExactIntegrationFile;
  destinationBefore: IntegrationFileExpectedState;
  destinationAfter: IntegrationFileContentState;
  maxBytes: number;
  proofs: readonly IntegrationDirectoryProof[];
  options: IntegrationFileMutationOptions;
  label: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function sameDirectoryIdentity(
  left: IntegrationPhysicalIdentity,
  right: BigIntStats
): boolean {
  return left.device === right.dev && left.inode === right.ino;
}

export function integrationPhysicalIdentity(metadata: BigIntStats): IntegrationPhysicalIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

export function sameExactIntegrationFile(left: BigIntStats, right: BigIntStats): boolean {
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

export function sameIntegrationFileAcrossRename(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function assertRegularFile(metadata: BigIntStats, maxBytes: number, label: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw driftedFileTransaction(`${label} must be a singly linked regular file`);
  }
  if (metadata.size > BigInt(maxBytes)) {
    throw driftedFileTransaction(`${label} exceeds the byte limit`);
  }
}

async function inspectDirectory(path: string, label: string): Promise<IntegrationDirectoryProof> {
  const initial = await lstat(path, { bigint: true }).catch((error: unknown) => {
    throw driftedFileTransaction(`${label} is unavailable`, error);
  });
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw driftedFileTransaction(`${label} must be a physical directory`);
  }
  const physicalPath = await realpath(path).catch((error: unknown) => {
    throw driftedFileTransaction(`${label} physical path is unavailable`, error);
  });
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  ).catch((error: unknown) => {
    throw driftedFileTransaction(`${label} cannot be opened without following links`, error);
  });
  let result: IntegrationDirectoryProof | undefined;
  let primary: unknown;
  try {
    const opened = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} opened identity is unavailable`, error);
    });
    const after = await lstat(path, { bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} path changed during inspection`, error);
    });
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameDirectoryIdentity(integrationPhysicalIdentity(initial), opened)
      || !sameDirectoryIdentity(integrationPhysicalIdentity(opened), after)
    ) {
      throw driftedFileTransaction(`${label} changed during inspection`);
    }
    const currentPhysicalPath = await realpath(path).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} physical path changed during inspection`, error);
    });
    if (currentPhysicalPath !== physicalPath) {
      throw driftedFileTransaction(`${label} physical path changed during inspection`);
    }
    result = { path, physicalPath, identity: integrationPhysicalIdentity(opened) };
  } catch (error) {
    primary = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primary !== undefined && closeError !== undefined) {
    throw driftedFileTransaction(
      `${label} inspection and directory handle close both failed`,
      new AggregateError([primary, closeError], `${label} dual inspection failure`)
    );
  }
  if (primary !== undefined) throw primary;
  if (closeError !== undefined) {
    throw driftedFileTransaction(`${label} directory handle could not be closed`, closeError);
  }
  return result!;
}

export async function bindIntegrationDirectoryChain(
  boundaryPath: string,
  targetPath: string
): Promise<readonly IntegrationDirectoryProof[]> {
  if (process.platform === "win32") {
    throw invalidFileTransaction(
      "Integration file transactions are unavailable on Windows in this phase"
    );
  }
  const boundary = normalizeIntegrationPath(boundaryPath, "Allowed physical boundary");
  const target = normalizeIntegrationPath(targetPath, "Integration target");
  const parent = dirname(target);
  const fromBoundary = relative(boundary, parent);
  if (fromBoundary === ".." || fromBoundary.startsWith(`..${sep}`) || isAbsolute(fromBoundary)) {
    throw invalidFileTransaction("Integration target escaped its allowed physical boundary");
  }
  const paths = [boundary];
  if (fromBoundary.length > 0) {
    let current = boundary;
    for (const component of fromBoundary.split(sep)) {
      if (!component || component === "." || component === "..") {
        throw invalidFileTransaction("Integration target ancestor is invalid");
      }
      current = resolve(current, component);
      paths.push(current);
    }
  }
  const proofs: IntegrationDirectoryProof[] = [];
  for (const [index, path] of paths.entries()) {
    const proof = await inspectDirectory(
      path,
      index === 0 ? "Allowed physical boundary" : "Integration target ancestor"
    );
    if (index > 0 && dirname(proof.physicalPath) !== proofs[index - 1]!.physicalPath) {
      throw driftedFileTransaction("Integration target ancestor escaped the physical boundary");
    }
    proofs.push(proof);
  }
  return Object.freeze(proofs);
}

export async function assertIntegrationDirectoryChain(
  proofs: readonly IntegrationDirectoryProof[]
): Promise<void> {
  for (const proof of proofs) {
    const current = await lstat(proof.path, { bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction("Integration target directory chain became unavailable", error);
    });
    const physicalPath = await realpath(proof.path).catch((error: unknown) => {
      throw driftedFileTransaction("Integration target directory chain physical path is unavailable", error);
    });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || !sameDirectoryIdentity(proof.identity, current)
      || physicalPath !== proof.physicalPath
    ) {
      throw driftedFileTransaction("Integration target directory chain changed");
    }
  }
}

export async function assertIntegrationFileMutationBoundary(
  options: IntegrationFileMutationOptions,
  proofs: readonly IntegrationDirectoryProof[]
): Promise<void> {
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
  await assertIntegrationDirectoryChain(proofs);
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) throw driftedFileTransaction("Integration file exceeds the byte limit");
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position).catch(
      (error: unknown) => {
        throw driftedFileTransaction("Integration file could not be read", error);
      }
    );
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    position += bytesRead;
  }
  if (total > maxBytes) throw driftedFileTransaction("Integration file exceeds the byte limit");
  return Buffer.concat(chunks, total);
}

export async function readExactIntegrationFile(
  path: string,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  label: string
): Promise<ExactIntegrationSnapshot> {
  await assertIntegrationDirectoryChain(proofs);
  let initial: BigIntStats;
  try {
    initial = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      await assertIntegrationDirectoryChain(proofs);
      return { state: "absent" };
    }
    throw driftedFileTransaction(`${label} cannot be inspected`, error);
  }
  assertRegularFile(initial, maxBytes, label);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      throw driftedFileTransaction(`${label} cannot be opened without following links`, error);
    }
  );
  let result: ExactIntegrationSnapshot | undefined;
  let primary: unknown;
  try {
    const opened = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} opened identity is unavailable`, error);
    });
    assertRegularFile(opened, maxBytes, label);
    if (!sameExactIntegrationFile(initial, opened)) {
      throw driftedFileTransaction(`${label} changed before read`);
    }
    const bytes = await readBounded(handle, maxBytes);
    const afterRead = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} identity is unavailable after read`, error);
    });
    if (!sameExactIntegrationFile(opened, afterRead) || BigInt(bytes.length) !== opened.size) {
      throw driftedFileTransaction(`${label} changed during read`);
    }
    await assertIntegrationDirectoryChain(proofs);
    const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} path changed after read`, error);
    });
    if (!sameExactIntegrationFile(afterRead, current)) {
      throw driftedFileTransaction(`${label} path changed after read`);
    }
    const physicalPath = await realpath(path).catch((error: unknown) => {
      throw driftedFileTransaction(`${label} physical path is unavailable after read`, error);
    });
    if (dirname(physicalPath) !== proofs.at(-1)!.physicalPath) {
      throw driftedFileTransaction(`${label} escaped its physical parent`);
    }
    result = {
      state: "file",
      bytes,
      fingerprint: fingerprintIntegrationFileBytes(bytes),
      mode: Number(current.mode & 0o777n),
      metadata: current
    };
  } catch (error) {
    primary = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primary !== undefined && closeError !== undefined) {
    throw driftedFileTransaction(
      `${label} read and file handle close both failed`,
      new AggregateError([primary, closeError], `${label} dual read failure`)
    );
  }
  if (primary !== undefined) throw primary;
  if (closeError !== undefined) {
    throw driftedFileTransaction(`${label} file handle could not be closed`, closeError);
  }
  return result!;
}

/** Reads one exact cleanup authority, including a two-name retry hard-link pair. */
export async function readExactIntegrationRemovalAuthority(
  sourcePath: string,
  claimPath: string,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  label: string
): Promise<ExactIntegrationSnapshot> {
  await assertIntegrationDirectoryChain(proofs);
  const [source, claim] = await Promise.all([
    lstat(sourcePath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error)),
    lstat(claimPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error))
  ]);
  if (source === undefined && claim === undefined) return { state: "absent" };
  if (source === undefined || claim === undefined) {
    return readExactIntegrationFile(
      source === undefined ? claimPath : sourcePath,
      maxBytes,
      proofs,
      label
    );
  }
  if (
    !source.isFile()
    || source.isSymbolicLink()
    || !claim.isFile()
    || claim.isSymbolicLink()
    || source.dev !== claim.dev
    || source.ino !== claim.ino
    || source.nlink !== 2n
    || claim.nlink !== 2n
    || source.size > BigInt(maxBytes)
  ) throw driftedFileTransaction(`${label} cleanup names conflict`);
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  let metadata: BigIntStats;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== source.dev
      || opened.ino !== source.ino
      || opened.nlink !== 2n
    ) throw driftedFileTransaction(`${label} cleanup pair changed before read`);
    bytes = await readBounded(handle, maxBytes);
    metadata = await handle.stat({ bigint: true });
    if (!sameExactIntegrationFile(opened, metadata)) {
      throw driftedFileTransaction(`${label} cleanup pair changed during read`);
    }
  } finally {
    await handle.close();
  }
  await assertIntegrationDirectoryChain(proofs);
  return {
    state: "file",
    bytes,
    fingerprint: fingerprintIntegrationFileBytes(bytes),
    mode: Number(metadata.mode & 0o777n),
    metadata
  };
}

export function sameIntegrationExpectedState(
  actual: ExactIntegrationSnapshot,
  expected: IntegrationFileExpectedState
): boolean {
  if (actual.state !== expected.state) return false;
  if (actual.state === "absent" || expected.state === "absent") return true;
  return actual.fingerprint === expected.fingerprint
    && actual.mode === expected.mode
    && actual.bytes.equals(Buffer.from(expected.bytes));
}

export async function requireIntegrationExpectedState(
  path: string,
  expected: IntegrationFileExpectedState,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  label: string
): Promise<ExactIntegrationSnapshot> {
  const actual = await readExactIntegrationFile(path, maxBytes, proofs, label);
  if (!sameIntegrationExpectedState(actual, expected)) {
    throw driftedFileTransaction(`${label} no longer matches the reviewed bytes`);
  }
  return actual;
}

export async function syncIntegrationParent(
  proofs: readonly IntegrationDirectoryProof[],
  options: IntegrationFileMutationOptions
): Promise<void> {
  await assertIntegrationFileMutationBoundary(options, proofs);
  const parent = proofs.at(-1)!;
  const handle = await open(
    parent.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  ).catch((error: unknown) => {
    throw driftedFileTransaction("Integration target parent cannot be opened for fsync", error);
  });
  let primary: unknown;
  try {
    const before = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction("Integration target parent identity is unavailable", error);
    });
    if (!sameDirectoryIdentity(parent.identity, before)) {
      throw driftedFileTransaction("Integration target parent changed before fsync");
    }
    await handle.sync().catch((error: unknown) => {
      throw failedFileTransaction("Integration target parent could not be synchronized", error);
    });
    const after = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw driftedFileTransaction("Integration target parent identity is unavailable after fsync", error);
    });
    if (!sameDirectoryIdentity(parent.identity, after)) {
      throw driftedFileTransaction("Integration target parent changed during fsync");
    }
  } catch (error) {
    primary = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primary !== undefined && closeError !== undefined) {
    throw failedFileTransaction(
      "Integration target parent sync and handle close both failed",
      new AggregateError([primary, closeError], "Integration parent dual sync failure")
    );
  }
  if (primary !== undefined) throw primary;
  if (closeError !== undefined) {
    throw failedFileTransaction("Integration target parent handle could not be closed", closeError);
  }
}

async function removeFailedWriteViaQuarantine(
  path: string,
  expected: BigIntStats,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  options: IntegrationFileMutationOptions,
  label: string,
  deterministicClaimPath?: string
): Promise<void> {
  await assertIntegrationFileMutationBoundary(options, proofs);
  const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
    throw pendingFileCleanup(`${label} failed-write path is unavailable`, [error]);
  });
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1n
    || current.dev !== expected.dev
    || current.ino !== expected.ino
  ) {
    throw pendingFileCleanup(`${label} failed-write artifact ownership changed`, []);
  }
  const claimPath = deterministicClaimPath ?? `${path}.cleanup-${randomUUID()}.claim`;
  await requireIntegrationExpectedState(
    claimPath,
    { state: "absent" },
    maxBytes,
    proofs,
    `${label} failed-write cleanup claim`
  );
  await assertIntegrationFileMutationBoundary(options, proofs);
  let renameError: unknown;
  try {
    await rename(path, claimPath);
  } catch (error) {
    renameError = error;
  }
  const [source, claim] = await Promise.all([
    lstat(path, { bigint: true }).then((value) => ({ state: "file" as const, value })).catch(
      (error: unknown) => isMissing(error)
        ? { state: "absent" as const }
        : { state: "error" as const, error }
    ),
    lstat(claimPath, { bigint: true }).then((value) => ({ state: "file" as const, value })).catch(
      (error: unknown) => isMissing(error)
        ? { state: "absent" as const }
        : { state: "error" as const, error }
    )
  ]);
  const sourceExact = source.state === "file"
    && source.value.dev === expected.dev
    && source.value.ino === expected.ino;
  const claimExact = claim.state === "file"
    && claim.value.dev === expected.dev
    && claim.value.ino === expected.ino;
  if (!(source.state === "absent" && claimExact)) {
    if (sourceExact && claim.state === "absent") {
      throw pendingFileCleanup(`${label} cleanup claim rename did not commit`, [renameError]);
    }
    if (source.state === "absent" && claim.state === "file" && !claimExact) {
      try {
        const destination = await lstat(path, { bigint: true }).then(
          () => "present" as const,
          (error: unknown) => isMissing(error) ? "absent" as const : Promise.reject(error)
        );
        if (destination !== "absent") throw new Error(`${label} replacement destination is occupied`);
        await assertIntegrationFileMutationBoundary(options, proofs);
        await link(claimPath, path);
        await assertIntegrationFileMutationBoundary(options, proofs);
        await unlink(claimPath);
        await syncIntegrationParent(proofs, options);
      } catch (restoreError) {
        throw pendingFileCleanup(
          `${label} replacement could not be preserved after cleanup race`,
          [renameError, restoreError]
        );
      }
    }
    const probeErrors = [renameError];
    if (source.state === "error") probeErrors.push(source.error);
    if (claim.state === "error") probeErrors.push(claim.error);
    throw pendingFileCleanup(`${label} cleanup claim outcome is uncertain`, probeErrors);
  }
  const reproved = await lstat(claimPath, { bigint: true }).catch((error: unknown) => {
    throw pendingFileCleanup(`${label} cleanup claim cannot be re-proven`, [error]);
  });
  if (reproved.dev !== expected.dev || reproved.ino !== expected.ino) {
    throw pendingFileCleanup(`${label} cleanup claim identity changed`, []);
  }
  await assertIntegrationFileMutationBoundary(options, proofs);
  await unlink(claimPath).catch((error: unknown) => {
    throw pendingFileCleanup(`${label} cleanup claim could not be removed`, [error]);
  });
  await syncIntegrationParent(proofs, options);
}

export async function writeOwnedIntegrationSibling(
  path: string,
  content: IntegrationFileContentState,
  proofs: readonly IntegrationDirectoryProof[],
  options: IntegrationFileMutationOptions,
  maxBytes: number,
  label: string,
  ownedMode = 0o600,
  deterministicCleanupClaimPath?: string
): Promise<{ state: ExactIntegrationFile; proof: IntegrationOwnedFileProof }> {
  await assertIntegrationFileMutationBoundary(options, proofs);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    ownedMode
  ).catch((error: unknown) => {
    throw failedFileTransaction(`${label} could not be created exclusively`, error);
  });
  let created: BigIntStats | undefined;
  let written: BigIntStats | undefined;
  let primary: unknown;
  try {
    created = await handle.stat({ bigint: true });
    assertRegularFile(created, maxBytes, label);
    if (created.size !== 0n || Number(created.mode & 0o777n) !== ownedMode) {
      throw failedFileTransaction(`${label} exclusive creation could not be verified`);
    }
    await handle.writeFile(content.bytes);
    await handle.chmod(ownedMode);
    await handle.sync();
    written = await handle.stat({ bigint: true });
    assertRegularFile(written, maxBytes, label);
    if (
      written.size !== BigInt(content.bytes.byteLength)
      || Number(written.mode & 0o777n) !== ownedMode
    ) {
      throw failedFileTransaction(`${label} write could not be verified`);
    }
  } catch (error) {
    primary = error instanceof IntegrationFileTransactionError
      ? error
      : failedFileTransaction(`${label} could not be durably written`, error);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      primary = primary === undefined
        ? failedFileTransaction(`${label} handle could not be closed`, error)
        : pendingFileCleanup(
            `${label} write and handle cleanup both failed`,
            [primary, error]
          );
    }
  }
  if (primary !== undefined) {
    const cleanupErrors: unknown[] = [];
    if (created) {
      try {
        await removeFailedWriteViaQuarantine(
          path,
          created,
          maxBytes,
          proofs,
          options,
          label,
          deterministicCleanupClaimPath
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      cleanupErrors.push(new Error(`${label} failed before ownership could be recorded`));
    }
    if (cleanupErrors.length > 0) {
      throw pendingFileCleanup(
        `${label} failed and its owned artifact cleanup is pending`,
        [primary, ...cleanupErrors]
      );
    }
    throw primary;
  }
  let state: ExactIntegrationSnapshot;
  try {
    state = await readExactIntegrationFile(path, maxBytes, proofs, label);
  } catch (error) {
    throw pendingFileCleanup(
      `${label} path ownership could not be proven after handle close`,
      [error]
    );
  }
  if (
    !written
    || state.state !== "file"
    || !sameExactIntegrationFile(written, state.metadata)
    || state.fingerprint !== content.fingerprint
  ) {
    throw pendingFileCleanup(
      `${label} was replaced or changed after its verified handle write`,
      []
    );
  }
  return {
    state,
    proof: {
      path,
      identity: integrationPhysicalIdentity(state.metadata),
      fingerprint: state.fingerprint,
      bytes: state.bytes.length,
      mode: state.mode
    }
  };
}

async function probeOwned(
  path: string,
  expected: ExactIntegrationFile,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[]
): Promise<"missing" | "exact" | "different" | { error: unknown }> {
  try {
    const state = await readExactIntegrationFile(path, maxBytes, proofs, "Owned integration file");
    if (state.state === "absent") return "missing";
    return sameIntegrationFileAcrossRename(expected.metadata, state.metadata)
      && state.fingerprint === expected.fingerprint
      && state.bytes.equals(expected.bytes)
      ? "exact"
      : "different";
  } catch (error) {
    return { error };
  }
}

export async function classifyIntegrationRename(
  sourcePath: string,
  destinationPath: string,
  source: ExactIntegrationFile,
  destinationBefore: IntegrationFileExpectedState,
  destinationAfter: IntegrationFileContentState,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  renameError: unknown
): Promise<IntegrationRenameOutcome> {
  try {
    await assertIntegrationDirectoryChain(proofs);
  } catch (error) {
    return { state: "uncertain", error: uncertainFileTransaction(
      "Integration publication parent changed while classifying rename",
      [renameError, error]
    ) };
  }
  const [sourceProbe, destinationProbe] = await Promise.all([
    probeOwned(sourcePath, source, maxBytes, proofs),
    readExactIntegrationFile(destinationPath, maxBytes, proofs, "Integration destination")
      .then((state) => ({ state: "ok" as const, value: state }))
      .catch((error: unknown) => ({ state: "error" as const, error }))
  ]);
  try {
    await assertIntegrationDirectoryChain(proofs);
  } catch (error) {
    return { state: "uncertain", error: uncertainFileTransaction(
      "Integration publication parent changed during rename probing",
      [renameError, error]
    ) };
  }
  if (
    sourceProbe === "missing"
    && destinationProbe.state === "ok"
    && destinationProbe.value.state === "file"
    && sameIntegrationExpectedState(destinationProbe.value, destinationAfter)
    && sameIntegrationFileAcrossRename(source.metadata, destinationProbe.value.metadata)
  ) {
    return { state: "published", destination: destinationProbe.value };
  }
  if (
    sourceProbe === "exact"
    && destinationProbe.state === "ok"
    && sameIntegrationExpectedState(destinationProbe.value, destinationBefore)
  ) {
    return { state: "not-published", cause: renameError };
  }
  const causes = [renameError];
  if (typeof sourceProbe === "object") causes.push(sourceProbe.error);
  if (destinationProbe.state === "error") causes.push(destinationProbe.error);
  return {
    state: "uncertain",
    error: uncertainFileTransaction("Integration publication outcome could not be proven", causes)
  };
}

/**
 * Shared exact recovery move. Recovery destinations must be absent, so an
 * exclusive hard-link reservation prevents POSIX rename from overwriting a
 * replacement. The source alias is removed only after both names are re-proven.
 */
export async function moveExactIntegrationFileClaimed(
  input: ExactIntegrationMoveInput
): Promise<ExactIntegrationFile> {
  await assertIntegrationFileMutationBoundary(input.options, input.proofs);
  const [source, destination] = await Promise.all([
    requireIntegrationExpectedState(
      input.sourcePath,
      {
        state: "file",
        bytes: input.source.bytes,
        fingerprint: input.source.fingerprint,
        mode: input.source.mode
      },
      input.maxBytes,
      input.proofs,
      `${input.label} source reproof`
    ),
    requireIntegrationExpectedState(
      input.destinationPath,
      input.destinationBefore,
      input.maxBytes,
      input.proofs,
      `${input.label} destination reproof`
    )
  ]);
  if (
    source.state !== "file"
    || !sameExactIntegrationFile(input.source.metadata, source.metadata)
    || !sameIntegrationExpectedState(destination, input.destinationBefore)
  ) throw driftedFileTransaction(`${input.label} exact names changed before mutation`);
  if (input.destinationBefore.state !== "absent") {
    throw invalidFileTransaction(`${input.label} requires an absent no-overwrite destination`);
  }
  await assertIntegrationMutationLeaseOwned(
    input.options.leaseContext,
    input.options.stateDirectory
  );
  let linkError: unknown;
  try {
    await link(input.sourcePath, input.destinationPath);
  } catch (error) {
    linkError = error;
  }
  const [linkedSource, linkedDestination] = await Promise.all([
    lstat(input.sourcePath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error)),
    lstat(input.destinationPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error))
  ]).catch((error: unknown) => {
    throw uncertainFileTransaction(`${input.label} link outcome could not be probed`, [
      linkError,
      error
    ]);
  });
  const exactLinkedPair = linkedSource !== undefined
    && linkedDestination !== undefined
    && linkedSource.dev === source.metadata.dev
    && linkedSource.ino === source.metadata.ino
    && linkedDestination.dev === source.metadata.dev
    && linkedDestination.ino === source.metadata.ino;
  if (!exactLinkedPair) {
    if (linkedSource !== undefined && linkedDestination === undefined && linkError !== undefined) {
      throw failedFileTransaction(`${input.label} no-overwrite link did not commit`, linkError);
    }
    if (
      linkedSource !== undefined
      && linkedSource.dev === source.metadata.dev
      && linkedSource.ino === source.metadata.ino
      && linkedDestination !== undefined
      && linkError instanceof Error
      && "code" in linkError
      && linkError.code === "EEXIST"
    ) {
      throw driftedFileTransaction(
        `${input.label} no-overwrite destination was occupied; replacement was preserved`,
        linkError
      );
    }
    throw uncertainFileTransaction(
      `${input.label} no-overwrite link outcome is uncertain; both names were preserved`,
      [linkError]
    );
  }
  await assertIntegrationMutationLeaseOwned(
    input.options.leaseContext,
    input.options.stateDirectory
  );
  let unlinkError: unknown;
  try {
    await unlink(input.sourcePath);
  } catch (error) {
    unlinkError = error;
  }
  const [sourceMetadata, destinationMetadata] = await Promise.all([
    lstat(input.sourcePath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error)),
    lstat(input.destinationPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error))
  ]).catch((error: unknown) => {
    throw uncertainFileTransaction(`${input.label} alias-removal outcome could not be probed`, [
      unlinkError,
      error
    ]);
  });
  if (
    sourceMetadata === undefined
    && destinationMetadata !== undefined
    && destinationMetadata.dev === source.metadata.dev
    && destinationMetadata.ino === source.metadata.ino
  ) {
    const destinationAfter = await requireIntegrationExpectedState(
      input.destinationPath,
      input.destinationAfter,
      input.maxBytes,
      input.proofs,
      `${input.label} destination outcome`
    );
    if (
      destinationAfter.state !== "file"
      || !sameIntegrationFileAcrossRename(source.metadata, destinationAfter.metadata)
    ) {
      throw uncertainFileTransaction(`${input.label} destination identity changed after link`, []);
    }
    await syncIntegrationParent(input.proofs, input.options).catch((error: unknown) => {
      throw uncertainFileTransaction(
        `${input.label} committed but parent durability is uncertain`,
        [error]
      );
    });
    return destinationAfter;
  }
  if (
    sourceMetadata !== undefined
    && destinationMetadata !== undefined
    && sourceMetadata.dev === source.metadata.dev
    && sourceMetadata.ino === source.metadata.ino
    && destinationMetadata.dev === source.metadata.dev
    && destinationMetadata.ino === source.metadata.ino
  ) {
    await assertIntegrationMutationLeaseOwned(
      input.options.leaseContext,
      input.options.stateDirectory
    );
    try {
      await unlink(input.destinationPath);
      const restoredSource = await requireIntegrationExpectedState(
        input.sourcePath,
        {
          state: "file",
          bytes: source.bytes,
          fingerprint: source.fingerprint,
          mode: source.mode
        },
        input.maxBytes,
        input.proofs,
        `${input.label} rolled-back source`
      );
      if (
        restoredSource.state !== "file"
        || !sameIntegrationFileAcrossRename(source.metadata, restoredSource.metadata)
      ) throw new Error(`${input.label} source identity changed during link rollback`);
      await syncIntegrationParent(input.proofs, input.options);
    } catch (rollbackError) {
      throw uncertainFileTransaction(
        `${input.label} linked names could not be rolled back after source unlink failure`,
        [unlinkError, rollbackError]
      );
    }
  }
  throw uncertainFileTransaction(
    `${input.label} linked destination is preserved but source alias removal is incomplete`,
    [unlinkError]
  );
}

export async function removeExactIntegrationFileClaimed(
  input: Omit<ExactIntegrationMoveInput, "destinationBefore" | "destinationAfter" | "destinationPath">
    & { claimPath: string; allowMissing?: boolean }
): Promise<void> {
  return removeExactIntegrationFileStateClaimed({
    sourcePath: input.sourcePath,
    claimPath: input.claimPath,
    expected: {
      state: "file",
      bytes: input.source.bytes,
      fingerprint: input.source.fingerprint,
      mode: input.source.mode
    },
    identity: integrationPhysicalIdentity(input.source.metadata),
    maxBytes: input.maxBytes,
    proofs: input.proofs,
    options: input.options,
    label: input.label
  });
}

async function removeExactIntegrationFileStateClaimed(input: {
  sourcePath: string;
  claimPath: string;
  expected: IntegrationFileContentState;
  identity: IntegrationPhysicalIdentity;
  maxBytes: number;
  proofs: readonly IntegrationDirectoryProof[];
  options: IntegrationFileMutationOptions;
  label: string;
}): Promise<void> {
  if (input.sourcePath !== input.claimPath) {
    await collapseIntegrationHardLinkPairClaimed(
      input.claimPath,
      input.sourcePath,
      input.proofs,
      input.options,
      `${input.label} removal transition`,
      {
        fingerprint: input.expected.fingerprint,
        bytes: input.expected.bytes,
        mode: input.expected.mode,
        maxBytes: input.maxBytes,
        identity: input.identity
      }
    );
  }
  if (input.sourcePath === input.claimPath) {
    const direct = await readExactIntegrationFile(
      input.sourcePath,
      input.maxBytes,
      input.proofs,
      `${input.label} removal source`
    );
    if (direct.state === "absent") {
      await syncIntegrationParent(input.proofs, input.options).catch((error: unknown) => {
        throw uncertainFileTransaction(
          `${input.label} removal name is absent but parent durability is uncertain`,
          [error]
        );
      });
      return;
    }
    if (
      !sameIntegrationExpectedState(direct, input.expected)
      || !sameDirectoryIdentity(input.identity, direct.metadata)
    ) throw pendingFileCleanup(`${input.label} removal source was replaced`, []);
    await assertIntegrationFileMutationBoundary(input.options, input.proofs);
    let unlinkError: unknown;
    try {
      await unlink(input.sourcePath);
    } catch (error) {
      unlinkError = error;
    }
    const after = await readExactIntegrationFile(
      input.sourcePath,
      input.maxBytes,
      input.proofs,
      `${input.label} removal outcome probe`
    );
    if (after.state !== "absent") {
      throw pendingFileCleanup(`${input.label} removal did not commit`, [unlinkError]);
    }
    await syncIntegrationParent(input.proofs, input.options).catch((error: unknown) => {
      throw uncertainFileTransaction(
        `${input.label} removal committed but parent durability is uncertain`,
        [error]
      );
    });
    return;
  }
  let [source, claim] = await Promise.all([
    readExactIntegrationFile(
      input.sourcePath,
      input.maxBytes,
      input.proofs,
      `${input.label} removal source`
    ),
    readExactIntegrationFile(
      input.claimPath,
      input.maxBytes,
      input.proofs,
      `${input.label} removal claim`
    )
  ]);
  if (source.state === "absent" && claim.state === "absent") {
    await syncIntegrationParent(input.proofs, input.options).catch((error: unknown) => {
      throw uncertainFileTransaction(
        `${input.label} removal names are absent but parent durability is uncertain`,
        [error]
      );
    });
    return;
  }
  if (source.state === "file" && claim.state === "absent") {
    if (
      !sameIntegrationExpectedState(source, input.expected)
      || !sameDirectoryIdentity(input.identity, source.metadata)
    ) throw pendingFileCleanup(`${input.label} removal source was replaced`, []);
    claim = await moveExactIntegrationFileClaimed({
      sourcePath: input.sourcePath,
      destinationPath: input.claimPath,
      source,
      destinationBefore: { state: "absent" },
      destinationAfter: input.expected,
      maxBytes: input.maxBytes,
      proofs: input.proofs,
      options: input.options,
      label: `${input.label} removal claim`
    });
    source = { state: "absent" };
  } else if (source.state === "absent" && claim.state === "file") {
    if (
      !sameIntegrationExpectedState(claim, input.expected)
      || !sameDirectoryIdentity(input.identity, claim.metadata)
    ) throw pendingFileCleanup(`${input.label} removal claim was replaced`, []);
  } else {
    throw pendingFileCleanup(`${input.label} removal names conflict`, []);
  }
  if (claim.state !== "file") {
    throw pendingFileCleanup(`${input.label} removal claim is unavailable`, []);
  }
  const reproved = await readExactIntegrationFile(
    input.claimPath,
    input.maxBytes,
    input.proofs,
    `${input.label} removal claim reproof`
  );
  if (
    reproved.state !== "file"
    || !sameExactIntegrationFile(claim.metadata, reproved.metadata)
    || !sameDirectoryIdentity(input.identity, reproved.metadata)
    || !sameIntegrationExpectedState(reproved, input.expected)
  ) throw pendingFileCleanup(`${input.label} removal claim changed`, []);
  await assertIntegrationFileMutationBoundary(input.options, input.proofs);
  let unlinkError: unknown;
  try {
    await unlink(input.claimPath);
  } catch (error) {
    unlinkError = error;
  }
  const after = await readExactIntegrationFile(
    input.claimPath,
    input.maxBytes,
    input.proofs,
    `${input.label} removal outcome probe`
  );
  if (after.state !== "absent") {
    throw pendingFileCleanup(`${input.label} removal did not commit`, [unlinkError]);
  }
  await syncIntegrationParent(input.proofs, input.options).catch((error: unknown) => {
    throw uncertainFileTransaction(
      `${input.label} removal committed but parent durability is uncertain`,
      [error]
    );
  });
}

/** Reconciles the retry state left when a no-overwrite link committed but alias unlink failed. */
export async function collapseIntegrationHardLinkPairClaimed(
  retainedPath: string,
  aliasPath: string,
  proofs: readonly IntegrationDirectoryProof[],
  options: IntegrationFileMutationOptions,
  label: string,
  authority: {
    fingerprint: string;
    mode: number;
    maxBytes: number;
    bytes?: Uint8Array;
    identity?: IntegrationPhysicalIdentity;
  }
): Promise<boolean> {
  await assertIntegrationFileMutationBoundary(options, proofs);
  const [retained, alias] = await Promise.all([
    lstat(retainedPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error)),
    lstat(aliasPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error))
  ]);
  if (retained === undefined || alias === undefined) return false;
  if (
    !retained.isFile()
    || retained.isSymbolicLink()
    || !alias.isFile()
    || alias.isSymbolicLink()
    || retained.dev !== alias.dev
    || retained.ino !== alias.ino
    || retained.nlink !== 2n
    || alias.nlink !== 2n
    || Number(retained.mode & 0o777n) !== authority.mode
    || retained.size > BigInt(authority.maxBytes)
    || authority.identity !== undefined
      && !sameDirectoryIdentity(authority.identity, retained)
  ) return false;
  const handle = await open(
    retainedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== retained.dev
      || opened.ino !== retained.ino
      || opened.nlink !== 2n
    ) throw driftedFileTransaction(`${label} hard-link authority changed before read`);
    bytes = await readBounded(handle, authority.maxBytes);
    const after = await handle.stat({ bigint: true });
    if (!sameExactIntegrationFile(opened, after)) {
      throw driftedFileTransaction(`${label} hard-link authority changed during read`);
    }
  } finally {
    await handle.close();
  }
  if (
    fingerprintIntegrationFileBytes(bytes) !== authority.fingerprint
    || authority.bytes !== undefined
      && !bytes.equals(Buffer.from(authority.bytes))
  ) return false;
  await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
  let unlinkError: unknown;
  try {
    await unlink(aliasPath);
  } catch (error) {
    unlinkError = error;
  }
  const [retainedAfter, aliasAfter] = await Promise.all([
    lstat(retainedPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error)),
    lstat(aliasPath, { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? undefined : Promise.reject(error))
  ]).catch((error: unknown) => {
    throw uncertainFileTransaction(`${label} hard-link retry outcome could not be probed`, [
      unlinkError,
      error
    ]);
  });
  if (
    aliasAfter !== undefined
    || retainedAfter === undefined
    || retainedAfter.dev !== retained.dev
    || retainedAfter.ino !== retained.ino
    || retainedAfter.nlink !== 1n
  ) {
    throw uncertainFileTransaction(
      `${label} hard-link retry state could not be collapsed`,
      [unlinkError]
    );
  }
  await syncIntegrationParent(proofs, options).catch((error: unknown) => {
    throw uncertainFileTransaction(
      `${label} hard-link retry collapsed but parent durability is uncertain`,
      [unlinkError, error]
    );
  });
  return true;
}

export async function removeExactOwnedIntegrationFile(
  proof: IntegrationOwnedFileProof,
  expected: IntegrationFileContentState,
  maxBytes: number,
  proofs: readonly IntegrationDirectoryProof[],
  options: IntegrationFileMutationOptions,
  allowMissing = false,
  deterministicClaimPath?: string
): Promise<void> {
  if (
    expected.fingerprint !== proof.fingerprint
    || expected.bytes.length !== proof.bytes
    || expected.mode !== proof.mode
  ) throw pendingFileCleanup("Owned integration cleanup proof is inconsistent", []);
  try {
    await removeExactIntegrationFileStateClaimed({
      sourcePath: proof.path,
      claimPath: deterministicClaimPath ?? `${proof.path}.cleanup-${randomUUID()}.claim`,
      expected,
      identity: proof.identity,
      maxBytes,
      proofs,
      options,
      label: "Owned integration cleanup"
    });
    return;
  } catch (error) {
    throw pendingFileCleanup("Owned integration cleanup is incomplete", [error]);
  }

}

export function integrationOwnedSibling(
  targetPath: string,
  transactionId: string,
  suffix: string
): string {
  return resolve(
    dirname(targetPath),
    `${basename(targetPath)}.skill-steward.${transactionId}.${suffix}`
  );
}

export async function inspectIntegrationFileStateClaimed(
  targetPathInput: string,
  allowedBoundaryPathInput: string,
  options: IntegrationFileMutationOptions,
  maxBytesInput: number
): Promise<IntegrationFileExpectedState> {
  const stateDirectory = normalizeIntegrationPath(
    options.stateDirectory,
    "Integration state directory"
  );
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  const targetPath = normalizeIntegrationPath(targetPathInput, "Integration target");
  const allowedBoundaryPath = normalizeIntegrationPath(
    allowedBoundaryPathInput,
    "Allowed physical boundary"
  );
  const maxBytes = normalizeIntegrationMaxBytes(maxBytesInput);
  const proofs = await bindIntegrationDirectoryChain(allowedBoundaryPath, targetPath);
  await assertIntegrationFileMutationBoundary(options, proofs);
  const snapshot = await readExactIntegrationFile(
    targetPath,
    maxBytes,
    proofs,
    "Integration file snapshot"
  );
  return snapshot.state === "absent"
    ? { state: "absent" }
    : {
        state: "file",
        bytes: Uint8Array.from(snapshot.bytes),
        fingerprint: snapshot.fingerprint,
        mode: snapshot.mode
      };
}

/** Internal exact deletion primitive used by restart recovery. */
export async function removeIntegrationFileStateClaimed(
  targetPathInput: string,
  allowedBoundaryPathInput: string,
  expected: IntegrationFileContentState,
  identity: IntegrationPhysicalIdentity,
  options: IntegrationFileMutationOptions,
  maxBytesInput: number
): Promise<void> {
  const targetPath = normalizeIntegrationPath(targetPathInput, "Integration removal target");
  const boundary = normalizeIntegrationPath(
    allowedBoundaryPathInput,
    "Integration removal boundary"
  );
  const maxBytes = normalizeIntegrationMaxBytes(maxBytesInput);
  const proofs = await bindIntegrationDirectoryChain(boundary, targetPath);
  await assertIntegrationFileMutationBoundary(options, proofs);
  const current = await requireIntegrationExpectedState(
    targetPath,
    expected,
    maxBytes,
    proofs,
    "Integration exact removal target"
  );
  if (current.state !== "file" || !sameDirectoryIdentity(identity, current.metadata)) {
    throw driftedFileTransaction("Integration exact removal target identity changed");
  }
  await removeExactOwnedIntegrationFile({
    path: targetPath,
    identity,
    fingerprint: current.fingerprint,
    bytes: current.bytes.length,
    mode: current.mode
  }, current, maxBytes, proofs, options);
  await syncIntegrationParent(proofs, options);
}
