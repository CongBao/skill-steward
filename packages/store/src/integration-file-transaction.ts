import {
  DEFAULT_INTEGRATION_FILE_MAX_BYTES,
  withIntegrationFileMutationClaim,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionHandle,
  type IntegrationFileTransactionInput
} from "./integration-file-domain.js";
export {
  integrationFileRecoveryArtifactSchema,
  type IntegrationFileRecoveryArtifact
} from "./integration-file-recovery-artifact.js";
export {
  finalizeIntegrationFileFromRecovery,
  restoreIntegrationFileFromRecovery
} from "./integration-file-restart-recovery.js";
export type {
  IntegrationFileRecoveryAuthority,
  IntegrationFileRecoveryOperation
} from "./integration-file-recovery-authority.js";
import {
  integrationFileTransactionReceipt
} from "./integration-file-authority.js";
import {
  inspectIntegrationFileStateClaimed,
  publishIntegrationFileTransactionClaimed,
  verifyIntegrationFileTransactionTargetClaimed
} from "./integration-file-publication.js";
import {
  finalizeIntegrationFileTransactionClaimed,
  restoreIntegrationFileTransactionClaimed
} from "./integration-file-recovery.js";

export {
  fingerprintIntegrationFileBytes,
  IntegrationFileTransactionError,
  type IntegrationFileTransactionHandle,
  type IntegrationFileTransactionReceipt,
  withIntegrationFileMutationClaim,
  type IntegrationFileAbsentState,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionErrorCode,
  type IntegrationFileTransactionInput
} from "./integration-file-domain.js";
export { integrationFileTransactionReceipt } from "./integration-file-authority.js";
export {
  inspectIntegrationFileStateClaimed,
  publishIntegrationFileTransactionClaimed,
  verifyIntegrationFileTransactionTargetClaimed
} from "./integration-file-publication.js";
export {
  finalizeIntegrationFileTransactionClaimed,
  restoreIntegrationFileTransactionClaimed
} from "./integration-file-recovery.js";

export async function publishIntegrationFileTransaction(
  input: IntegrationFileTransactionInput,
  options: IntegrationFileMutationOptions
): Promise<IntegrationFileTransactionHandle> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    publishIntegrationFileTransactionClaimed(input, options));
}

export async function inspectIntegrationFileState(
  targetPath: string,
  allowedBoundaryPath: string,
  options: IntegrationFileMutationOptions,
  maxBytes = DEFAULT_INTEGRATION_FILE_MAX_BYTES
) {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    inspectIntegrationFileStateClaimed(targetPath, allowedBoundaryPath, options, maxBytes));
}

export async function restoreIntegrationFileTransaction(
  proof: IntegrationFileTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    restoreIntegrationFileTransactionClaimed(proof, options));
}

export async function finalizeIntegrationFileTransaction(
  proof: IntegrationFileTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    finalizeIntegrationFileTransactionClaimed(proof, options));
}
