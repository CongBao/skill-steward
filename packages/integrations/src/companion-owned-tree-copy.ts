import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { CompanionTreeEntry } from "./companion-domain.js";
import { inspectCompanionTree } from "./companion-manifest.js";
import {
  captureOwnedTreeEntryIdentities,
  createOwnedTreeHandle,
  ensureOwnedTreePosix,
  openOwnedTreePath,
  ownedTreeEntryPath,
  ownedTreeManifestMode,
  ownedTreeSiblingPath,
  parseOwnedTreeManifest,
  registerCreatedOwnedTreeAncestor,
  sameOwnedTreeManifest,
  validateOwnedTreeTransactionId,
  withOwnedTreeClaim
} from "./companion-owned-tree-authority.js";
import {
  rollbackCreatedOwnedTreeAncestorsInternal
} from "./companion-owned-tree-cleanup.js";
import type {
  CreatedOwnedTreeAncestorProof,
  OwnedTreeDirectoryProof,
  OwnedTreeAncestorInput,
  OwnedTreeMutationOptions,
  OwnedTreePhysicalIdentity,
  OwnedTreeStageInput,
  OwnedTreeStageResult
} from "./companion-owned-tree-domain.js";
import {
  assertOwnedTreeChild,
  assertOwnedTreeDirectoryHandle,
  afterOwnedTreeVerification,
  assertOwnedTreeLeaseBoundary,
  assertOwnedTreeMutationCompleted,
  assertOwnedTreeVerificationBoundary,
  beforeOwnedTreeVerification,
  driftedOwnedTree,
  fsyncOwnedTreeDirectory,
  identityFromStats,
  incompleteOwnedTreeRecovery,
  invalidOwnedTree,
  lstatOwnedTree,
  normalizeOwnedTreePath,
  openOwnedTreeDirectoryHandle,
  proveOwnedTreeDirectory,
  reproveOwnedTreeDirectory,
  sameOwnedTreeIdentity,
  withOwnedTreeWritableDirectory
} from "./companion-owned-tree-proof.js";
import { inspectExactOwnedTreeAt } from "./companion-owned-tree-move.js";
import { removeOwnedTreeAt } from "./companion-owned-tree-native.js";

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function assertReviewedManifest(
  path: string,
  boundaryPath: string,
  expected: OwnedTreeStageInput["expectedManifest"],
  verificationBoundary: "copy-source-manifest-verify" | "copy-stage-manifest-verify",
  options: OwnedTreeMutationOptions,
  mismatchMessage: string
): Promise<void> {
  await assertOwnedTreeVerificationBoundary(
    options,
    verificationBoundary,
    [path],
    async () => {
      const current = await inspectCompanionTree(path, {
        boundary: boundaryPath,
        platform: options.hooks?.platform ?? process.platform
      });
      if (!sameOwnedTreeManifest(current, expected)) {
        throw driftedOwnedTree(mismatchMessage);
      }
    }
  );
}

type CreatedStageEntry = {
  identity: OwnedTreePhysicalIdentity;
  kind: "directory" | "file";
};

async function assertCreatedStageAncestorChain(
  stageRoot: string,
  targetDirectory: string,
  stageParent: OwnedTreeDirectoryProof,
  createdEntries: Map<string, CreatedStageEntry>,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const relativeTarget = relative(stageRoot, targetDirectory);
  if (
    relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
  ) {
    throw driftedOwnedTree("Companion stage mutation parent escaped its owned root");
  }
  await reproveOwnedTreeDirectory(stageParent, options);
  const components = relativeTarget === "" ? [] : relativeTarget.split(sep);
  let path = stageRoot;
  let relativePath = ".";
  let physicalPath = resolve(stageParent.physicalPath, basename(stageRoot));
  for (const component of [undefined, ...components]) {
    if (component !== undefined) {
      path = resolve(path, component);
      relativePath = relativePath === "." ? component : `${relativePath}/${component}`;
      physicalPath = resolve(physicalPath, component);
    }
    const expected = createdEntries.get(relativePath);
    const current = await proveOwnedTreeDirectory(path, options);
    if (
      expected === undefined
      || expected.kind !== "directory"
      || current.physicalPath !== physicalPath
      || !sameOwnedTreeIdentity(current.identity, expected.identity)
    ) {
      throw driftedOwnedTree("Companion stage ancestor identity changed");
    }
  }
}

async function ensureCompanionParent(
  destinationPath: string,
  homeBoundaryPath: string,
  options: OwnedTreeMutationOptions
): Promise<{
  parent: Awaited<ReturnType<typeof proveOwnedTreeDirectory>>;
  created: CreatedOwnedTreeAncestorProof[];
}> {
  const home = normalizeOwnedTreePath(homeBoundaryPath, "Companion home boundary");
  const destination = normalizeOwnedTreePath(destinationPath, "Companion destination path");
  assertOwnedTreeChild(home, destination);
  const parentPath = dirname(destination);
  assertOwnedTreeChild(home, parentPath);
  const homeProof = await proveOwnedTreeDirectory(home, options);
  const components = relative(home, parentPath).split(sep);
  let current = home;
  let parentProof = homeProof;
  const created: CreatedOwnedTreeAncestorProof[] = [];
  try {
    for (const component of components) {
      if (component.length === 0 || component === "." || component === "..") {
        throw invalidOwnedTree("Companion parent path is invalid");
      }
      const next = resolve(current, component);
      const existing = await lstatOwnedTree(next, options);
      if (existing === undefined) {
        await assertOwnedTreeLeaseBoundary(options, "ancestor-mkdir", [next, current]);
        await reproveOwnedTreeDirectory(parentProof, options);
        try {
          await mkdir(next, { mode: 0o700, recursive: false });
        } catch (error) {
          throw isExists(error)
            ? driftedOwnedTree("Companion ancestor appeared during exclusive creation", error)
            : driftedOwnedTree("Companion ancestor could not be created", error);
        }
        const createdProof = await proveOwnedTreeDirectory(next, options);
        if (createdProof.physicalPath !== resolve(parentProof.physicalPath, component)) {
          throw driftedOwnedTree("Created companion ancestor escaped its physical parent");
        }
        const ancestor = Object.freeze({ ...createdProof, parent: parentProof });
        registerCreatedOwnedTreeAncestor(ancestor, options);
        created.push(ancestor);
        await assertOwnedTreeMutationCompleted(options, "ancestor-mkdir", [next, current]);
        await beforeOwnedTreeVerification(options, "ancestor-created-verify", [next]);
        await reproveOwnedTreeDirectory(createdProof, options);
        await afterOwnedTreeVerification(options, "ancestor-created-verify", [next]);
        await reproveOwnedTreeDirectory(createdProof, options);
        await fsyncOwnedTreeDirectory(parentProof, options, "ancestor-parent-fsync");
        parentProof = createdProof;
      } else {
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw driftedOwnedTree("Companion ancestor is not a physical directory");
        }
        const existingProof = await proveOwnedTreeDirectory(next, options);
        if (existingProof.physicalPath !== resolve(parentProof.physicalPath, component)) {
          throw driftedOwnedTree("Companion ancestor escaped its physical parent");
        }
        parentProof = existingProof;
      }
      current = next;
    }
    return { parent: parentProof, created };
  } catch (error) {
    if (created.length === 0) throw error;
    try {
      await rollbackCreatedOwnedTreeAncestorsInternal(created, options);
    } catch (rollbackError) {
      throw incompleteOwnedTreeRecovery(
        "Companion ancestor preparation could not be rolled back completely",
        [error, rollbackError]
      );
    }
    throw error;
  }
}

/** Package-private exact ancestor transaction shared by tree and config publication. */
export async function createOwnedTreeAncestors(
  input: OwnedTreeAncestorInput,
  options: OwnedTreeMutationOptions
): Promise<readonly CreatedOwnedTreeAncestorProof[]> {
  return withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    return Object.freeze((await ensureCompanionParent(
      input.destinationPath,
      input.homeBoundaryPath,
      options
    )).created);
  });
}

async function copyManifestFile(
  sourcePath: string,
  destinationPath: string,
  entry: Extract<CompanionTreeEntry, { kind: "file" }>,
  options: OwnedTreeMutationOptions,
  stageRoot: string,
  stageParent: OwnedTreeDirectoryProof,
  createdEntries: Map<string, CreatedStageEntry>,
  onCreated: (identity: OwnedTreePhysicalIdentity) => void
): Promise<void> {
  const sourceMetadata = await lstat(sourcePath, { bigint: true }).catch((error: unknown) => {
    throw driftedOwnedTree("Companion source file could not be inspected", error);
  });
  const sourceIdentity = identityFromStats(sourceMetadata);
  const mode = ownedTreeManifestMode(entry);
  if (
    !sourceMetadata.isFile()
    || sourceMetadata.isSymbolicLink()
    || sourceMetadata.size !== BigInt(entry.bytes)
    || Number(sourceMetadata.mode & 0o777n) !== mode
  ) {
    throw driftedOwnedTree("Companion source file no longer matches the reviewed manifest");
  }
  const sourceParent = await proveOwnedTreeDirectory(dirname(sourcePath), options);
  await beforeOwnedTreeVerification(options, "source-parent-chain-verify", [sourcePath]);
  await reproveOwnedTreeDirectory(sourceParent, options);
  await afterOwnedTreeVerification(options, "source-parent-chain-verify", [sourcePath]);
  await reproveOwnedTreeDirectory(sourceParent, options);
  const source = await openOwnedTreePath(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
    undefined,
    options
  ).catch((error: unknown) => {
    throw driftedOwnedTree("Companion source file could not be opened safely", error);
  });
  let destination: Awaited<ReturnType<typeof openOwnedTreePath>> | undefined;
  try {
    const openedSource = await source.stat({ bigint: true });
    if (
      !openedSource.isFile()
      || !sameOwnedTreeIdentity(sourceIdentity, identityFromStats(openedSource))
    ) {
      throw driftedOwnedTree("Companion source file changed while it was opened");
    }
    await assertOwnedTreeLeaseBoundary(options, "copy-file-create", [destinationPath]);
    await beforeOwnedTreeVerification(
      options,
      "copy-parent-chain-verify",
      [destinationPath]
    );
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    await afterOwnedTreeVerification(options, "copy-parent-chain-verify", [destinationPath]);
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    destination = await openOwnedTreePath(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
      options
    ).catch((error: unknown) => {
      throw driftedOwnedTree("Companion stage file could not be created exclusively", error);
    });
    const openedDestination = await destination.stat({ bigint: true });
    if (!openedDestination.isFile() || openedDestination.isSymbolicLink()) {
      throw driftedOwnedTree("Companion stage file identity is unavailable after creation");
    }
    const destinationIdentity = identityFromStats(openedDestination);
    onCreated(destinationIdentity);
    await assertOwnedTreeMutationCompleted(options, "copy-file-create", [destinationPath]);
    await beforeOwnedTreeVerification(options, "copy-file-verify", [destinationPath]);
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    const createdPath = await lstatOwnedTree(destinationPath, options);
    if (
      createdPath === undefined
      || createdPath.isSymbolicLink()
      || !createdPath.isFile()
      || !sameOwnedTreeIdentity(identityFromStats(createdPath), destinationIdentity)
    ) {
      throw driftedOwnedTree("Companion stage file identity changed after exclusive creation");
    }
    await afterOwnedTreeVerification(options, "copy-file-verify", [destinationPath]);
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    const verifiedCreatedPath = await lstatOwnedTree(destinationPath, options);
    if (
      verifiedCreatedPath === undefined
      || verifiedCreatedPath.isSymbolicLink()
      || !verifiedCreatedPath.isFile()
      || !sameOwnedTreeIdentity(identityFromStats(verifiedCreatedPath), destinationIdentity)
    ) {
      throw driftedOwnedTree("Companion stage file identity changed after verification");
    }
    const digest = createHash("sha256");
    let position = 0;
    while (position < entry.bytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, entry.bytes - position));
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await assertOwnedTreeLeaseBoundary(options, "copy-file-write", [destinationPath]);
      await beforeOwnedTreeVerification(
        options,
        "copy-parent-chain-verify",
        [destinationPath]
      );
      await assertCreatedStageAncestorChain(
        stageRoot,
        dirname(destinationPath),
        stageParent,
        createdEntries,
        options
      );
      await afterOwnedTreeVerification(options, "copy-parent-chain-verify", [destinationPath]);
      await assertCreatedStageAncestorChain(
        stageRoot,
        dirname(destinationPath),
        stageParent,
        createdEntries,
        options
      );
      const { bytesWritten } = await destination.write(chunk, 0, chunk.length, position);
      if (bytesWritten !== chunk.length) {
        throw driftedOwnedTree("Companion stage file write was incomplete");
      }
      await assertOwnedTreeMutationCompleted(options, "copy-file-write", [destinationPath]);
      position += bytesRead;
    }
    if (position !== entry.bytes || `sha256:${digest.digest("hex")}` !== entry.sha256) {
      throw driftedOwnedTree("Companion source content changed during copy");
    }
    const sourceAfter = await source.stat({ bigint: true });
    if (
      !sameOwnedTreeIdentity(sourceIdentity, identityFromStats(sourceAfter))
      || sourceAfter.size !== BigInt(entry.bytes)
      || Number(sourceAfter.mode & 0o777n) !== mode
    ) {
      throw driftedOwnedTree("Companion source file changed during copy");
    }
    await assertOwnedTreeLeaseBoundary(options, "copy-file-chmod", [destinationPath]);
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    await destination.chmod(mode);
    await assertOwnedTreeMutationCompleted(options, "copy-file-chmod", [destinationPath]);
    await assertOwnedTreeLeaseBoundary(options, "copy-file-fsync", [destinationPath]);
    await assertCreatedStageAncestorChain(
      stageRoot,
      dirname(destinationPath),
      stageParent,
      createdEntries,
      options
    );
    await destination.sync();
    await assertOwnedTreeMutationCompleted(options, "copy-file-fsync", [destinationPath]);
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function copyReviewedManifest(
  sourceRoot: string,
  stageRoot: string,
  manifest: OwnedTreeStageInput["expectedManifest"],
  options: OwnedTreeMutationOptions,
  createdEntries: Map<string, CreatedStageEntry>,
  stageParent: OwnedTreeDirectoryProof
): Promise<void> {
  for (const entry of manifest.entries.slice(1)) {
    const sourcePath = ownedTreeEntryPath(sourceRoot, entry.relativePath);
    const stagePath = ownedTreeEntryPath(stageRoot, entry.relativePath);
    const parentProof = await proveOwnedTreeDirectory(dirname(stagePath), options);
    if (entry.kind === "directory") {
      await assertOwnedTreeLeaseBoundary(options, "copy-directory-mkdir", [stagePath]);
      await reproveOwnedTreeDirectory(parentProof, options);
      await assertCreatedStageAncestorChain(
        stageRoot,
        dirname(stagePath),
        stageParent,
        createdEntries,
        options
      );
      try {
        await mkdir(stagePath, { mode: 0o700, recursive: false });
      } catch (error) {
        throw driftedOwnedTree(
          "Companion stage directory could not be created exclusively",
          error
        );
      }
      const created = await lstatOwnedTree(stagePath, options);
      if (created === undefined || !created.isDirectory() || created.isSymbolicLink()) {
        throw driftedOwnedTree("Companion stage directory identity is unavailable");
      }
      createdEntries.set(entry.relativePath, {
        identity: identityFromStats(created),
        kind: "directory"
      });
      await assertOwnedTreeMutationCompleted(options, "copy-directory-mkdir", [stagePath]);
      await beforeOwnedTreeVerification(options, "copy-directory-verify", [stagePath]);
      await assertCreatedStageAncestorChain(
        stageRoot,
        stagePath,
        stageParent,
        createdEntries,
        options
      );
      await afterOwnedTreeVerification(options, "copy-directory-verify", [stagePath]);
      await assertCreatedStageAncestorChain(
        stageRoot,
        stagePath,
        stageParent,
        createdEntries,
        options
      );
      await fsyncOwnedTreeDirectory(parentProof, options, "copy-parent-fsync");
      continue;
    }
    await copyManifestFile(
      sourcePath,
      stagePath,
      entry,
      options,
      stageRoot,
      stageParent,
      createdEntries,
      (identity) => {
        createdEntries.set(entry.relativePath, { identity, kind: "file" });
      }
    );
    await fsyncOwnedTreeDirectory(parentProof, options, "copy-parent-fsync");
  }
  const directories = manifest.entries
    .filter((entry): entry is Extract<CompanionTreeEntry, { kind: "directory" }> =>
      entry.kind === "directory")
    .sort((left, right) => {
      const leftDepth = left.relativePath === "." ? 0 : left.relativePath.split("/").length;
      const rightDepth = right.relativePath === "." ? 0 : right.relativePath.split("/").length;
      return rightDepth - leftDepth || right.relativePath.localeCompare(left.relativePath);
    });
  for (const entry of directories) {
    const directory = ownedTreeEntryPath(stageRoot, entry.relativePath);
    const boundary = entry.relativePath === "." ? "stage-root-chmod" : "copy-directory-chmod";
    const proof = await proveOwnedTreeDirectory(directory, options);
    const handle = await openOwnedTreeDirectoryHandle(proof, options);
    try {
      await assertOwnedTreeLeaseBoundary(options, boundary, [directory]);
      await assertCreatedStageAncestorChain(
        stageRoot,
        directory,
        stageParent,
        createdEntries,
        options
      );
      await assertOwnedTreeDirectoryHandle(handle, proof);
      await handle.chmod(ownedTreeManifestMode(entry));
      await assertOwnedTreeDirectoryHandle(handle, proof);
      await assertOwnedTreeMutationCompleted(options, boundary, [directory]);
    } finally {
      await handle.close().catch(() => undefined);
    }
    const exactProof = await proveOwnedTreeDirectory(directory, options);
    await fsyncOwnedTreeDirectory(exactProof, options, "copy-directory-fsync");
  }
}

async function cleanupPartialOwnedStage(
  stagePath: string,
  parent: OwnedTreeDirectoryProof,
  createdEntries: Map<string, CreatedStageEntry>,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const assertParentChain = async (path: string): Promise<void> => {
    const targetParent = dirname(path);
    if (targetParent === parent.path) {
      await reproveOwnedTreeDirectory(parent, options);
      return;
    }
    await assertCreatedStageAncestorChain(
      stagePath,
      targetParent,
      parent,
      createdEntries,
      options
    );
  };
  const assertEntry = async (
    path: string,
    expected: CreatedStageEntry
  ): Promise<void> => {
    await assertParentChain(path);
    const metadata = await lstatOwnedTree(path, options);
    if (
      metadata === undefined
      || metadata.isSymbolicLink()
      || (expected.kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
      || !sameOwnedTreeIdentity(identityFromStats(metadata), expected.identity)
    ) {
      throw incompleteOwnedTreeRecovery(
        "Partial companion stage changed during compensation verification",
        []
      );
    }
  };
  const entries = [...createdEntries.entries()].sort(([left], [right]) => {
    const leftDepth = left === "." ? 0 : left.split("/").length;
    const rightDepth = right === "." ? 0 : right.split("/").length;
    return rightDepth - leftDepth || right.localeCompare(left);
  });
  for (const [relativePath, expected] of entries) {
    const path = ownedTreeEntryPath(stagePath, relativePath);
    await assertParentChain(path);
    const metadata = await lstatOwnedTree(path, options);
    if (metadata === undefined) continue;
    if (
      metadata.isSymbolicLink()
      || (expected.kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
      || !sameOwnedTreeIdentity(identityFromStats(metadata), expected.identity)
    ) {
      throw incompleteOwnedTreeRecovery(
        "Partial companion stage changed before compensation",
        []
      );
    }
    const parentProof = relativePath === "."
      ? parent
      : await proveOwnedTreeDirectory(dirname(path), options);
    const parentHandle = await openOwnedTreeDirectoryHandle(parentProof, options);
    try {
      const boundary = expected.kind === "file" ? "unlink" : "rmdir";
      const probe = expected.kind === "file" ? "cleanup-file-probe" : "cleanup-directory-probe";
      await assertOwnedTreeLeaseBoundary(options, boundary, [path]);
      await beforeOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
      await assertParentChain(path);
      await afterOwnedTreeVerification(options, "cleanup-parent-chain-verify", [path]);
      await assertParentChain(path);
      await beforeOwnedTreeVerification(options, probe, [path]);
      await assertEntry(path, expected);
      await afterOwnedTreeVerification(options, probe, [path]);
      await assertEntry(path, expected);
      let removalError: unknown;
      const remove = async (): Promise<void> => {
        try {
          await removeOwnedTreeAt(
            parentHandle,
            parentProof,
            path,
            expected.kind === "directory",
            options
          );
          await assertOwnedTreeMutationCompleted(options, boundary, [path]);
        } catch (error) {
          removalError = error;
        }
      };
      if (relativePath === ".") await remove();
      else await withOwnedTreeWritableDirectory(
        parentHandle,
        parentProof,
        parentProof.mode,
        options,
        remove
      );
      await beforeOwnedTreeVerification(options, probe, [path]);
      await assertParentChain(path);
      let after = await lstatOwnedTree(path, options);
      await afterOwnedTreeVerification(options, probe, [path]);
      await assertParentChain(path);
      after = await lstatOwnedTree(path, options);
      if (after !== undefined) {
        const unchanged = !after.isSymbolicLink()
          && (expected.kind === "file" ? after.isFile() : after.isDirectory())
          && sameOwnedTreeIdentity(identityFromStats(after), expected.identity);
        throw incompleteOwnedTreeRecovery(
          unchanged
            ? "Partial companion stage removal remains pending"
            : "Partial companion stage was replaced during compensation",
          removalError === undefined ? [] : [removalError]
        );
      }
      await fsyncOwnedTreeDirectory(
        parentProof,
        options,
        expected.kind === "file" ? "unlink-parent-fsync" : "rmdir-parent-fsync"
      );
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }
}

export async function createOwnedTreeStage(
  input: OwnedTreeStageInput,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeStageResult> {
  return withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    validateOwnedTreeTransactionId(input.transactionId);
    const sourcePath = normalizeOwnedTreePath(input.sourcePath, "Companion source path");
    const destinationPath = normalizeOwnedTreePath(
      input.destinationPath,
      "Companion destination path"
    );
    const manifest = parseOwnedTreeManifest(input.expectedManifest);
    if (manifest.platform !== "posix") {
      throw invalidOwnedTree("Companion mutation requires a POSIX manifest");
    }
    await assertReviewedManifest(
      sourcePath,
      dirname(sourcePath),
      manifest,
      "copy-source-manifest-verify",
      options,
      "Companion source no longer matches the reviewed manifest"
    );
    const sourceRootIdentity = identityFromStats(await lstat(sourcePath, { bigint: true }));
    const { parent, created } = await ensureCompanionParent(
      destinationPath,
      input.homeBoundaryPath,
      options
    );
    const stagePath = ownedTreeSiblingPath(parent.path, input.transactionId, "stage");
    const createdEntries = new Map<string, CreatedStageEntry>();
    try {
      if (await lstatOwnedTree(stagePath, options) !== undefined) {
        throw driftedOwnedTree("Companion stage namespace is already occupied");
      }
      await assertOwnedTreeLeaseBoundary(options, "stage-mkdir", [stagePath, parent.path]);
      await reproveOwnedTreeDirectory(parent, options);
      await mkdir(stagePath, { mode: 0o700, recursive: false })
        .catch((error: unknown) => {
          throw isExists(error)
            ? driftedOwnedTree("Companion stage namespace became occupied", error)
            : driftedOwnedTree("Companion stage root could not be created", error);
        });
      const createdRoot = await lstatOwnedTree(stagePath, options);
      if (createdRoot === undefined || !createdRoot.isDirectory() || createdRoot.isSymbolicLink()) {
        throw driftedOwnedTree("Companion stage root identity is unavailable after creation");
      }
      createdEntries.set(".", { identity: identityFromStats(createdRoot), kind: "directory" });
      await assertOwnedTreeMutationCompleted(options, "stage-mkdir", [stagePath, parent.path]);
      await beforeOwnedTreeVerification(options, "stage-root-verify", [stagePath]);
      await assertCreatedStageAncestorChain(
        stagePath,
        stagePath,
        parent,
        createdEntries,
        options
      );
      await afterOwnedTreeVerification(options, "stage-root-verify", [stagePath]);
      await assertCreatedStageAncestorChain(
        stagePath,
        stagePath,
        parent,
        createdEntries,
        options
      );
      await fsyncOwnedTreeDirectory(parent, options, "stage-parent-fsync");
      await copyReviewedManifest(
        sourcePath,
        stagePath,
        manifest,
        options,
        createdEntries,
        parent
      );
      await assertReviewedManifest(
        sourcePath,
        dirname(sourcePath),
        manifest,
        "copy-source-manifest-verify",
        options,
        "Companion source changed while the stage was copied"
      );
      const sourceRootAfter = await lstat(sourcePath, { bigint: true });
      if (!sameOwnedTreeIdentity(sourceRootIdentity, identityFromStats(sourceRootAfter))) {
        throw driftedOwnedTree("Companion source changed while the stage was copied");
      }
      await assertReviewedManifest(
        stagePath,
        parent.path,
        manifest,
        "copy-stage-manifest-verify",
        options,
        "Companion stage does not match the reviewed manifest"
      );
      const stageRoot = await lstatOwnedTree(stagePath, options);
      if (stageRoot === undefined || !stageRoot.isDirectory() || stageRoot.isSymbolicLink()) {
        throw driftedOwnedTree("Companion stage root could not be proven");
      }
      const rootIdentity = identityFromStats(stageRoot);
      if (rootIdentity.device !== parent.identity.device) {
        throw invalidOwnedTree(
          "Companion stage and destination parent are on different filesystems"
        );
      }
      const finalIdentities = await captureOwnedTreeEntryIdentities(stagePath, manifest, options);
      for (const [relativePath, created] of createdEntries) {
        const finalIdentity = finalIdentities.get(relativePath);
        if (
          finalIdentity === undefined
          || !sameOwnedTreeIdentity(finalIdentity, created.identity)
        ) {
          throw driftedOwnedTree("Companion stage entry identity changed before authority issue");
        }
      }
      const entryIdentities = new Map(
        [...createdEntries].map(([relativePath, created]) => [
          relativePath,
          created.identity
        ] as const)
      );
      await inspectExactOwnedTreeAt(stagePath, parent, rootIdentity, manifest, options);
      const tree = createOwnedTreeHandle({
        transactionId: input.transactionId,
        role: "stage",
        status: "staged",
        currentPath: stagePath,
        homeBoundaryPath: input.homeBoundaryPath,
        stateDirectory: options.stateDirectory,
        leaseContext: options.leaseContext,
        parent,
        rootIdentity,
        manifest,
        entryIdentities,
        deletedEntries: new Set(),
        rootRemoved: false
      });
      return Object.freeze({ tree, createdAncestors: Object.freeze(created) });
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      if (createdEntries.size > 0) {
        try {
          await cleanupPartialOwnedStage(stagePath, parent, createdEntries, options);
        } catch (cleanupError) {
          recoveryErrors.push(cleanupError);
        }
      }
      if (recoveryErrors.length === 0 && created.length > 0) {
        try {
          await rollbackCreatedOwnedTreeAncestorsInternal(created, options);
        } catch (ancestorError) {
          recoveryErrors.push(ancestorError);
        }
      }
      if (recoveryErrors.length > 0) {
        throw incompleteOwnedTreeRecovery(
          "Companion stage failure could not be compensated completely",
          [error, ...recoveryErrors]
        );
      }
      throw error;
    }
  });
}
