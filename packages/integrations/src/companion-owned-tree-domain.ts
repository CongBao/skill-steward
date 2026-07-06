import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type {
  IntegrationRecoveryArtifactAuthority,
  IntegrationMutationLeaseContext,
  IntegrationRecoveryArtifactProof
} from "@skill-steward/store";
import type { CompanionTreeManifest } from "./companion-domain.js";

export type OwnedTreeRole = "stage" | "backup" | "cleanup";
export type OwnedTreeStatus = "staged" | "moved" | "restored" | "cleaned";

export interface OwnedTreePhysicalIdentity {
  device: bigint;
  inode: bigint;
}

export interface OwnedTreeDirectoryProof {
  path: string;
  physicalPath: string;
  identity: OwnedTreePhysicalIdentity;
  mode: number;
}

export interface CreatedOwnedTreeAncestorProof extends OwnedTreeDirectoryProof {
  parent: OwnedTreeDirectoryProof;
}

declare const ownedTreeHandleBrand: unique symbol;

/** Same-process authority. The backing proof is held only in a private WeakMap. */
export interface OwnedTreeHandle {
  readonly [ownedTreeHandleBrand]: true;
}

export interface OwnedTreeHandleSnapshot {
  readonly role: OwnedTreeRole;
  readonly path: string;
  readonly status: OwnedTreeStatus;
  readonly manifestFingerprint: string;
  readonly rootIdentity: Readonly<OwnedTreePhysicalIdentity>;
  readonly parentIdentity: Readonly<OwnedTreePhysicalIdentity>;
}

export interface OwnedTreeStageInput {
  transactionId: string;
  sourcePath: string;
  destinationPath: string;
  homeBoundaryPath: string;
  expectedManifest: CompanionTreeManifest;
}

export interface OwnedTreeAncestorInput {
  destinationPath: string;
  homeBoundaryPath: string;
}

export interface ProveOwnedTreeInput {
  transactionId: string;
  role: OwnedTreeRole;
  path: string;
  homeBoundaryPath: string;
  expectedManifest: CompanionTreeManifest;
  expectedParentPath?: string;
  expectedRootIdentity?: OwnedTreePhysicalIdentity;
}

export interface OwnedTreeMutationOptions {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  hooks?: OwnedTreeMutationHooks;
}

export type OwnedTreeMutationBoundary =
  | "ancestor-mkdir"
  | "ancestor-parent-fsync"
  | "stage-mkdir"
  | "stage-root-chmod"
  | "stage-parent-fsync"
  | "copy-directory-mkdir"
  | "copy-directory-chmod"
  | "copy-file-create"
  | "copy-file-write"
  | "copy-file-chmod"
  | "copy-file-fsync"
  | "copy-parent-fsync"
  | "copy-directory-fsync"
  | "cleanup-parent-chmod-writable"
  | "cleanup-parent-chmod-restore"
  | "rename"
  | "rename-parent-fsync"
  | "unlink"
  | "unlink-parent-fsync"
  | "rmdir"
  | "rmdir-parent-fsync"
  | "ancestor-rmdir";

export type OwnedTreeVerificationBoundary =
  | "ancestor-created-verify"
  | "stage-root-verify"
  | "copy-source-manifest-verify"
  | "copy-stage-manifest-verify"
  | "exact-tree-manifest-verify"
  | "partial-cleanup-tree-verify"
  | "copy-directory-verify"
  | "copy-file-verify"
  | "copy-parent-chain-verify"
  | "source-parent-chain-verify"
  | "rename-source-probe"
  | "rename-destination-probe"
  | "cleanup-file-probe"
  | "cleanup-directory-probe"
  | "cleanup-parent-chain-verify"
  | "directory-fsync-verify";

export interface OwnedTreeMutationHooks {
  platform?: NodeJS.Platform;
  beforeBoundary?: (
    boundary: OwnedTreeMutationBoundary,
    paths: readonly string[]
  ) => void | Promise<void>;
  afterBoundary?: (
    boundary: OwnedTreeMutationBoundary,
    paths: readonly string[]
  ) => void | Promise<void>;
  beforeVerification?: (
    boundary: OwnedTreeVerificationBoundary,
    paths: readonly string[]
  ) => void | Promise<void>;
  afterVerification?: (
    boundary: OwnedTreeVerificationBoundary,
    paths: readonly string[]
  ) => void | Promise<void>;
  beforeRenameNoReplace?: (source: string, destination: string) => void | Promise<void>;
  lstatPath?: (path: string) => Promise<BigIntStats>;
  renamePath?: (source: string, destination: string) => Promise<void>;
  unlinkPath?: (path: string) => Promise<void>;
  rmdirPath?: (path: string) => Promise<void>;
  openPath?: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
  fsyncDirectory?: (path: string, expected: OwnedTreePhysicalIdentity) => Promise<void>;
}

export interface OwnedTreeStageResult {
  readonly tree: OwnedTreeHandle;
  readonly createdAncestors: readonly CreatedOwnedTreeAncestorProof[];
}

export interface ResumeOwnedTreeCleanupInput {
  transactionId: string;
  homeBoundaryPath: string;
  role: "stage" | "backup" | "cleanup";
  artifactAuthority: IntegrationRecoveryArtifactAuthority;
}

export interface ResumeOwnedTreeRecoveryArtifactInput {
  transactionId: string;
  homeBoundaryPath: string;
  role: "stage" | "backup" | "installed";
  expectedPath: string;
  artifactAuthority: IntegrationRecoveryArtifactAuthority;
}

export type OwnedTreeMoveOutcome =
  | { readonly state: "moved"; readonly handle: OwnedTreeHandle; readonly cause?: unknown }
  | { readonly state: "not-moved"; readonly handle: OwnedTreeHandle; readonly cause: unknown }
  | { readonly state: "uncertain"; readonly handle: OwnedTreeHandle; readonly error: Error };

export interface OwnedTreeCleanupReceipt {
  readonly state: "cleaned" | "cleanup-pending";
  readonly handle: OwnedTreeHandle;
  readonly warning?: Error;
}

export interface OwnedTreeRestoreReceipt {
  readonly state: "restored" | "recovery-incomplete";
  readonly restored: OwnedTreeHandle;
  readonly cleanup: OwnedTreeHandle;
  readonly warning?: Error;
}

export interface OwnedTreeAuthorityState {
  transactionId: string;
  role: OwnedTreeRole;
  status: OwnedTreeStatus;
  currentPath: string;
  homeBoundaryPath: string;
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  parent: OwnedTreeDirectoryProof;
  rootIdentity: OwnedTreePhysicalIdentity;
  manifest: CompanionTreeManifest;
  entryIdentities: Map<string, OwnedTreePhysicalIdentity>;
  deletedEntries: Set<string>;
  rootRemoved: boolean;
}

export type OwnedTreeRecoveryArtifactProof = IntegrationRecoveryArtifactProof;
