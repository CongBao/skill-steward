import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { opendir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  assertCreatedOwnedTreeAncestorAuthority,
  ensureOwnedTreePosix,
  openOwnedTreePath,
  ownedTreeAuthorityState,
  ownedTreeEntryPath,
  ownedTreeManifestMode,
  ownedTreeSiblingPath,
  withOwnedTreeClaim
} from "./companion-owned-tree-authority.js";
import type {
  CreatedOwnedTreeAncestorProof,
  OwnedTreeAuthorityState,
  OwnedTreeCleanupReceipt,
  OwnedTreeHandle,
  OwnedTreeMutationOptions,
  OwnedTreeRestoreReceipt
} from "./companion-owned-tree-domain.js";
import {
  assertOwnedTreeLeaseBoundary,
  afterOwnedTreeVerification,
  assertOwnedTreeMutationCompleted,
  assertOwnedTreeVerificationBoundary,
  beforeOwnedTreeVerification,
  driftedOwnedTree,
  fsyncOwnedTreeDirectory,
  identityFromStats,
  incompleteOwnedTreeRecovery,
  invalidOwnedTree,
  lstatOwnedTree,
  pendingOwnedTreeCleanup,
  openOwnedTreeDirectoryHandle,
  proveOwnedTreeDirectory,
  reproveOwnedTreeDirectory,
  sameOwnedTreeIdentity,
  uncertainOwnedTree,
  withOwnedTreeWritableDirectory
} from "./companion-owned-tree-proof.js";
import { removeOwnedTreeAt } from "./companion-owned-tree-native.js";
import {
  assertExactOwnedTreeAuthorityState,
  moveOwnedTreeInternal
} from "./companion-owned-tree-move.js";

async function assertCleanupAncestorChain(
  state: OwnedTreeAuthorityState,
  targetDirectory: string,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const relativeTarget = relative(state.currentPath, targetDirectory);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw driftedOwnedTree("Companion cleanup parent escaped its owned root");
  }
  await reproveOwnedTreeDirectory(state.parent, options);
  const components = relativeTarget === "" ? [] : relativeTarget.split(sep);
  let path = state.currentPath;
  let relativePath = ".";
  let physicalPath = resolve(state.parent.physicalPath, basename(state.currentPath));
  for (const component of [undefined, ...components]) {
    if (component !== undefined) {
      path = resolve(path, component);
      relativePath = relativePath === "." ? component : `${relativePath}/${component}`;
      physicalPath = resolve(physicalPath, component);
    }
    const expected = state.entryIdentities.get(relativePath);
    const current = await proveOwnedTreeDirectory(path, options);
    if (
      expected === undefined
      || current.physicalPath !== physicalPath
      || !sameOwnedTreeIdentity(current.identity, expected)
    ) {
      throw driftedOwnedTree("Companion cleanup ancestor identity changed");
    }
  }
}

async function proveCleanupFile(
  state: OwnedTreeAuthorityState,
  entry: Extract<OwnedTreeAuthorityState["manifest"]["entries"][number], { kind: "file" }>,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const path = ownedTreeEntryPath(state.currentPath, entry.relativePath);
  const expectedIdentity = state.entryIdentities.get(entry.relativePath);
  if (expectedIdentity === undefined) {
    throw driftedOwnedTree("Companion cleanup entry identity is unavailable");
  }
  const metadata = await lstatOwnedTree(path, options);
  if (
    metadata === undefined
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || !sameOwnedTreeIdentity(identityFromStats(metadata), expectedIdentity)
    || metadata.size !== BigInt(entry.bytes)
    || Number(metadata.mode & 0o777n) !== ownedTreeManifestMode(entry)
  ) {
    throw driftedOwnedTree("Companion cleanup file changed before deletion");
  }
  const handle = await openOwnedTreePath(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
    undefined,
    options
  ).catch((error: unknown) => {
    throw driftedOwnedTree("Companion cleanup file could not be opened safely", error);
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameOwnedTreeIdentity(identityFromStats(opened), expectedIdentity)) {
      throw driftedOwnedTree("Companion cleanup file changed while it was opened");
    }
    const digest = createHash("sha256");
    let position = 0;
    while (position < entry.bytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, entry.bytes - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      position !== entry.bytes
      || `sha256:${digest.digest("hex")}` !== entry.sha256
      || !sameOwnedTreeIdentity(identityFromStats(after), expectedIdentity)
    ) {
      throw driftedOwnedTree("Companion cleanup file content changed before deletion");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertPartialCleanupStateOnce(
  state: OwnedTreeAuthorityState,
  options: OwnedTreeMutationOptions
): Promise<void> {
  await reproveOwnedTreeDirectory(state.parent, options);
  const root = await lstatOwnedTree(state.currentPath, options);
  if (
    root === undefined
    || root.isSymbolicLink()
    || !root.isDirectory()
    || !sameOwnedTreeIdentity(identityFromStats(root), state.rootIdentity)
  ) {
    throw driftedOwnedTree("Partial companion cleanup root identity changed");
  }
  const remaining = state.manifest.entries.filter(
    (entry) => !state.deletedEntries.has(entry.relativePath)
  );
  for (const entry of remaining) {
    const path = ownedTreeEntryPath(state.currentPath, entry.relativePath);
    const expectedIdentity = state.entryIdentities.get(entry.relativePath);
    const metadata = await lstatOwnedTree(path, options);
    if (
      expectedIdentity === undefined
      || metadata === undefined
      || metadata.isSymbolicLink()
      || (entry.kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
      || !sameOwnedTreeIdentity(identityFromStats(metadata), expectedIdentity)
      || Number(metadata.mode & 0o777n) !== ownedTreeManifestMode(entry)
      || (entry.kind === "file" && metadata.size !== BigInt(entry.bytes))
    ) {
      throw driftedOwnedTree("Partial companion cleanup entry changed");
    }
    if (entry.kind !== "directory") continue;
    const expectedNames = remaining
      .filter((candidate) => {
        if (candidate.relativePath === ".") return false;
        const candidateParent = candidate.relativePath.includes("/")
          ? candidate.relativePath.slice(0, candidate.relativePath.lastIndexOf("/"))
          : ".";
        return candidateParent === entry.relativePath;
      })
      .map(({ relativePath }) => relativePath.slice(relativePath.lastIndexOf("/") + 1))
      .sort();
    const directory = await opendir(path);
    const actualNames: string[] = [];
    try {
      while (true) {
        const child = await directory.read();
        if (child === null) break;
        actualNames.push(child.name);
        if (actualNames.length > state.manifest.entries.length) {
          throw driftedOwnedTree("Partial companion cleanup directory exceeds its bound");
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    actualNames.sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw driftedOwnedTree("Partial companion cleanup contains an unknown entry");
    }
  }
}

async function assertPartialCleanupState(
  state: OwnedTreeAuthorityState,
  options: OwnedTreeMutationOptions
): Promise<void> {
  await assertOwnedTreeVerificationBoundary(
    options,
    "partial-cleanup-tree-verify",
    [state.currentPath],
    () => assertPartialCleanupStateOnce(state, options)
  );
}

export async function cleanupOwnedTreeInternal(
  handle: OwnedTreeHandle,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeCleanupReceipt> {
  await ensureOwnedTreePosix(options);
  const state = ownedTreeAuthorityState(handle, options);
  if (state.status === "cleaned" || state.status === "restored") {
    throw invalidOwnedTree("Companion owned-tree handle is terminal");
  }
  const cleanupPath = ownedTreeSiblingPath(state.parent.path, state.transactionId, "cleanup");
  if (!state.rootRemoved && state.currentPath !== cleanupPath) {
    const moved = await moveOwnedTreeInternal(handle, cleanupPath, options);
    if (moved.state === "uncertain") throw moved.error;
    if (moved.state === "not-moved") {
      throw pendingOwnedTreeCleanup("Companion cleanup claim was not acquired", [moved.cause]);
    }
  }
  if (state.rootRemoved) {
    try {
      await fsyncOwnedTreeDirectory(state.parent, options, "rmdir-parent-fsync");
      state.status = "cleaned";
      return Object.freeze({ state: "cleaned", handle });
    } catch (error) {
      const warning = pendingOwnedTreeCleanup(
        "Companion cleanup root removal durability remains pending",
        [error]
      );
      return Object.freeze({ state: "cleanup-pending", handle, warning });
    }
  }
  if (state.deletedEntries.size === 0) {
    await assertExactOwnedTreeAuthorityState(state, options);
  } else {
    await assertPartialCleanupState(state, options);
  }
  for (const entry of [...state.manifest.entries].reverse()) {
    if (state.deletedEntries.has(entry.relativePath)) continue;
    const path = ownedTreeEntryPath(state.currentPath, entry.relativePath);
    const parent = entry.relativePath === "."
      ? state.parent
      : await proveOwnedTreeDirectory(dirname(path), options);
    const parentRelativePath = entry.relativePath === "."
      ? undefined
      : entry.relativePath.includes("/")
        ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
        : ".";
    const parentEntry = parentRelativePath === undefined
      ? undefined
      : state.manifest.entries.find(({ relativePath }) => relativePath === parentRelativePath);
    if (parentRelativePath !== undefined && parentEntry?.kind !== "directory") {
      throw driftedOwnedTree("Companion cleanup parent manifest entry is unavailable");
    }
    const parentHandle = await openOwnedTreeDirectoryHandle(parent, options);
    const mutateInParent = async <T>(operation: () => Promise<T>): Promise<T> =>
      parentEntry === undefined
        ? operation()
        : withOwnedTreeWritableDirectory(
            parentHandle,
            parent,
            ownedTreeManifestMode(parentEntry),
            options,
            operation
          );
    try {
      const expectedIdentity = state.entryIdentities.get(entry.relativePath);
      if (expectedIdentity === undefined) {
        throw driftedOwnedTree("Companion cleanup entry identity is unavailable");
      }
      if (entry.kind === "file") {
      await proveCleanupFile(state, entry, options);
      await assertOwnedTreeLeaseBoundary(options, "unlink", [path]);
      await beforeOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
      await assertCleanupAncestorChain(state, dirname(path), options);
      await afterOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
      await assertCleanupAncestorChain(state, dirname(path), options);
      await beforeOwnedTreeVerification(options, "cleanup-file-probe", [path]);
      await proveCleanupFile(state, entry, options);
      await afterOwnedTreeVerification(options, "cleanup-file-probe", [path]);
      await assertCleanupAncestorChain(state, dirname(path), options);
      await proveCleanupFile(state, entry, options);
      let removalError: unknown;
      await mutateInParent(async () => {
        try {
          await removeOwnedTreeAt(parentHandle, parent, path, false, options);
          await assertOwnedTreeMutationCompleted(options, "unlink", [path]);
        } catch (error) {
          removalError = error;
        }
      });
      await beforeOwnedTreeVerification(options, "cleanup-file-probe", [path]);
      let after = await lstatOwnedTree(path, options);
      await afterOwnedTreeVerification(options, "cleanup-file-probe", [path]);
      after = await lstatOwnedTree(path, options);
      if (after !== undefined) {
        if (!sameOwnedTreeIdentity(identityFromStats(after), expectedIdentity)) {
          throw uncertainOwnedTree(
            "Companion cleanup file was replaced during deletion",
            removalError === undefined ? [] : [removalError]
          );
        }
        const warning = pendingOwnedTreeCleanup(
          "Companion cleanup file deletion remains pending",
          removalError === undefined ? [] : [removalError]
        );
        return Object.freeze({ state: "cleanup-pending", handle, warning });
      }
      state.deletedEntries.add(entry.relativePath);
      try {
        await fsyncOwnedTreeDirectory(parent, options, "unlink-parent-fsync");
      } catch (error) {
        const warning = pendingOwnedTreeCleanup(
          "Companion cleanup file removal durability remains pending",
          removalError === undefined ? [error] : [removalError, error]
        );
        return Object.freeze({ state: "cleanup-pending", handle, warning });
      }
      continue;
      }
      const metadata = await lstatOwnedTree(path, options);
    if (
      metadata === undefined
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || !sameOwnedTreeIdentity(identityFromStats(metadata), expectedIdentity)
      || Number(metadata.mode & 0o777n) !== ownedTreeManifestMode(entry)
    ) {
      throw driftedOwnedTree("Companion cleanup directory changed before deletion");
    }
    await assertOwnedTreeLeaseBoundary(options, "rmdir", [path]);
    await beforeOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
    if (entry.relativePath === ".") await reproveOwnedTreeDirectory(state.parent, options);
    else await assertCleanupAncestorChain(state, dirname(path), options);
    await afterOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
    if (entry.relativePath === ".") await reproveOwnedTreeDirectory(state.parent, options);
    else await assertCleanupAncestorChain(state, dirname(path), options);
    await beforeOwnedTreeVerification(options, "cleanup-directory-probe", [path]);
    const rechecked = await lstatOwnedTree(path, options);
    if (
      rechecked === undefined
      || rechecked.isSymbolicLink()
      || !rechecked.isDirectory()
      || !sameOwnedTreeIdentity(identityFromStats(rechecked), expectedIdentity)
    ) {
      throw driftedOwnedTree("Companion cleanup directory changed at deletion boundary");
    }
    await afterOwnedTreeVerification(options, "cleanup-directory-probe", [path]);
    const finallyRechecked = await lstatOwnedTree(path, options);
    if (
      finallyRechecked === undefined
      || finallyRechecked.isSymbolicLink()
      || !finallyRechecked.isDirectory()
      || !sameOwnedTreeIdentity(identityFromStats(finallyRechecked), expectedIdentity)
    ) {
      throw driftedOwnedTree("Companion cleanup directory changed after verification");
    }
    let removalError: unknown;
    await mutateInParent(async () => {
      try {
        await removeOwnedTreeAt(parentHandle, parent, path, true, options);
        await assertOwnedTreeMutationCompleted(options, "rmdir", [path]);
      } catch (error) {
        removalError = error;
      }
    });
    await beforeOwnedTreeVerification(options, "cleanup-directory-probe", [path]);
    let after = await lstatOwnedTree(path, options);
    await afterOwnedTreeVerification(options, "cleanup-directory-probe", [path]);
    after = await lstatOwnedTree(path, options);
    if (after !== undefined) {
      if (!sameOwnedTreeIdentity(identityFromStats(after), expectedIdentity)) {
        throw uncertainOwnedTree(
          "Companion cleanup directory was replaced during deletion",
          removalError === undefined ? [] : [removalError]
        );
      }
      const warning = pendingOwnedTreeCleanup(
        "Companion cleanup directory deletion remains pending",
        removalError === undefined ? [] : [removalError]
      );
      return Object.freeze({ state: "cleanup-pending", handle, warning });
    }
    state.deletedEntries.add(entry.relativePath);
    if (entry.relativePath === ".") state.rootRemoved = true;
    try {
      await fsyncOwnedTreeDirectory(parent, options, "rmdir-parent-fsync");
    } catch (error) {
      const warning = pendingOwnedTreeCleanup(
        "Companion cleanup directory removal durability remains pending",
        removalError === undefined ? [error] : [removalError, error]
      );
      return Object.freeze({ state: "cleanup-pending", handle, warning });
    }
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }
  state.status = "cleaned";
  return Object.freeze({ state: "cleaned", handle });
}

export async function cleanupOwnedTree(
  handle: OwnedTreeHandle,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeCleanupReceipt> {
  return withOwnedTreeClaim(options, () => cleanupOwnedTreeInternal(handle, options));
}

export async function rollbackCreatedOwnedTreeAncestorsInternal(
  inputProofs: readonly CreatedOwnedTreeAncestorProof[],
  options: OwnedTreeMutationOptions
): Promise<void> {
  for (const proof of [...inputProofs].reverse()) {
    const authority = assertCreatedOwnedTreeAncestorAuthority(proof, options);
    await reproveOwnedTreeDirectory(proof.parent, options);
    await reproveOwnedTreeDirectory(proof, options);
    await assertOwnedTreeLeaseBoundary(options, "ancestor-rmdir", [proof.path]);
    await reproveOwnedTreeDirectory(proof, options);
    const parentHandle = await openOwnedTreeDirectoryHandle(proof.parent, options);
    let removalError: unknown;
    try {
      await removeOwnedTreeAt(parentHandle, proof.parent, proof.path, true, options);
      await assertOwnedTreeMutationCompleted(options, "ancestor-rmdir", [proof.path]);
    } catch (error) {
      removalError = error;
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
    const after = await lstatOwnedTree(proof.path, options);
    if (after !== undefined) {
      throw incompleteOwnedTreeRecovery(
        "Created companion ancestor could not be rolled back safely",
        removalError === undefined ? [] : [removalError]
      );
    }
    authority.removed = true;
    await fsyncOwnedTreeDirectory(proof.parent, options, "rmdir-parent-fsync");
  }
}

export async function rollbackCreatedOwnedTreeAncestors(
  proofs: readonly CreatedOwnedTreeAncestorProof[],
  options: OwnedTreeMutationOptions
): Promise<void> {
  await withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    await rollbackCreatedOwnedTreeAncestorsInternal(proofs, options);
  });
}

export async function restoreOwnedTreeUpgrade(
  installedHandle: OwnedTreeHandle,
  backupHandle: OwnedTreeHandle,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeRestoreReceipt> {
  return withOwnedTreeClaim(options, async () => {
    const installed = ownedTreeAuthorityState(installedHandle, options);
    const backup = ownedTreeAuthorityState(backupHandle, options);
    if (installed.status === "restored" || backup.status === "restored") {
      throw invalidOwnedTree("Restored companion owned-tree handles are terminal");
    }
    if (
      installed.transactionId !== backup.transactionId
      || installed.parent.path !== backup.parent.path
      || installed.parent.physicalPath !== backup.parent.physicalPath
      || !sameOwnedTreeIdentity(installed.parent.identity, backup.parent.identity)
    ) {
      throw invalidOwnedTree("Companion upgrade handles do not share one transaction parent");
    }
    const destinationPath = installed.currentPath;
    const cleanupPath = ownedTreeSiblingPath(
      installed.parent.path,
      installed.transactionId,
      "cleanup"
    );
    const claimed = await moveOwnedTreeInternal(installedHandle, cleanupPath, options);
    if (claimed.state !== "moved") {
      const cause = claimed.state === "uncertain" ? claimed.error : claimed.cause;
      throw incompleteOwnedTreeRecovery(
        "Installed companion tree could not be claimed for restore",
        [cause]
      );
    }
    let restored;
    try {
      restored = await moveOwnedTreeInternal(backupHandle, destinationPath, options);
    } catch (error) {
      const replacement = await moveOwnedTreeInternal(installedHandle, destinationPath, options)
        .catch((replacementError: unknown) => ({
          state: "uncertain" as const,
          error: replacementError
        }));
      const causes: unknown[] = [error];
      if (replacement.state !== "moved") causes.push(replacement);
      throw incompleteOwnedTreeRecovery(
        "Previous companion tree could not be restored",
        causes
      );
    }
    if (restored.state !== "moved") {
      const cause = restored.state === "uncertain" ? restored.error : restored.cause;
      const replacement = await moveOwnedTreeInternal(installedHandle, destinationPath, options)
        .catch((error: unknown) => ({ state: "uncertain" as const, error }));
      throw incompleteOwnedTreeRecovery(
        "Previous companion tree could not be restored",
        [cause, replacement]
      );
    }
    backup.status = "restored";
    let cleanup;
    try {
      cleanup = await cleanupOwnedTreeInternal(installedHandle, options);
    } catch (error) {
      return Object.freeze({
        state: "recovery-incomplete",
        restored: backupHandle,
        cleanup: installedHandle,
        warning: incompleteOwnedTreeRecovery(
          "Previous companion tree was restored but replacement cleanup could not continue",
          [error]
        )
      });
    }
    if (cleanup.state === "cleanup-pending") {
      return Object.freeze({
        state: "recovery-incomplete",
        restored: backupHandle,
        cleanup: installedHandle,
        warning: cleanup.warning ?? pendingOwnedTreeCleanup(
          "Restored companion cleanup remains pending",
          []
        )
      });
    }
    return Object.freeze({
      state: "restored",
      restored: backupHandle,
      cleanup: installedHandle
    });
  });
}
