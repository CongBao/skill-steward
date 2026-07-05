import { resolve } from "node:path";
import {
  issueIntegrationFileTransactionHandle
} from "./integration-file-authority.js";
import {
  incompleteFileRecovery,
  withIntegrationFileMutationClaim,
  type IntegrationDirectoryProof,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionProof,
  type IntegrationOwnedFileProof
} from "./integration-file-domain.js";
import {
  useIntegrationFileRecoveryAuthority,
  type IntegrationFileRecoveryAuthority
} from "./integration-file-recovery-authority.js";
import type { IntegrationFileRecoveryArtifact } from "./integration-file-recovery-artifact.js";
import {
  assertIntegrationFileMutationBoundary,
  bindIntegrationDirectoryChain,
  readExactIntegrationFile,
  removeExactOwnedIntegrationFile,
  sameDirectoryIdentity,
  sameIntegrationExpectedState,
  syncIntegrationParent,
  type ExactIntegrationFile
} from "./integration-file-proof.js";
import {
  finalizeIntegrationFileTransactionClaimed,
  restoreIntegrationFileTransactionClaimed
} from "./integration-file-recovery.js";

function identity(value: { device: string; inode: string }) {
  return { device: BigInt(value.device), inode: BigInt(value.inode) };
}

function owned(
  value: IntegrationFileRecoveryArtifact["temporary"]
): IntegrationOwnedFileProof {
  return { ...value, identity: identity(value.identity) };
}

function expectedFile(
  snapshot: ExactIntegrationFile,
  mode: number
): IntegrationFileContentState {
  return {
    state: "file",
    bytes: Uint8Array.from(snapshot.bytes),
    fingerprint: snapshot.fingerprint,
    mode
  };
}

async function bindArtifact(
  artifact: IntegrationFileRecoveryArtifact,
  options: IntegrationFileMutationOptions
): Promise<readonly IntegrationDirectoryProof[]> {
  if (resolve(options.stateDirectory) !== artifact.stateDirectory) {
    throw incompleteFileRecovery("Integration recovery artifact belongs to another state", []);
  }
  const proofs = await bindIntegrationDirectoryChain(
    artifact.allowedBoundaryPath,
    artifact.targetPath
  );
  if (proofs.length !== artifact.directoryProofs.length) {
    throw incompleteFileRecovery("Integration recovery directory chain changed", []);
  }
  for (const [index, proof] of proofs.entries()) {
    const persisted = artifact.directoryProofs[index]!;
    if (
      proof.path !== persisted.path
      || proof.physicalPath !== persisted.physicalPath
      || proof.identity.device !== BigInt(persisted.identity.device)
      || proof.identity.inode !== BigInt(persisted.identity.inode)
    ) {
      throw incompleteFileRecovery("Integration recovery directory identity changed", []);
    }
  }
  await assertIntegrationFileMutationBoundary(options, proofs);
  return proofs;
}

async function reconstructPublishedProof(
  artifact: IntegrationFileRecoveryArtifact,
  options: IntegrationFileMutationOptions
): Promise<IntegrationFileTransactionProof> {
  const directoryProofs = await bindArtifact(artifact, options);
  const [target, backup] = await Promise.all([
    readExactIntegrationFile(
      artifact.targetPath,
      artifact.maxBytes,
      directoryProofs,
      "Integration restart recovery target"
    ),
    artifact.backup
      ? readExactIntegrationFile(
          artifact.backup.path,
          artifact.maxBytes,
          directoryProofs,
          "Integration restart recovery backup"
        )
      : Promise.resolve({ state: "absent" } as const)
  ]);
  if (
    target.state !== "file"
    || target.fingerprint !== artifact.after.fingerprint
    || target.bytes.length !== artifact.after.bytes
    || target.mode !== artifact.after.mode
    || !sameDirectoryIdentity(identity(artifact.temporary.identity), target.metadata)
  ) {
    throw incompleteFileRecovery("Integration published recovery target changed", []);
  }
  let before: IntegrationFileExpectedState = { state: "absent" };
  if (artifact.before.state === "file") {
    if (
      artifact.backup === undefined
      || backup.state !== "file"
      || backup.fingerprint !== artifact.before.fingerprint
      || backup.bytes.length !== artifact.before.bytes
      || backup.mode !== artifact.backup.mode
      || !sameDirectoryIdentity(identity(artifact.backup.identity), backup.metadata)
    ) {
      throw incompleteFileRecovery("Integration restart recovery backup changed", []);
    }
    before = expectedFile(backup, artifact.before.mode);
  }
  return {
    schemaVersion: 1,
    transactionId: artifact.publicationTransactionId,
    outcome: "published",
    stateDirectory: artifact.stateDirectory,
    targetPath: artifact.targetPath,
    allowedBoundaryPath: artifact.allowedBoundaryPath,
    before,
    after: expectedFile(target, artifact.after.mode),
    targetIdentity: identity(artifact.temporary.identity),
    parent: directoryProofs.at(-1)!,
    ...(artifact.backup ? { backup: owned(artifact.backup) } : {}),
    maxBytes: artifact.maxBytes,
    directoryProofs
  };
}

async function cleanupPreparedPublication(
  artifact: IntegrationFileRecoveryArtifact,
  options: IntegrationFileMutationOptions
): Promise<boolean> {
  const directoryProofs = await bindArtifact(artifact, options);
  const target = await readExactIntegrationFile(
    artifact.targetPath,
    artifact.maxBytes,
    directoryProofs,
    "Integration prepared recovery target"
  );
  let beforeMatches = artifact.before.state === "absent"
    ? target.state === "absent"
    : target.state === "file"
      && target.fingerprint === artifact.before.fingerprint
      && target.bytes.length === artifact.before.bytes
      && target.mode === artifact.before.mode;
  if (!beforeMatches) return false;

  const temporary = await readExactIntegrationFile(
    artifact.temporary.path,
    artifact.maxBytes,
    directoryProofs,
    "Integration prepared recovery temporary"
  );
  if (
    temporary.state !== "file"
    || temporary.fingerprint !== artifact.temporary.fingerprint
    || temporary.bytes.length !== artifact.temporary.bytes
    || temporary.mode !== artifact.temporary.mode
    || !sameDirectoryIdentity(identity(artifact.temporary.identity), temporary.metadata)
  ) return false;
  await removeExactOwnedIntegrationFile(
    owned(artifact.temporary),
    expectedFile(temporary, artifact.temporary.mode),
    artifact.maxBytes,
    directoryProofs,
    options,
    false,
    `${artifact.temporary.path}.recovery.cleanup.claim`
  );
  if (artifact.backup) {
    const backup = await readExactIntegrationFile(
      artifact.backup.path,
      artifact.maxBytes,
      directoryProofs,
      "Integration prepared recovery backup"
    );
    if (
      backup.state !== "file"
      || backup.fingerprint !== artifact.backup.fingerprint
      || backup.bytes.length !== artifact.backup.bytes
      || backup.mode !== artifact.backup.mode
      || !sameDirectoryIdentity(identity(artifact.backup.identity), backup.metadata)
    ) throw incompleteFileRecovery("Integration prepared recovery backup changed", []);
    await removeExactOwnedIntegrationFile(
      owned(artifact.backup),
      expectedFile(backup, artifact.backup.mode),
      artifact.maxBytes,
      directoryProofs,
      options,
      false,
      `${artifact.backup.path}.recovery.cleanup.claim`
    );
  }
  await syncIntegrationParent(directoryProofs, options);
  return true;
}

export async function restoreIntegrationFileFromRecovery(
  authority: IntegrationFileRecoveryAuthority,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    useIntegrationFileRecoveryAuthority(
      authority,
      options.stateDirectory,
      "restore",
      options.leaseContext,
      async (artifact) => {
        if (await cleanupPreparedPublication(artifact, options)) return;
        const handle = issueIntegrationFileTransactionHandle(
          await reconstructPublishedProof(artifact, options)
        );
        await restoreIntegrationFileTransactionClaimed(handle, options);
      }
    ));
}

export async function finalizeIntegrationFileFromRecovery(
  authority: IntegrationFileRecoveryAuthority,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    useIntegrationFileRecoveryAuthority(
      authority,
      options.stateDirectory,
      "finalize",
      options.leaseContext,
      async (artifact, assertCurrentLifecycleRecord) => {
        const handle = issueIntegrationFileTransactionHandle(
          await reconstructPublishedProof(artifact, options)
        );
        await assertCurrentLifecycleRecord();
        await finalizeIntegrationFileTransactionClaimed(handle, options);
      }
    ));
}
