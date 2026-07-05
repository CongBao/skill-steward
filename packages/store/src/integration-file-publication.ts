import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { assertIntegrationMutationLeaseOwned } from "./integration-mutation-lease.js";
import {
  issueIntegrationFileTransactionHandle,
  resolveIntegrationFileTransactionHandleForVerification
} from "./integration-file-authority.js";
import {
  cloneIntegrationFileState,
  driftedFileTransaction,
  failedFileTransaction,
  incompleteFileRecovery,
  IntegrationFileTransactionError,
  invalidFileTransaction,
  normalizeIntegrationExpectedState,
  normalizeIntegrationMaxBytes,
  normalizeIntegrationPath,
  pendingFileCleanup,
  uncertainFileTransaction,
  type IntegrationFileContentState,
  type IntegrationFileTransactionHandle,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionInput,
  type IntegrationFileTransactionProof,
  type IntegrationOwnedFileProof
} from "./integration-file-domain.js";
import {
  immutableIntegrationFileRecoveryArtifact,
  type IntegrationFileRecoveryArtifact
} from "./integration-file-recovery-artifact.js";
import {
  assertIntegrationFileMutationBoundary,
  bindIntegrationDirectoryChain,
  classifyIntegrationRename,
  inspectIntegrationFileStateClaimed,
  integrationOwnedSibling,
  integrationPhysicalIdentity,
  removeExactOwnedIntegrationFile,
  requireIntegrationExpectedState,
  sameIntegrationFileAcrossRename,
  sameExactIntegrationFile,
  syncIntegrationParent,
  writeOwnedIntegrationSibling,
  type ExactIntegrationFile
} from "./integration-file-proof.js";

export { inspectIntegrationFileStateClaimed } from "./integration-file-proof.js";

export async function publishIntegrationFileTransactionStateClaimed(
  input: IntegrationFileTransactionInput,
  options: IntegrationFileMutationOptions,
  policy: { centralRecovery?: boolean; ownedTransactionId?: string } = {}
): Promise<IntegrationFileTransactionProof> {
  const stateDirectory = normalizeIntegrationPath(
    options.stateDirectory,
    "Integration state directory"
  );
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  const maxBytes = normalizeIntegrationMaxBytes(input.maxBytes);
  const targetPath = normalizeIntegrationPath(input.targetPath, "Integration target");
  const allowedBoundaryPath = normalizeIntegrationPath(
    input.allowedBoundaryPath,
    "Allowed physical boundary"
  );
  const before = normalizeIntegrationExpectedState(
    input.expectedBefore,
    maxBytes,
    "Expected before state"
  );
  const after = normalizeIntegrationExpectedState(input.after, maxBytes, "Expected after state");
  if (after.state !== "file") throw invalidFileTransaction("Expected after state must be a file");
  const directoryProofs = await bindIntegrationDirectoryChain(allowedBoundaryPath, targetPath);
  await assertIntegrationFileMutationBoundary(options, directoryProofs);
  const observedBefore = await requireIntegrationExpectedState(
    targetPath,
    before,
    maxBytes,
    directoryProofs,
    "Integration target"
  );
  if (
    policy.ownedTransactionId !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(policy.ownedTransactionId)
  ) {
    throw invalidFileTransaction("Owned integration transaction ID is invalid");
  }
  const transactionId = policy.ownedTransactionId ?? randomUUID();
  const temporaryPath = integrationOwnedSibling(targetPath, transactionId, "tmp");
  const backupPath = integrationOwnedSibling(targetPath, transactionId, "backup");
  const temporaryCleanupPath = policy.centralRecovery
    ? `${temporaryPath}.cleanup.claim`
    : integrationOwnedSibling(
        targetPath,
        transactionId,
        "publication.temporary.cleanup.claim"
      );
  let temporary: { state: ExactIntegrationFile; proof: IntegrationOwnedFileProof } | undefined;
  let backup: { state: ExactIntegrationFile; proof: IntegrationOwnedFileProof } | undefined;
  let recoveryArtifact: IntegrationFileRecoveryArtifact | undefined;
  let published = false;
  let primary: unknown;
  try {
    if (observedBefore.state === "file" && !policy.centralRecovery) {
      backup = await writeOwnedIntegrationSibling(
        backupPath,
        {
          state: "file",
          bytes: observedBefore.bytes,
          fingerprint: observedBefore.fingerprint,
          mode: 0o600
        },
        directoryProofs,
        options,
        maxBytes,
        "Integration backup"
      );
    }
    temporary = await writeOwnedIntegrationSibling(
      temporaryPath,
      after,
      directoryProofs,
      options,
      maxBytes,
      "Integration temporary",
      after.mode,
      temporaryCleanupPath
    );
    await syncIntegrationParent(directoryProofs, options).catch((error: unknown) => {
      throw error instanceof IntegrationFileTransactionError
        ? error
        : failedFileTransaction(
            "Integration owned files could not be made durable before publication",
            error
          );
    });
    await assertIntegrationFileMutationBoundary(options, directoryProofs);
    const currentBefore = await requireIntegrationExpectedState(
      targetPath,
      before,
      maxBytes,
      directoryProofs,
      "Integration target before publication"
    );
    if (
      observedBefore.state !== currentBefore.state
      || observedBefore.state === "file"
        && (currentBefore.state !== "file"
          || !sameExactIntegrationFile(observedBefore.metadata, currentBefore.metadata))
    ) {
      throw driftedFileTransaction("Integration target changed while staging the new bytes");
    }
    if (backup && observedBefore.state === "file") {
      const currentBackup = await requireIntegrationExpectedState(
        backup.proof.path,
        {
          state: "file",
          bytes: observedBefore.bytes,
          fingerprint: observedBefore.fingerprint,
          mode: 0o600
        },
        maxBytes,
        directoryProofs,
        "Integration backup before publication"
      );
      if (
        currentBackup.state !== "file"
        || !sameExactIntegrationFile(backup.state.metadata, currentBackup.metadata)
      ) {
        throw driftedFileTransaction("Integration backup changed while staging the new bytes");
      }
    }
    if (input.recovery) {
      recoveryArtifact = immutableIntegrationFileRecoveryArtifact({
        schemaVersion: 1,
        recoveryTransactionId: input.recovery.transactionId,
        publicationTransactionId: transactionId,
        stateDirectory,
        targetPath,
        allowedBoundaryPath,
        maxBytes,
        before: before.state === "absent"
          ? { state: "absent" }
          : {
              state: "file",
              fingerprint: before.fingerprint,
              bytes: before.bytes.byteLength,
              mode: before.mode
            },
        after: {
          fingerprint: after.fingerprint,
          bytes: after.bytes.byteLength,
          mode: after.mode
        },
        directoryProofs: directoryProofs.map((proof) => ({
          path: proof.path,
          physicalPath: proof.physicalPath,
          identity: {
            device: proof.identity.device.toString(),
            inode: proof.identity.inode.toString()
          }
        })),
        temporary: {
          ...temporary.proof,
          identity: {
            device: temporary.proof.identity.device.toString(),
            inode: temporary.proof.identity.inode.toString()
          }
        },
        ...(backup
          ? {
              backup: {
                ...backup.proof,
                identity: {
                  device: backup.proof.identity.device.toString(),
                  inode: backup.proof.identity.inode.toString()
                }
              }
            }
          : {})
      });
      await input.recovery.beforePublish(recoveryArtifact);
    }
    // The lease assertion must be the final filesystem await before publication.
    await assertIntegrationFileMutationBoundary(options, directoryProofs);
    let renameError: unknown;
    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      renameError = error;
    }
    const outcome = await classifyIntegrationRename(
      temporaryPath,
      targetPath,
      temporary.state,
      before,
      after,
      maxBytes,
      directoryProofs,
      renameError ?? new Error("rename returned success")
    );
    if (outcome.state === "not-published") {
      if (renameError === undefined) {
        throw uncertainFileTransaction(
          "Integration rename returned success without publication",
          [outcome.cause]
        );
      }
      throw failedFileTransaction("Integration file publication did not commit", outcome.cause);
    }
    if (outcome.state === "uncertain") throw outcome.error;
    published = true;
    temporary = undefined;
    await syncIntegrationParent(directoryProofs, options).catch((error: unknown) => {
      throw uncertainFileTransaction(
        "Integration publication committed but parent durability is uncertain",
        [error]
      );
    });
    const verified = await requireIntegrationExpectedState(
      targetPath,
      after,
      maxBytes,
      directoryProofs,
      "Published integration target"
    ).catch((error: unknown) => {
      throw uncertainFileTransaction("Published integration target could not be verified", [error]);
    });
    if (
      verified.state !== "file"
      || !sameIntegrationFileAcrossRename(outcome.destination.metadata, verified.metadata)
    ) {
      throw uncertainFileTransaction(
        "Published integration target identity changed after rename",
        []
      );
    }
    return {
      schemaVersion: 1,
      transactionId,
      outcome: "published",
      stateDirectory,
      targetPath,
      allowedBoundaryPath,
      before: cloneIntegrationFileState(before),
      after: cloneIntegrationFileState(after) as IntegrationFileContentState,
      targetIdentity: integrationPhysicalIdentity(verified.metadata),
      parent: {
        path: directoryProofs.at(-1)!.path,
        physicalPath: directoryProofs.at(-1)!.physicalPath,
        identity: directoryProofs.at(-1)!.identity
      },
      ...(backup ? { backup: backup.proof } : {}),
      maxBytes,
      directoryProofs
    };
  } catch (error) {
    primary = error;
  }
  if (
    published
    || primary instanceof IntegrationFileTransactionError
      && primary.code === "INTEGRATION_CONFIGURATION_UNCERTAIN"
  ) {
    throw primary;
  }
  const cleanupErrors: unknown[] = [];
  if (temporary) {
    try {
      await removeExactOwnedIntegrationFile(
        temporary.proof,
        temporary.state,
        maxBytes,
        directoryProofs,
        options,
        false,
        temporaryCleanupPath
      );
      await syncIntegrationParent(directoryProofs, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (backup) {
    try {
      await removeExactOwnedIntegrationFile(
        backup.proof,
        backup.state,
        maxBytes,
        directoryProofs,
        options,
        false,
        integrationOwnedSibling(
          targetPath,
          transactionId,
          "publication.backup.cleanup.claim"
        )
      );
      await syncIntegrationParent(directoryProofs, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw pendingFileCleanup(
      "Integration publication failed and owned artifact cleanup is pending",
      [primary, ...cleanupErrors],
      recoveryArtifact
    );
  }
  throw primary;
}

export async function publishIntegrationFileTransactionClaimed(
  input: IntegrationFileTransactionInput,
  options: IntegrationFileMutationOptions,
  policy: { centralRecovery?: boolean; ownedTransactionId?: string } = {}
): Promise<IntegrationFileTransactionHandle> {
  return issueIntegrationFileTransactionHandle(
    await publishIntegrationFileTransactionStateClaimed(input, options, policy)
  );
}

export async function requirePublishedIntegrationTarget(
  proof: IntegrationFileTransactionProof,
  options: IntegrationFileMutationOptions
): Promise<ExactIntegrationFile> {
  if (normalizeIntegrationPath(options.stateDirectory, "Integration state directory") !== proof.stateDirectory) {
    throw invalidFileTransaction("Integration transaction proof belongs to another state directory");
  }
  await assertIntegrationFileMutationBoundary(options, proof.directoryProofs);
  const current = await requireIntegrationExpectedState(
    proof.targetPath,
    proof.after,
    proof.maxBytes,
    proof.directoryProofs,
    "Integration transaction target"
  );
  if (
    current.state !== "file"
    || current.metadata.dev !== proof.targetIdentity.device
    || current.metadata.ino !== proof.targetIdentity.inode
  ) {
    throw incompleteFileRecovery(
      "Integration transaction target was replaced before recovery",
      []
    );
  }
  return current;
}

export async function verifyIntegrationFileTransactionTargetClaimed(
  handle: IntegrationFileTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<IntegrationFileContentState> {
  const proof = resolveIntegrationFileTransactionHandleForVerification(handle);
  const current = await requirePublishedIntegrationTarget(proof, options);
  return {
    state: "file",
    bytes: Uint8Array.from(current.bytes),
    fingerprint: current.fingerprint,
    mode: current.mode
  };
}
