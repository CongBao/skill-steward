import { dirname, relative, sep } from "node:path";
import {
  assertIntegrationMutationLeaseOwned,
  consumeIntegrationRecoveryArtifactAuthority
} from "@skill-steward/store";
import { inspectCompanionTree } from "./companion-manifest.js";
import {
  captureOwnedTreeEntryIdentities,
  createOwnedTreeHandle,
  ensureOwnedTreePosix,
  ownedTreeEntryPath,
  ownedTreeManifestMode,
  ownedTreeSiblingPath,
  parseOwnedTreeManifest,
  validateOwnedTreeTransactionId,
  withOwnedTreeClaim
} from "./companion-owned-tree-authority.js";
import type {
  OwnedTreeHandle,
  OwnedTreeMutationOptions,
  ResumeOwnedTreeRecoveryArtifactInput,
  ResumeOwnedTreeCleanupInput
} from "./companion-owned-tree-domain.js";
import {
  assertOwnedTreeDirectoryHandle,
  assertOwnedTreeLeaseBoundary,
  assertOwnedTreeMutationCompleted,
  assertOwnedTreeChild,
  driftedOwnedTree,
  identityFromStats,
  invalidOwnedTree,
  lstatOwnedTree,
  normalizeOwnedTreePath,
  openOwnedTreeDirectoryHandle,
  proveOwnedTreeDirectory,
  sameOwnedTreeIdentity
} from "./companion-owned-tree-proof.js";

export async function resumeOwnedTreeRecoveryArtifact(
  input: ResumeOwnedTreeRecoveryArtifactInput,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeHandle> {
  return withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
    validateOwnedTreeTransactionId(input.transactionId);
    let artifact;
    try {
      artifact = consumeIntegrationRecoveryArtifactAuthority(
        input.artifactAuthority,
        options.stateDirectory,
        input.transactionId,
        input.role,
        options.leaseContext
      );
    } catch (error) {
      throw invalidOwnedTree("Companion restart recovery authority is invalid", error);
    }
    const manifest = parseOwnedTreeManifest(artifact.manifest);
    if (
      manifest.platform !== "posix"
      || artifact.role !== input.role
      || artifact.fingerprint !== manifest.fingerprint
      || artifact.platformMetadata?.platform !== manifest.platform
      || artifact.entryIdentities === undefined
      || artifact.entryIdentities.length !== manifest.entries.length
    ) {
      throw invalidOwnedTree("Companion restart recovery artifact is inconsistent");
    }
    const home = normalizeOwnedTreePath(input.homeBoundaryPath, "Companion home boundary");
    const path = normalizeOwnedTreePath(artifact.path, "Companion restart recovery path");
    const expectedPath = normalizeOwnedTreePath(
      input.expectedPath,
      "Expected companion restart recovery path"
    );
    assertOwnedTreeChild(home, path);
    assertOwnedTreeChild(home, expectedPath);
    if (path !== expectedPath) {
      throw driftedOwnedTree("Companion restart recovery path changed");
    }
    const parent = await proveOwnedTreeDirectory(dirname(path), options);
    const homeProof = await proveOwnedTreeDirectory(home, options);
    const physicalRelative = relative(homeProof.physicalPath, parent.physicalPath);
    if (
      parent.physicalPath !== artifact.physicalParentPath
      || parent.identity.device.toString() !== artifact.parentIdentity.device
      || parent.identity.inode.toString() !== artifact.parentIdentity.inode
      || physicalRelative === ""
      || physicalRelative === ".."
      || physicalRelative.startsWith(`..${sep}`)
    ) {
      throw driftedOwnedTree("Companion restart recovery parent proof changed");
    }
    const rootIdentity = {
      device: BigInt(artifact.rootIdentity.device),
      inode: BigInt(artifact.rootIdentity.inode)
    };
    if (rootIdentity.device <= 0n || rootIdentity.inode <= 0n) {
      throw invalidOwnedTree("Companion restart recovery root identity is unavailable");
    }
    const root = await lstatOwnedTree(path, options);
    if (
      root === undefined
      || root.isSymbolicLink()
      || !root.isDirectory()
      || !sameOwnedTreeIdentity(identityFromStats(root), rootIdentity)
      || root.dev !== parent.identity.device
    ) {
      throw driftedOwnedTree("Companion restart recovery root proof changed");
    }
    const current = await inspectCompanionTree(path, {
      boundary: parent.path,
      platform: options.hooks?.platform ?? process.platform
    });
    if (JSON.stringify(current) !== JSON.stringify(manifest)) {
      throw driftedOwnedTree("Companion restart recovery manifest changed");
    }
    const persistedIdentities = new Map(artifact.entryIdentities.map((entry) => [
      entry.relativePath,
      { device: BigInt(entry.device), inode: BigInt(entry.inode) }
    ] as const));
    const currentIdentities = await captureOwnedTreeEntryIdentities(path, current, options);
    if (
      persistedIdentities.size !== manifest.entries.length
      || manifest.entries.some(({ relativePath }) => {
        const persisted = persistedIdentities.get(relativePath);
        const observed = currentIdentities.get(relativePath);
        return persisted === undefined
          || observed === undefined
          || !sameOwnedTreeIdentity(persisted, observed);
      })
    ) {
      throw driftedOwnedTree("Companion restart recovery entry identity changed");
    }
    return createOwnedTreeHandle({
      transactionId: input.transactionId,
      role: input.role === "installed" ? "stage" : input.role,
      status: "moved",
      currentPath: path,
      homeBoundaryPath: home,
      stateDirectory: options.stateDirectory,
      leaseContext: options.leaseContext,
      parent,
      rootIdentity,
      manifest,
      entryIdentities: currentIdentities,
      deletedEntries: new Set(),
      rootRemoved: false
    });
  });
}

export async function resumeOwnedTreeCleanup(
  input: ResumeOwnedTreeCleanupInput,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeHandle> {
  return withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    await assertIntegrationMutationLeaseOwned(options.leaseContext, options.stateDirectory);
    validateOwnedTreeTransactionId(input.transactionId);
    let artifact;
    try {
      artifact = consumeIntegrationRecoveryArtifactAuthority(
        input.artifactAuthority,
        options.stateDirectory,
        input.transactionId,
        input.role,
        options.leaseContext
      );
    } catch (error) {
      throw invalidOwnedTree("Companion cleanup recovery authority is invalid", error);
    }
    const manifest = parseOwnedTreeManifest(artifact.manifest);
    if (manifest.platform !== "posix") {
      throw invalidOwnedTree("Companion cleanup recovery requires a POSIX manifest");
    }
    if (
      (artifact.role !== "stage" && artifact.role !== "backup" && artifact.role !== "cleanup")
      || artifact.fingerprint !== manifest.fingerprint
      || artifact.platformMetadata?.platform !== manifest.platform
      || artifact.entryIdentities === undefined
      || artifact.entryIdentities.length !== manifest.entries.length
    ) {
      throw invalidOwnedTree("Companion cleanup recovery artifact is inconsistent");
    }
    const home = normalizeOwnedTreePath(input.homeBoundaryPath, "Companion home boundary");
    const path = normalizeOwnedTreePath(artifact.path, "Companion cleanup recovery path");
    assertOwnedTreeChild(home, path);
    const parent = await proveOwnedTreeDirectory(dirname(path), options);
    const homeProof = await proveOwnedTreeDirectory(home, options);
    const expectedPath = ownedTreeSiblingPath(parent.path, input.transactionId, "cleanup");
    const physicalRelative = relative(homeProof.physicalPath, parent.physicalPath);
    if (
      path !== expectedPath
      || parent.physicalPath !== artifact.physicalParentPath
      || parent.identity.device.toString() !== artifact.parentIdentity.device
      || parent.identity.inode.toString() !== artifact.parentIdentity.inode
      || physicalRelative === ""
      || physicalRelative === ".."
      || physicalRelative.startsWith(`..${sep}`)
    ) {
      throw driftedOwnedTree("Companion cleanup recovery parent proof changed");
    }
    const rootIdentity = {
      device: BigInt(artifact.rootIdentity.device),
      inode: BigInt(artifact.rootIdentity.inode)
    };
    if (rootIdentity.device <= 0n || rootIdentity.inode <= 0n) {
      throw invalidOwnedTree("Companion cleanup recovery root identity is unavailable");
    }
    const root = await lstatOwnedTree(path, options);
    let entryIdentities = new Map<string, typeof rootIdentity>();
    let deletedEntries = new Set(manifest.entries.map(({ relativePath }) => relativePath));
    let rootRemoved = true;
    if (root !== undefined) {
      if (
        root.isSymbolicLink()
        || !root.isDirectory()
        || !sameOwnedTreeIdentity(identityFromStats(root), rootIdentity)
        || root.dev !== parent.identity.device
      ) {
        throw driftedOwnedTree("Companion cleanup recovery root proof changed");
      }
      let current = await inspectCompanionTree(path, {
        boundary: parent.path,
        platform: options.hooks?.platform ?? process.platform
      });
      const expectedEntries = new Map(
        manifest.entries.map((entry) => [entry.relativePath, entry] as const)
      );
      const persistedIdentities = new Map(artifact.entryIdentities.map((entry) => [
        entry.relativePath,
        { device: BigInt(entry.device), inode: BigInt(entry.inode) }
      ] as const));
      if (
        persistedIdentities.size !== manifest.entries.length
        || manifest.entries.some(({ relativePath }) => !persistedIdentities.has(relativePath))
      ) {
        throw invalidOwnedTree("Companion cleanup recovery entry identities are inconsistent");
      }
      let currentIdentities = await captureOwnedTreeEntryIdentities(path, current, options);
      const interruptedDirectories: Array<{
        relativePath: string;
        expectedMode: number;
        identity: typeof rootIdentity;
      }> = [];
      for (const entry of current.entries) {
        const expected = expectedEntries.get(entry.relativePath);
        const persisted = persistedIdentities.get(entry.relativePath);
        const observed = currentIdentities.get(entry.relativePath);
        if (
          expected === undefined
          || persisted === undefined
          || observed === undefined
          || !sameOwnedTreeIdentity(persisted, observed)
        ) {
          throw driftedOwnedTree("Partial companion cleanup entry identity changed");
        }
        if (JSON.stringify(entry) === JSON.stringify(expected)) continue;
        const expectedMode = ownedTreeManifestMode(expected);
        const temporaryMode = entry.kind === "directory"
          && expected.kind === "directory"
          && entry.relativePath === expected.relativePath
          && entry.bytes === expected.bytes
          && entry.securityMode === "posix:0700"
          && (expectedMode & 0o300) !== 0o300;
        if (!temporaryMode) {
          throw driftedOwnedTree("Partial companion cleanup contains changed or unknown state");
        }
        interruptedDirectories.push({
          relativePath: entry.relativePath,
          expectedMode,
          identity: persisted
        });
      }
      if (interruptedDirectories.length > 1) {
        throw driftedOwnedTree("Partial companion cleanup has multiple temporary permission states");
      }
      for (const interrupted of interruptedDirectories) {
        const directoryPath = ownedTreeEntryPath(path, interrupted.relativePath);
        const proof = await proveOwnedTreeDirectory(directoryPath, options);
        if (!sameOwnedTreeIdentity(proof.identity, interrupted.identity) || proof.mode !== 0o700) {
          throw driftedOwnedTree("Interrupted cleanup directory proof changed");
        }
        const directoryHandle = await openOwnedTreeDirectoryHandle(proof, options);
        try {
          await assertOwnedTreeLeaseBoundary(
            options,
            "cleanup-parent-chmod-restore",
            [directoryPath]
          );
          await assertOwnedTreeDirectoryHandle(directoryHandle, proof);
          await directoryHandle.chmod(interrupted.expectedMode);
          await directoryHandle.sync();
          await assertOwnedTreeMutationCompleted(
            options,
            "cleanup-parent-chmod-restore",
            [directoryPath]
          );
          await assertOwnedTreeDirectoryHandle(directoryHandle, proof);
          const restored = await directoryHandle.stat({ bigint: true });
          if (Number(restored.mode & 0o777n) !== interrupted.expectedMode) {
            throw driftedOwnedTree("Interrupted cleanup directory mode was not restored");
          }
        } finally {
          await directoryHandle.close().catch(() => undefined);
        }
      }
      if (interruptedDirectories.length > 0) {
        current = await inspectCompanionTree(path, {
          boundary: parent.path,
          platform: options.hooks?.platform ?? process.platform
        });
        currentIdentities = await captureOwnedTreeEntryIdentities(path, current, options);
        for (const entry of current.entries) {
          const expected = expectedEntries.get(entry.relativePath);
          const persisted = persistedIdentities.get(entry.relativePath);
          const observed = currentIdentities.get(entry.relativePath);
          if (
            expected === undefined
            || JSON.stringify(entry) !== JSON.stringify(expected)
            || persisted === undefined
            || observed === undefined
            || !sameOwnedTreeIdentity(persisted, observed)
          ) {
            throw driftedOwnedTree("Restored companion cleanup state is not exact");
          }
        }
      }
      entryIdentities = currentIdentities;
      const remainingPaths = new Set(current.entries.map(({ relativePath }) => relativePath));
      deletedEntries = new Set(
        manifest.entries
          .map(({ relativePath }) => relativePath)
          .filter((relativePath) => !remainingPaths.has(relativePath))
      );
      rootRemoved = false;
    }
    return createOwnedTreeHandle({
      transactionId: input.transactionId,
      role: artifact.role,
      status: "moved",
      currentPath: path,
      homeBoundaryPath: home,
      stateDirectory: options.stateDirectory,
      leaseContext: options.leaseContext,
      parent,
      rootIdentity,
      manifest,
      entryIdentities,
      deletedEntries,
      rootRemoved
    });
  });
}
