import { open, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  companionTreeManifestSchema,
  type CompanionTreeEntry,
  type CompanionTreeManifest
} from "./companion-domain.js";
import type {
  CreatedOwnedTreeAncestorProof,
  OwnedTreeAuthorityState,
  OwnedTreeHandle,
  OwnedTreeHandleSnapshot,
  OwnedTreeMutationOptions,
  OwnedTreePhysicalIdentity,
  OwnedTreeRecoveryArtifactProof,
  OwnedTreeRole
} from "./companion-owned-tree-domain.js";
import {
  driftedOwnedTree,
  identityFromStats,
  invalidOwnedTree,
  lstatOwnedTree,
  normalizeOwnedTreePath
} from "./companion-owned-tree-proof.js";

const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownedNamePattern = /^\.skill-steward-owned\.([0-9a-f-]{36})\.(stage|backup|cleanup)$/;
const ownedTreeStates = new WeakMap<OwnedTreeHandle, OwnedTreeAuthorityState>();
const mutationTails = new WeakMap<object, Promise<void>>();
const createdAncestorStates = new WeakMap<
  CreatedOwnedTreeAncestorProof,
  {
    stateDirectory: string;
    leaseContext: object;
    removed: boolean;
  }
>();

export async function withOwnedTreeClaim<T>(
  options: OwnedTreeMutationOptions,
  operation: () => Promise<T>
): Promise<T> {
  const key = options.leaseContext as object;
  const predecessor = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = predecessor.then(() => gate);
  mutationTails.set(key, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

export function validateOwnedTreeTransactionId(transactionId: string): string {
  if (!transactionIdPattern.test(transactionId)) {
    throw invalidOwnedTree("Companion transaction identifier is invalid");
  }
  return transactionId;
}

export function ownedTreeSiblingPath(
  parentPath: string,
  transactionId: string,
  role: OwnedTreeRole
): string {
  const parent = normalizeOwnedTreePath(parentPath, "Companion owned-tree parent");
  const id = validateOwnedTreeTransactionId(transactionId);
  const name = `.skill-steward-owned.${id}.${role}`;
  if (!ownedNamePattern.test(name)) throw invalidOwnedTree("Companion owned name is invalid");
  const path = resolve(parent, name);
  if (dirname(path) !== parent) {
    throw invalidOwnedTree("Companion owned name escaped its direct parent");
  }
  return path;
}

export function parseOwnedTreeManifest(input: unknown): CompanionTreeManifest {
  const result = companionTreeManifestSchema.safeParse(input);
  if (!result.success) {
    throw invalidOwnedTree("Companion manifest is invalid", result.error);
  }
  return result.data;
}

export function ownedTreeManifestMode(entry: CompanionTreeEntry): number {
  if (!entry.securityMode.startsWith("posix:")) {
    throw invalidOwnedTree("Companion mutation requires a POSIX manifest");
  }
  return Number.parseInt(entry.securityMode.slice("posix:".length), 8);
}

export function ownedTreeEntryPath(root: string, relativePath: string): string {
  if (relativePath === ".") return root;
  const path = resolve(root, ...relativePath.split("/"));
  const relativePathFromRoot = relative(root, path);
  if (
    relativePathFromRoot === ""
    || relativePathFromRoot === ".."
    || relativePathFromRoot.startsWith(`..${sep}`)
  ) {
    throw invalidOwnedTree("Companion manifest entry escaped its root");
  }
  return path;
}

export function sameOwnedTreeManifest(
  left: CompanionTreeManifest,
  right: CompanionTreeManifest
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function ensureOwnedTreePosix(options: OwnedTreeMutationOptions): Promise<void> {
  if ((options.hooks?.platform ?? process.platform) === "win32") {
    throw invalidOwnedTree("Companion tree mutation is unavailable on Windows");
  }
}

export async function openOwnedTreePath(
  path: string,
  flags: number,
  mode: number | undefined,
  options: OwnedTreeMutationOptions
): Promise<FileHandle> {
  const operation = options.hooks?.openPath
    ?? ((target: string, inputFlags: number, inputMode?: number) =>
      open(target, inputFlags, inputMode));
  return operation(path, flags, mode);
}

export function createOwnedTreeHandle(state: OwnedTreeAuthorityState): OwnedTreeHandle {
  const handle = Object.freeze(Object.create(null)) as OwnedTreeHandle;
  ownedTreeStates.set(handle, state);
  return handle;
}

export function ownedTreeAuthorityState(
  handle: OwnedTreeHandle,
  options?: OwnedTreeMutationOptions
): OwnedTreeAuthorityState {
  const state = ownedTreeStates.get(handle);
  if (state === undefined) throw invalidOwnedTree("Companion owned-tree handle is invalid");
  if (options !== undefined && (
    state.stateDirectory !== options.stateDirectory
    || state.leaseContext !== options.leaseContext
  )) {
    throw invalidOwnedTree("Companion owned-tree handle belongs to another mutation authority");
  }
  return state;
}

export async function captureOwnedTreeEntryIdentities(
  root: string,
  manifest: CompanionTreeManifest,
  options: OwnedTreeMutationOptions
): Promise<Map<string, OwnedTreePhysicalIdentity>> {
  const identities = new Map<string, OwnedTreePhysicalIdentity>();
  for (const entry of manifest.entries) {
    const path = ownedTreeEntryPath(root, entry.relativePath);
    const metadata = await lstatOwnedTree(path, options);
    if (
      metadata === undefined
      || metadata.isSymbolicLink()
      || (entry.kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())
      || Number(metadata.mode & 0o777n) !== ownedTreeManifestMode(entry)
      || (entry.kind === "file" && metadata.size !== BigInt(entry.bytes))
    ) {
      throw driftedOwnedTree("Companion tree entry identity could not be captured");
    }
    identities.set(entry.relativePath, identityFromStats(metadata));
  }
  return identities;
}

export function registerCreatedOwnedTreeAncestor(
  proof: CreatedOwnedTreeAncestorProof,
  options: OwnedTreeMutationOptions
): void {
  createdAncestorStates.set(proof, {
    stateDirectory: options.stateDirectory,
    leaseContext: options.leaseContext as object,
    removed: false
  });
}

export function assertCreatedOwnedTreeAncestorAuthority(
  proof: CreatedOwnedTreeAncestorProof,
  options: OwnedTreeMutationOptions
): { removed: boolean } {
  const authority = createdAncestorStates.get(proof);
  if (
    authority === undefined
    || authority.stateDirectory !== options.stateDirectory
    || authority.leaseContext !== options.leaseContext
    || authority.removed
  ) {
    throw invalidOwnedTree("Created companion ancestor proof is invalid or terminal");
  }
  return authority;
}

export function ownedTreeHandleSnapshot(handle: OwnedTreeHandle): OwnedTreeHandleSnapshot {
  const state = ownedTreeAuthorityState(handle);
  return Object.freeze({
    role: state.role,
    path: state.currentPath,
    status: state.status,
    manifestFingerprint: state.manifest.fingerprint,
    rootIdentity: Object.freeze({ ...state.rootIdentity }),
    parentIdentity: Object.freeze({ ...state.parent.identity })
  });
}

export function ownedTreeRecoveryArtifactProof(
  handle: OwnedTreeHandle
): OwnedTreeRecoveryArtifactProof {
  const state = ownedTreeAuthorityState(handle);
  if (
    (state.role !== "stage" && state.role !== "backup")
    || state.status === "cleaned"
    || state.status === "restored"
    || state.rootRemoved
    || state.deletedEntries.size > 0
  ) {
    throw invalidOwnedTree("Companion owned tree cannot provide an exact recovery artifact proof");
  }
  const manifest = structuredClone(state.manifest);
  for (const entry of manifest.entries) Object.freeze(entry);
  Object.freeze(manifest.entries);
  Object.freeze(manifest);
  const entryIdentities = manifest.entries.map(({ relativePath }) => {
    const identity = state.entryIdentities.get(relativePath);
    if (identity === undefined) {
      throw invalidOwnedTree("Companion owned tree entry identity is unavailable for recovery");
    }
    return Object.freeze({
      relativePath,
      device: identity.device.toString(),
      inode: identity.inode.toString()
    });
  });
  Object.freeze(entryIdentities);
  return Object.freeze({
    role: state.role,
    path: state.currentPath,
    physicalParentPath: state.parent.physicalPath,
    parentIdentity: Object.freeze({
      device: state.parent.identity.device.toString(),
      inode: state.parent.identity.inode.toString()
    }),
    rootIdentity: Object.freeze({
      device: state.rootIdentity.device.toString(),
      inode: state.rootIdentity.inode.toString()
    }),
    fingerprint: state.manifest.fingerprint,
    entryIdentities,
    manifest,
    platformMetadata: Object.freeze({
      platform: "posix" as const,
      identity: "bigint-device-inode" as const,
      securityMode: "posix-permission-bits" as const
    })
  });
}
