import { dirname, relative, sep } from "node:path";
import { inspectCompanionTree } from "./companion-manifest.js";
import {
  captureOwnedTreeEntryIdentities,
  createOwnedTreeHandle,
  ensureOwnedTreePosix,
  ownedTreeAuthorityState,
  parseOwnedTreeManifest,
  sameOwnedTreeManifest,
  validateOwnedTreeTransactionId,
  withOwnedTreeClaim
} from "./companion-owned-tree-authority.js";
import type {
  OwnedTreeAuthorityState,
  OwnedTreeHandle,
  OwnedTreeMoveOutcome,
  OwnedTreeMutationOptions,
  OwnedTreePhysicalIdentity,
  ProveOwnedTreeInput
} from "./companion-owned-tree-domain.js";
import {
  assertOwnedTreeChild,
  afterOwnedTreeVerification,
  assertOwnedTreeLeaseBoundary,
  assertOwnedTreeMutationCompleted,
  assertOwnedTreeVerificationBoundary,
  beforeOwnedTreeVerification,
  driftedOwnedTree,
  fsyncOwnedTreeDirectory,
  identityFromStats,
  invalidOwnedTree,
  lstatOwnedTree,
  normalizeOwnedTreePath,
  proveOwnedTreeDirectory,
  reproveOwnedTreeDirectory,
  sameOwnedTreeIdentity,
  uncertainOwnedTree
} from "./companion-owned-tree-proof.js";
import { renameOwnedTreeNoReplace } from "./companion-owned-tree-native.js";

async function inspectExactOwnedTreeAtOnce(
  path: string,
  parent: Awaited<ReturnType<typeof proveOwnedTreeDirectory>>,
  rootIdentity: OwnedTreePhysicalIdentity,
  manifest: ProveOwnedTreeInput["expectedManifest"],
  options: OwnedTreeMutationOptions
): Promise<void> {
  await reproveOwnedTreeDirectory(parent, options);
  const root = await lstatOwnedTree(path, options);
  if (
    root === undefined
    || root.isSymbolicLink()
    || !root.isDirectory()
    || !sameOwnedTreeIdentity(rootIdentity, identityFromStats(root))
    || root.dev !== parent.identity.device
  ) {
    throw driftedOwnedTree("Companion owned tree root identity changed");
  }
  let current;
  try {
    current = await inspectCompanionTree(path, {
      boundary: parent.path,
      platform: options.hooks?.platform ?? process.platform
    });
  } catch (error) {
    throw driftedOwnedTree("Companion owned tree could not be revalidated", error);
  }
  if (!sameOwnedTreeManifest(current, manifest)) {
    throw driftedOwnedTree("Companion owned tree no longer matches its exact manifest");
  }
  const after = await lstatOwnedTree(path, options);
  if (
    after === undefined
    || !after.isDirectory()
    || after.isSymbolicLink()
    || !sameOwnedTreeIdentity(rootIdentity, identityFromStats(after))
  ) {
    throw driftedOwnedTree("Companion owned tree root changed during revalidation");
  }
}

export async function inspectExactOwnedTreeAt(
  path: string,
  parent: Awaited<ReturnType<typeof proveOwnedTreeDirectory>>,
  rootIdentity: OwnedTreePhysicalIdentity,
  manifest: ProveOwnedTreeInput["expectedManifest"],
  options: OwnedTreeMutationOptions
): Promise<void> {
  await assertOwnedTreeVerificationBoundary(
    options,
    "exact-tree-manifest-verify",
    [path],
    () => inspectExactOwnedTreeAtOnce(path, parent, rootIdentity, manifest, options)
  );
}

export async function assertExactOwnedTreeAuthorityState(
  state: OwnedTreeAuthorityState,
  options: OwnedTreeMutationOptions
): Promise<void> {
  if (state.status === "cleaned" || state.status === "restored" || state.rootRemoved) {
    throw invalidOwnedTree("Companion owned-tree handle is terminal");
  }
  if (dirname(state.currentPath) !== state.parent.path) {
    throw invalidOwnedTree("Companion owned-tree handle escaped its proven parent");
  }
  await inspectExactOwnedTreeAt(
    state.currentPath,
    state.parent,
    state.rootIdentity,
    state.manifest,
    options
  );
}

type PathProbe =
  | { state: "absent" }
  | { state: "exact" }
  | { state: "other"; cause: unknown };

async function probeOwnedTreePath(
  path: string,
  state: OwnedTreeAuthorityState,
  options: OwnedTreeMutationOptions,
  boundary: "rename-source-probe" | "rename-destination-probe"
): Promise<PathProbe> {
  try {
    await beforeOwnedTreeVerification(options, boundary, [path]);
    const root = await lstatOwnedTree(path, options);
    if (root === undefined) {
      await afterOwnedTreeVerification(options, boundary, [path]);
      return (await lstatOwnedTree(path, options)) === undefined
        ? { state: "absent" }
        : { state: "other", cause: driftedOwnedTree("Companion rename probe changed") };
    }
    await inspectExactOwnedTreeAt(
      path,
      state.parent,
      state.rootIdentity,
      state.manifest,
      options
    );
    await afterOwnedTreeVerification(options, boundary, [path]);
    await inspectExactOwnedTreeAt(
      path,
      state.parent,
      state.rootIdentity,
      state.manifest,
      options
    );
    return { state: "exact" };
  } catch (error) {
    return { state: "other", cause: error };
  }
}

/**
 * POSIX directory rename has no portable no-clobber compare-and-swap primitive.
 * The destination is therefore checked immediately before rename, and every
 * outcome is classified from both names plus the saved root identity. The
 * remaining syscall window is never interpreted as success from manifest
 * equality alone.
 */
export async function moveOwnedTreeInternal(
  handle: OwnedTreeHandle,
  inputDestinationPath: string,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeMoveOutcome> {
  await ensureOwnedTreePosix(options);
  const state = ownedTreeAuthorityState(handle, options);
  const destinationPath = normalizeOwnedTreePath(
    inputDestinationPath,
    "Companion owned-tree move destination"
  );
  if (state.status === "cleaned" || state.status === "restored" || state.rootRemoved) {
    throw invalidOwnedTree("Companion owned-tree handle is terminal");
  }
  if (destinationPath === state.currentPath || dirname(destinationPath) !== state.parent.path) {
    throw invalidOwnedTree("Companion owned-tree moves require distinct direct siblings");
  }
  await assertExactOwnedTreeAuthorityState(state, options);
  if ((await lstatOwnedTree(destinationPath, options)) !== undefined) {
    throw driftedOwnedTree("Companion move destination is already occupied");
  }
  const sourcePath = state.currentPath;
  await assertOwnedTreeLeaseBoundary(options, "rename", [sourcePath, destinationPath]);
  await reproveOwnedTreeDirectory(state.parent, options);
  await assertExactOwnedTreeAuthorityState(state, options);
  if ((await lstatOwnedTree(destinationPath, options)) !== undefined) {
    throw driftedOwnedTree("Companion move destination appeared before rename");
  }
  let renameError: unknown;
  try {
    await renameOwnedTreeNoReplace(state.parent, sourcePath, destinationPath, options);
    await assertOwnedTreeMutationCompleted(options, "rename", [sourcePath, destinationPath]);
  } catch (error) {
    renameError = error;
  }
  const [source, destination] = await Promise.all([
    probeOwnedTreePath(sourcePath, state, options, "rename-source-probe"),
    probeOwnedTreePath(destinationPath, state, options, "rename-destination-probe")
  ]);
  if (source.state === "exact" && destination.state === "absent") {
    return {
      state: "not-moved",
      handle,
      cause: renameError instanceof Error && "code" in renameError && renameError.code === "EXDEV"
        ? invalidOwnedTree("Companion rename cannot cross filesystems", renameError)
        : renameError ?? driftedOwnedTree("Companion rename returned without moving the tree")
    };
  }
  if (source.state === "absent" && destination.state === "exact") {
    state.currentPath = destinationPath;
    state.status = "moved";
    try {
      await fsyncOwnedTreeDirectory(state.parent, options, "rename-parent-fsync");
    } catch (error) {
      return {
        state: "uncertain",
        handle,
        error: uncertainOwnedTree(
          "Companion rename committed but parent durability is uncertain",
          renameError === undefined ? [error] : [renameError, error]
        )
      };
    }
    return renameError === undefined
      ? { state: "moved", handle }
      : { state: "moved", handle, cause: renameError };
  }
  const causes = [
    renameError,
    source.state === "other" ? source.cause : undefined,
    destination.state === "other" ? destination.cause : undefined
  ].filter((cause): cause is unknown => cause !== undefined);
  return {
    state: "uncertain",
    handle,
    error: uncertainOwnedTree(
      "Companion rename outcome is uncertain; both names were preserved",
      causes
    )
  };
}

export async function moveOwnedTree(
  handle: OwnedTreeHandle,
  destinationPath: string,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeMoveOutcome> {
  return withOwnedTreeClaim(options, () =>
    moveOwnedTreeInternal(handle, destinationPath, options));
}

export async function proveOwnedTree(
  input: ProveOwnedTreeInput,
  options: OwnedTreeMutationOptions
): Promise<OwnedTreeHandle> {
  return withOwnedTreeClaim(options, async () => {
    await ensureOwnedTreePosix(options);
    validateOwnedTreeTransactionId(input.transactionId);
    const path = normalizeOwnedTreePath(input.path, "Companion owned-tree path");
    const home = normalizeOwnedTreePath(input.homeBoundaryPath, "Companion home boundary");
    assertOwnedTreeChild(home, path);
    const parentPath = dirname(path);
    if (input.expectedParentPath !== undefined && parentPath !== input.expectedParentPath) {
      throw invalidOwnedTree("Companion owned tree is not in the expected direct parent");
    }
    const homeProof = await proveOwnedTreeDirectory(home, options);
    const parent = await proveOwnedTreeDirectory(parentPath, options);
    const physicalRelative = relative(homeProof.physicalPath, parent.physicalPath);
    if (
      physicalRelative === ".."
      || physicalRelative.startsWith(`..${sep}`)
      || physicalRelative === ""
      || physicalRelative.startsWith(sep)
    ) {
      throw driftedOwnedTree("Companion owned-tree parent escaped the physical home boundary");
    }
    const manifest = parseOwnedTreeManifest(input.expectedManifest);
    if (manifest.platform !== "posix") {
      throw invalidOwnedTree("Companion mutation requires a POSIX manifest");
    }
    const root = await lstatOwnedTree(path, options);
    if (root === undefined || root.isSymbolicLink() || !root.isDirectory()) {
      throw driftedOwnedTree("Companion owned tree root is unavailable");
    }
    const rootIdentity = identityFromStats(root);
    if (rootIdentity.device !== parent.identity.device) {
      throw invalidOwnedTree("Companion owned tree and parent are on different filesystems");
    }
    if (
      input.expectedRootIdentity !== undefined
      && !sameOwnedTreeIdentity(rootIdentity, input.expectedRootIdentity)
    ) {
      throw driftedOwnedTree("Companion owned tree root identity does not match its proof");
    }
    await inspectExactOwnedTreeAt(path, parent, rootIdentity, manifest, options);
    const entryIdentities = await captureOwnedTreeEntryIdentities(path, manifest, options);
    await inspectExactOwnedTreeAt(path, parent, rootIdentity, manifest, options);
    return createOwnedTreeHandle({
      transactionId: input.transactionId,
      role: input.role,
      status: "staged",
      currentPath: path,
      homeBoundaryPath: home,
      stateDirectory: options.stateDirectory,
      leaseContext: options.leaseContext,
      parent,
      rootIdentity,
      manifest,
      entryIdentities,
      deletedEntries: new Set(),
      rootRemoved: false
    });
  });
}
