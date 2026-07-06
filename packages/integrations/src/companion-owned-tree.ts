/**
 * Package-private companion tree transaction primitives.
 *
 * This facade is deliberately not re-exported from the integrations package
 * root. Public callers receive only reviewed integration operations; raw
 * filesystem proof and mutation authority stays inside this package.
 */
export {
  ownedTreeHandleSnapshot,
  ownedTreeRecoveryArtifactProof,
  ownedTreeSiblingPath
} from "./companion-owned-tree-authority.js";
export {
  createOwnedTreeAncestors,
  createOwnedTreeStage
} from "./companion-owned-tree-copy.js";
export {
  cleanupOwnedTree,
  restoreOwnedTreeUpgrade,
  rollbackCreatedOwnedTreeAncestors
} from "./companion-owned-tree-cleanup.js";
export { moveOwnedTree, proveOwnedTree } from "./companion-owned-tree-move.js";
export {
  resumeOwnedTreeCleanup,
  resumeOwnedTreeRecoveryArtifact
} from "./companion-owned-tree-recovery.js";
export type {
  CreatedOwnedTreeAncestorProof,
  OwnedTreeCleanupReceipt,
  OwnedTreeAncestorInput,
  OwnedTreeHandle,
  OwnedTreeHandleSnapshot,
  OwnedTreeMoveOutcome,
  OwnedTreeMutationBoundary,
  OwnedTreeMutationHooks,
  OwnedTreeMutationOptions,
  OwnedTreeVerificationBoundary,
  OwnedTreeRecoveryArtifactProof,
  OwnedTreeRestoreReceipt,
  OwnedTreeRole,
  OwnedTreeStageInput,
  OwnedTreeStageResult,
  OwnedTreeStatus,
  ProveOwnedTreeInput,
  ResumeOwnedTreeRecoveryArtifactInput,
  ResumeOwnedTreeCleanupInput
} from "./companion-owned-tree-domain.js";
