import { resolve } from "node:path";
import {
  completeIntegrationFileTransaction,
  resolveIntegrationFileTransactionHandle
} from "./integration-file-authority.js";
import {
  driftedFileTransaction,
  failedFileTransaction,
  incompleteFileRecovery,
  IntegrationFileTransactionError,
  pendingFileCleanup,
  uncertainFileTransaction,
  type IntegrationFileContentState,
  type IntegrationFileTransactionHandle,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionProof,
  type IntegrationOwnedFileProof
} from "./integration-file-domain.js";
import {
  requirePublishedIntegrationTarget,
  verifyIntegrationFileTransactionTargetClaimed
} from "./integration-file-publication.js";
import {
  assertIntegrationFileMutationBoundary,
  collapseIntegrationHardLinkPairClaimed,
  integrationOwnedSibling,
  moveExactIntegrationFileClaimed,
  readExactIntegrationFile,
  removeExactIntegrationFileClaimed,
  removeExactOwnedIntegrationFile,
  requireIntegrationExpectedState,
  sameDirectoryIdentity,
  sameExactIntegrationFile,
  sameIntegrationExpectedState,
  syncIntegrationParent,
  writeOwnedIntegrationSibling,
  type ExactIntegrationFile,
  type ExactIntegrationSnapshot
} from "./integration-file-proof.js";
import { isIntegrationMutationUncertainty } from "./integration-uncertainty.js";

export { verifyIntegrationFileTransactionTargetClaimed };

function preserveRecoveryUncertainty(error: unknown, message: string): never {
  if (
    error instanceof IntegrationFileTransactionError
    && error.code === "INTEGRATION_CONFIGURATION_UNCERTAIN"
  ) throw error;
  if (isIntegrationMutationUncertainty(error)) {
    throw uncertainFileTransaction(message, [error]);
  }
  throw incompleteFileRecovery(message, [error]);
}

async function moveOwnedFile(
  sourcePath: string,
  destinationPath: string,
  source: ExactIntegrationFile,
  destinationBefore: IntegrationFileExpectedState,
  destinationAfter: IntegrationFileContentState,
  proof: IntegrationFileTransactionProof,
  options: IntegrationFileMutationOptions
): Promise<ExactIntegrationFile> {
  return moveExactIntegrationFileClaimed({
    sourcePath,
    destinationPath,
    source,
    destinationBefore,
    destinationAfter,
    maxBytes: proof.maxBytes,
    proofs: proof.directoryProofs,
    options,
    label: "Integration recovery rename"
  });
}

export async function restoreIntegrationFileTransactionClaimed(
  handle: IntegrationFileTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const proof = resolveIntegrationFileTransactionHandle(handle);
  if (resolve(options.stateDirectory) !== proof.stateDirectory) {
    throw new IntegrationFileTransactionError(
      "INTEGRATION_CONFIGURATION_INVALID",
      "Integration transaction proof belongs to another state directory"
    );
  }
  const discardPath = integrationOwnedSibling(
    proof.targetPath,
    proof.transactionId,
    "restore.discard"
  );
  const discardCleanupPath = `${discardPath}.cleanup.claim`;
  const restorePath = integrationOwnedSibling(
    proof.targetPath,
    proof.transactionId,
    "restore.tmp"
  );
  const restoreCleanupPath = `${restorePath}.cleanup.claim`;
  const backupCleanupPath = integrationOwnedSibling(
    proof.targetPath,
    proof.transactionId,
    "restore.backup.cleanup.claim"
  );
  const afterAuthority = {
    fingerprint: proof.after.fingerprint,
    bytes: proof.after.bytes,
    mode: proof.after.mode,
    maxBytes: proof.maxBytes,
    identity: proof.targetIdentity
  };
  await collapseIntegrationHardLinkPairClaimed(
    discardPath,
    proof.targetPath,
    proof.directoryProofs,
    options,
    "Integration recovery target claim",
    afterAuthority
  );
  await collapseIntegrationHardLinkPairClaimed(
    discardPath,
    discardCleanupPath,
    proof.directoryProofs,
    options,
    "Integration recovery discard cleanup",
    afterAuthority
  );
  if (proof.before.state === "file") {
    const beforeAuthority = {
      fingerprint: proof.before.fingerprint,
      bytes: proof.before.bytes,
      mode: proof.before.mode,
      maxBytes: proof.maxBytes
    };
    await collapseIntegrationHardLinkPairClaimed(
      proof.targetPath,
      restorePath,
      proof.directoryProofs,
      options,
      "Integration recovery publication",
      beforeAuthority
    );
    await collapseIntegrationHardLinkPairClaimed(
      restorePath,
      restoreCleanupPath,
      proof.directoryProofs,
      options,
      "Integration recovery temporary cleanup",
      beforeAuthority
    );
  }

  let verifiedBackup: ExactIntegrationFile | undefined;
  if (proof.before.state === "file") {
    if (!proof.backup) {
      throw incompleteFileRecovery("Integration recovery proof is missing its exact backup", []);
    }
    await collapseIntegrationHardLinkPairClaimed(
      proof.backup.path,
      backupCleanupPath,
      proof.directoryProofs,
      options,
      "Integration recovery backup cleanup",
      {
        fingerprint: proof.backup.fingerprint,
        bytes: proof.before.bytes,
        mode: proof.backup.mode,
        maxBytes: proof.maxBytes,
        identity: proof.backup.identity
      }
    );
    const backupSnapshot = await readExactIntegrationFile(
      proof.backup.path,
      proof.maxBytes,
      proof.directoryProofs,
      "Integration recovery backup"
    );
    if (backupSnapshot.state === "file") {
      if (
        !sameDirectoryIdentity(proof.backup.identity, backupSnapshot.metadata)
        || !sameIntegrationExpectedState(backupSnapshot, {
          state: "file",
          bytes: proof.before.bytes,
          fingerprint: proof.before.fingerprint,
          mode: proof.backup.mode
        })
      ) {
        throw incompleteFileRecovery("Integration recovery backup was replaced", []);
      }
      verifiedBackup = backupSnapshot;
    } else {
      const cleanupSnapshot = await readExactIntegrationFile(
        backupCleanupPath,
        proof.maxBytes,
        proof.directoryProofs,
        "Integration recovery backup cleanup claim"
      );
      if (cleanupSnapshot.state === "file" && (
        !sameDirectoryIdentity(proof.backup.identity, cleanupSnapshot.metadata)
        || !sameIntegrationExpectedState(cleanupSnapshot, {
          state: "file",
          bytes: proof.before.bytes,
          fingerprint: proof.before.fingerprint,
          mode: proof.backup.mode
        })
      )) throw incompleteFileRecovery("Integration recovery backup cleanup claim was replaced", []);
    }
  }
  let [current, discarded, restoreTemporary] = await Promise.all([
    readExactIntegrationFile(
      proof.targetPath,
      proof.maxBytes,
      proof.directoryProofs,
      "Integration recovery target"
    ),
    readExactIntegrationFile(
      discardPath,
      proof.maxBytes,
      proof.directoryProofs,
      "Integration recovery discard"
    ),
    readExactIntegrationFile(
      restorePath,
      proof.maxBytes,
      proof.directoryProofs,
      "Integration recovery temporary"
    )
  ]);
  if (current.state === "file" && sameIntegrationExpectedState(current, proof.after)) {
    if (!sameDirectoryIdentity(proof.targetIdentity, current.metadata)) {
      throw incompleteFileRecovery("Integration recovery target identity changed", []);
    }
  } else if (!sameIntegrationExpectedState(current, proof.before)) {
    if (!(current.state === "absent" && discarded.state === "file")) {
      throw driftedFileTransaction("Integration recovery target is outside exact recovery states");
    }
  }
  if (discarded.state === "file" && (
    !sameIntegrationExpectedState(discarded, proof.after)
    || !sameDirectoryIdentity(proof.targetIdentity, discarded.metadata)
  )) {
    throw incompleteFileRecovery("Integration recovery discard changed", []);
  }
  if (restoreTemporary.state === "file" && (
    proof.before.state !== "file"
    || !sameIntegrationExpectedState(restoreTemporary, proof.before)
  )) {
    throw incompleteFileRecovery("Integration recovery temporary changed", []);
  }

  const cleanupDiscard = async (): Promise<void> => {
    const discardProof: IntegrationOwnedFileProof = {
      path: discardPath,
      identity: proof.targetIdentity,
      fingerprint: proof.after.fingerprint,
      bytes: proof.after.bytes.length,
      mode: proof.after.mode
    };
    await removeExactOwnedIntegrationFile(
      discardProof,
      proof.after,
      proof.maxBytes,
      proof.directoryProofs,
      options,
      false,
      discardCleanupPath
    );
    discarded = { state: "absent" };
  };

  if (sameIntegrationExpectedState(current, proof.before)) {
    try {
      if (restoreTemporary.state === "file") {
        await removeExactIntegrationFileClaimed({
          sourcePath: restorePath,
          claimPath: restoreCleanupPath,
          source: restoreTemporary,
          maxBytes: proof.maxBytes,
          proofs: proof.directoryProofs,
          options,
          label: "Integration recovery completed temporary cleanup"
        });
      }
      await cleanupDiscard();
      if (proof.before.state === "file") {
        await removeExactOwnedIntegrationFile(
          proof.backup!,
          {
            state: "file",
            bytes: proof.before.bytes,
            fingerprint: proof.before.fingerprint,
            mode: proof.backup!.mode
          },
          proof.maxBytes,
          proof.directoryProofs,
          options,
          false,
          backupCleanupPath
        );
      }
      await syncIntegrationParent(proof.directoryProofs, options);
      completeIntegrationFileTransaction(handle, "restored");
      return;
    } catch (error) {
      preserveRecoveryUncertainty(error, "Integration target was restored but cleanup is incomplete");
    }
  }

  if (current.state === "file") {
    if (discarded.state !== "absent") {
      throw incompleteFileRecovery("Integration recovery discard was occupied before claim", []);
    }
    try {
      discarded = await moveOwnedFile(
        proof.targetPath,
        discardPath,
        current,
        { state: "absent" },
        proof.after,
        proof,
        options
      );
      current = { state: "absent" };
    } catch (error) {
      preserveRecoveryUncertainty(error, "Integration target could not be claimed for recovery");
    }
  }
  if (proof.before.state === "absent") {
    try {
      await cleanupDiscard();
      await syncIntegrationParent(proof.directoryProofs, options);
      completeIntegrationFileTransaction(handle, "restored");
      return;
    } catch (error) {
      preserveRecoveryUncertainty(
        error,
        "Integration target was restored absent but cleanup is incomplete"
      );
    }
  }

  const backup = verifiedBackup;
  if (!backup) {
    throw incompleteFileRecovery(
      "Integration recovery backup was already claimed before target restoration completed",
      []
    );
  }
  const restoreContent: IntegrationFileContentState = {
    state: "file",
    bytes: proof.before.bytes,
    fingerprint: proof.before.fingerprint,
    mode: proof.before.mode
  };
  try {
    if (restoreTemporary.state === "absent") {
      restoreTemporary = (await writeOwnedIntegrationSibling(
        restorePath,
        restoreContent,
        proof.directoryProofs,
        options,
        proof.maxBytes,
        "Integration restore temporary",
        proof.before.mode,
        restoreCleanupPath
      )).state;
      await syncIntegrationParent(proof.directoryProofs, options);
    }
    current = await moveOwnedFile(
      restorePath,
      proof.targetPath,
      restoreTemporary,
      { state: "absent" },
      restoreContent,
      proof,
      options
    );
    restoreTemporary = { state: "absent" };
  } catch (error) {
    preserveRecoveryUncertainty(
      error,
      "Integration target could not be restored from its exact backup"
    );
  }

  const cleanupErrors: unknown[] = [];
  try {
    await cleanupDiscard();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await removeExactOwnedIntegrationFile(
      proof.backup!,
      {
        state: "file",
        bytes: proof.before.bytes,
        fingerprint: proof.before.fingerprint,
        mode: proof.backup!.mode
      },
      proof.maxBytes,
      proof.directoryProofs,
      options,
      false,
      backupCleanupPath
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await syncIntegrationParent(proof.directoryProofs, options);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    const leaseError = cleanupErrors.find((error) =>
      isIntegrationMutationUncertainty(error));
    if (leaseError) {
      throw uncertainFileTransaction(
        "Integration target was restored but cleanup lease ownership is uncertain",
        cleanupErrors
      );
    }
    throw incompleteFileRecovery(
      "Integration target was restored but owned cleanup is incomplete",
      cleanupErrors
    );
  }
  completeIntegrationFileTransaction(handle, "restored");
}

export async function finalizeIntegrationFileTransactionClaimed(
  handle: IntegrationFileTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const proof = resolveIntegrationFileTransactionHandle(handle);
  if (resolve(options.stateDirectory) !== proof.stateDirectory) {
    throw new IntegrationFileTransactionError(
      "INTEGRATION_CONFIGURATION_INVALID",
      "Integration transaction proof belongs to another state directory"
    );
  }
  try {
    await requirePublishedIntegrationTarget(proof, options);
  } catch (error) {
    throw pendingFileCleanup(
      "Integration target changed before finalized artifact cleanup",
      [error]
    );
  }
  if (!proof.backup || proof.before.state !== "file") {
    completeIntegrationFileTransaction(handle, "finalized");
    return;
  }
  await removeExactOwnedIntegrationFile(
    proof.backup,
    {
      state: "file",
      bytes: proof.before.bytes,
      fingerprint: proof.before.fingerprint,
      mode: proof.backup.mode
    },
    proof.maxBytes,
    proof.directoryProofs,
    options,
    false,
    integrationOwnedSibling(
      proof.targetPath,
      proof.transactionId,
      "finalize.backup.cleanup.claim"
    )
  );
  await syncIntegrationParent(proof.directoryProofs, options).catch((error: unknown) => {
    throw pendingFileCleanup(
      "Integration finalize backup removal durability is uncertain",
      [error]
    );
  });
  completeIntegrationFileTransaction(handle, "finalized");
}
