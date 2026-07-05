import { join, resolve } from "node:path";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";
import { appendIntegrationReportHistoryClaimed } from "./integration-history-store.js";
import { assertIntegrationMutationLeaseOwned } from "./integration-mutation-lease.js";
import {
  finalizeIntegrationFileTransactionClaimed,
  fingerprintIntegrationFileBytes,
  inspectIntegrationFileStateClaimed,
  publishIntegrationFileTransactionClaimed,
  verifyIntegrationFileTransactionTargetClaimed,
  withIntegrationFileMutationClaim,
  IntegrationFileTransactionError,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionHandle
} from "./integration-file-transaction.js";
import {
  assertIntegrationReadinessCommitPair,
  commitIntegrationReadinessTransaction,
  completeIntegrationReadinessTransaction,
  finalizeIntegrationReadinessTransaction,
  inspectIntegrationReadinessTransaction,
  integrationReadinessTransactionReceipt,
  issueIntegrationReadinessTransactionHandle,
  resolveIntegrationReadinessTransactionHandle,
  resolvePublishedIntegrationReadinessTransactionHandle,
  type IntegrationReadinessTransactionHandle,
  type IntegrationReadinessTransactionState
} from "./integration-readiness-authority.js";
import { integrationFileTransactionStatus } from "./integration-file-authority.js";
import {
  IntegrationReadinessError,
  type IntegrationReadinessErrorCode,
  type IntegrationReadinessPublishOptions,
  type IntegrationReadinessRecoveryArtifact
} from "./integration-readiness-domain.js";
import { bindIntegrationReadinessRecoveryArtifact } from "./integration-readiness-recovery-binding.js";
import {
  claimIntegrationRecordCommitReceipt,
  resolveIntegrationRecordCommitReceipt,
  type IntegrationRecordCommitReceipt
} from "./integration-record-authority.js";
import {
  captureIntegrationReadinessRecoveryArtifact,
  cleanupIntegrationReadinessBackupClaimed,
  integrationReadinessBackupPath,
  integrationReadinessBackupSchema,
  integrationReadinessPublicationTransactionId,
  MAX_BACKUP_BYTES,
  MAX_REPORT_BYTES,
  LATEST_REPORT,
  PREVIOUS_REPORT,
  reconcileIntegrationReadinessBackupPublicationClaimed,
  restoreIntegrationReadinessFromArtifactClaimed,
  finalizeIntegrationReadinessFromBindingClaimed,
  restoreIntegrationReadinessFromBindingClaimed,
  verifyIntegrationReadinessRecoveryTarget,
  type IntegrationReadinessBackup
} from "./integration-readiness-recovery.js";
import {
  useIntegrationReadinessRecoveryAuthority,
  type IntegrationReadinessRecoveryAuthority
} from "./integration-readiness-recovery-authority.js";
import { isIntegrationMutationUncertainty } from "./integration-uncertainty.js";

export {
  deriveIntegrationReadinessRecoveryArtifact,
  integrationReadinessBackupSchema,
  integrationReadinessRecoveryArtifact,
  integrationReadinessRecoveryArtifactSchema,
  type IntegrationReadinessBackup,
  type IntegrationReadinessRecoveryArtifact
} from "./integration-readiness-recovery.js";
export {
  integrationReadinessRecoveryBindingSchema,
  type IntegrationReadinessRecoveryBinding
} from "./integration-readiness-recovery-binding.js";
export type {
  IntegrationReadinessRecoveryAuthority,
  IntegrationReadinessRecoveryOperation
} from "./integration-readiness-recovery-authority.js";

export {
  IntegrationReadinessError,
  type IntegrationReadinessErrorCode,
  type IntegrationReadinessPublishOptions,
  type IntegrationReadinessTrigger
} from "./integration-readiness-domain.js";

export {
  integrationReadinessTransactionReceipt,
  type IntegrationReadinessTransactionHandle,
  type IntegrationReadinessTransactionReceipt
} from "./integration-readiness-authority.js";

export interface IntegrationReadinessFinalizeWarning {
  code:
    | "INTEGRATION_READINESS_HISTORY_PENDING"
    | "INTEGRATION_READINESS_CLEANUP_PENDING"
    | "INTEGRATION_READINESS_STATE_DRIFT"
    | "INTEGRATION_READINESS_FINALIZE_UNCERTAIN";
  message: string;
  cause: unknown;
}

export type IntegrationReadinessFinalizeResult =
  | { status: "finalized"; warnings: [] }
  | { status: "committed-warning"; warnings: IntegrationReadinessFinalizeWarning[] };

function committedWarning(
  code: IntegrationReadinessFinalizeWarning["code"],
  message: string,
  cause: unknown
): IntegrationReadinessFinalizeResult {
  return { status: "committed-warning", warnings: [{ code, message, cause }] };
}

function immutableFinalizedResult(): IntegrationReadinessFinalizeResult {
  return Object.freeze({
    status: "finalized" as const,
    warnings: Object.freeze([]) as unknown as []
  });
}

function readinessError(
  code: IntegrationReadinessErrorCode,
  message: string,
  causes: unknown[],
  recovery?: {
    artifact?: IntegrationReadinessRecoveryArtifact;
    transactionId?: string;
  }
): IntegrationReadinessError {
  return new IntegrationReadinessError(code, message, {
    cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message),
    ...(recovery?.artifact ? { recoveryArtifact: recovery.artifact } : {}),
    ...(recovery?.transactionId ? { recoveryTransactionId: recovery.transactionId } : {})
  });
}

function mapFileError(
  error: unknown,
  action: string,
  recovery?: { artifact?: IntegrationReadinessRecoveryArtifact; transactionId?: string }
): IntegrationReadinessError {
  if (isIntegrationMutationUncertainty(error)) {
    return readinessError(
      "INTEGRATION_READINESS_UNCERTAIN",
      `${action} is uncertain`,
      [error],
      recovery
    );
  }
  if (!(error instanceof IntegrationFileTransactionError)) {
    return readinessError("INTEGRATION_READINESS_FAILED", `${action} failed`, [error]);
  }
  const code: IntegrationReadinessErrorCode = error.code === "INTEGRATION_CONFIGURATION_INVALID"
    ? "INTEGRATION_READINESS_INVALID"
    : error.code === "INTEGRATION_CONFIGURATION_DRIFT"
      ? "INTEGRATION_READINESS_DRIFT"
      : error.code === "INTEGRATION_CONFIGURATION_UNCERTAIN"
        ? "INTEGRATION_READINESS_UNCERTAIN"
        : error.code === "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
          || error.code === "INTEGRATION_CONFIGURATION_CLEANUP_PENDING"
          ? "INTEGRATION_READINESS_RECOVERY_INCOMPLETE"
          : "INTEGRATION_READINESS_FAILED";
  return readinessError(code, `${action} failed`, [error], recovery);
}

function serializeReport(report: PortfolioReport): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_REPORT_BYTES) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness report exceeds its byte bound",
      []
    );
  }
  return bytes;
}

function content(bytes: Uint8Array, mode = 0o600): IntegrationFileContentState {
  return {
    state: "file",
    bytes,
    fingerprint: fingerprintIntegrationFileBytes(bytes),
    mode
  };
}

function backupState(state: IntegrationFileExpectedState): IntegrationReadinessBackup["latest"] {
  return state.state === "absent"
    ? { state: "absent" }
    : {
        state: "file",
        bytesBase64: Buffer.from(state.bytes).toString("base64"),
        fingerprint: state.fingerprint,
        mode: state.mode
      };
}

function decodeReportState(
  state: IntegrationFileExpectedState,
  label: string
): PortfolioReport | undefined {
  if (state.state === "absent") return undefined;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(state.bytes);
  } catch (error) {
    throw readinessError(
      "INTEGRATION_READINESS_DRIFT",
      `${label} is not valid UTF-8`,
      [error]
    );
  }
  try {
    return portfolioReportSchema.parse(JSON.parse(source));
  } catch (error) {
    throw readinessError(
      "INTEGRATION_READINESS_DRIFT",
      `${label} is not a strict portfolio report`,
      [error]
    );
  }
}

async function publishClaimed(
  input: PortfolioReport,
  options: IntegrationReadinessPublishOptions
): Promise<IntegrationReadinessTransactionState> {
  let report: PortfolioReport;
  try {
    report = portfolioReportSchema.parse(input);
  } catch (error) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness input must be a strict portfolio report",
      [error]
    );
  }
  const stateDirectory = resolve(options.stateDirectory);
  const latestPath = join(stateDirectory, LATEST_REPORT);
  const previousPath = join(stateDirectory, PREVIOUS_REPORT);
  let latestBefore: IntegrationFileExpectedState;
  let previousBefore: IntegrationFileExpectedState;
  try {
    latestBefore = await inspectIntegrationFileStateClaimed(
      latestPath,
      stateDirectory,
      options,
      MAX_REPORT_BYTES
    );
    previousBefore = await inspectIntegrationFileStateClaimed(
      previousPath,
      stateDirectory,
      options,
      MAX_REPORT_BYTES
    );
  } catch (error) {
    throw mapFileError(error, "Readiness pre-state inspection");
  }
  const latestReport = decodeReportState(latestBefore, "Current latest readiness report");
  decodeReportState(previousBefore, "Current previous readiness report");
  const reportBytes = serializeReport(report);
  const publishPrevious = latestBefore.state === "file"
    && latestReport?.portfolioFingerprint !== report.portfolioFingerprint;
  const intendedPrevious: IntegrationFileExpectedState = publishPrevious
    ? content(serializeReport(latestReport!))
    : previousBefore;

  const optionsResult = integrationReadinessBackupSchema.pick({
    transactionId: true,
    trigger: true
  }).safeParse({ transactionId: options.transactionId, trigger: options.trigger });
  if (!optionsResult.success) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness publication requires a valid record ID and lifecycle trigger",
      [optionsResult.error]
    );
  }
  const transactionId = optionsResult.data.transactionId;
  const backupRecord = integrationReadinessBackupSchema.parse({
    schemaVersion: 1,
    transactionId,
    reportFingerprint: report.portfolioFingerprint,
    trigger: optionsResult.data.trigger,
    latest: backupState(latestBefore),
    previous: backupState(previousBefore),
    intended: {
      latest: backupState(content(reportBytes)),
      previous: backupState(intendedPrevious)
    }
  });
  const backupBytes = Buffer.from(`${JSON.stringify(backupRecord, null, 2)}\n`, "utf8");
  if (backupBytes.length > MAX_BACKUP_BYTES) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness backup exceeds its byte bound",
      []
    );
  }
  let backupProof: IntegrationFileTransactionHandle;
  try {
    backupProof = await publishIntegrationFileTransactionClaimed({
      targetPath: integrationReadinessBackupPath(stateDirectory, transactionId),
      allowedBoundaryPath: stateDirectory,
      expectedBefore: { state: "absent" },
      after: content(backupBytes),
      maxBytes: MAX_BACKUP_BYTES
    }, options, {
      centralRecovery: true,
      ownedTransactionId: integrationReadinessPublicationTransactionId(
        transactionId,
        "backup"
      )
    });
  } catch (error) {
    let artifact: IntegrationReadinessRecoveryArtifact | undefined;
    let captureFailure: unknown;
    try {
      const reconciled = await reconcileIntegrationReadinessBackupPublicationClaimed(
        backupRecord,
        backupBytes,
        options
      );
      if (reconciled || isIntegrationMutationUncertainty(error)) {
        artifact = await captureIntegrationReadinessRecoveryArtifact(
          backupRecord,
          backupBytes,
          options
        );
      }
    } catch (captureError) {
      captureFailure = captureError;
    }
    const cause = captureFailure === undefined ? error : new AggregateError(
      [error, captureFailure],
      "Readiness backup publication and recovery artifact capture both failed"
    );
    throw mapFileError(cause, "Readiness backup publication", {
      ...(artifact ? { artifact } : {}),
      transactionId
    });
  }

  let previousProof: IntegrationFileTransactionHandle | undefined;
  try {
    if (options.recovery) {
      const prepublicationArtifact = await captureIntegrationReadinessRecoveryArtifact(
        backupRecord,
        backupBytes,
        options
      );
      await options.recovery.beforePublish(bindIntegrationReadinessRecoveryArtifact(
        options.recovery.transactionId,
        prepublicationArtifact
      ));
    }
    if (publishPrevious) {
      previousProof = await publishIntegrationFileTransactionClaimed({
        targetPath: previousPath,
        allowedBoundaryPath: stateDirectory,
        expectedBefore: previousBefore,
        after: intendedPrevious as IntegrationFileContentState,
        maxBytes: MAX_REPORT_BYTES
      }, options, {
        centralRecovery: true,
        ownedTransactionId: integrationReadinessPublicationTransactionId(
          transactionId,
          "previous"
        )
      });
    }
    const latestProof = await publishIntegrationFileTransactionClaimed({
      targetPath: latestPath,
      allowedBoundaryPath: stateDirectory,
      expectedBefore: latestBefore,
      after: content(reportBytes),
      maxBytes: MAX_REPORT_BYTES
    }, options, {
      centralRecovery: true,
      ownedTransactionId: integrationReadinessPublicationTransactionId(
        transactionId,
        "latest"
      )
    });
    const recoveryArtifact = await captureIntegrationReadinessRecoveryArtifact(
      backupRecord,
      backupBytes,
      options
    );
    return {
      schemaVersion: 1,
      transactionId,
      stateDirectory,
      report,
      trigger: optionsResult.data.trigger,
      recoveryArtifact,
      backup: {
        path: integrationReadinessBackupPath(stateDirectory, transactionId),
        fingerprint: fingerprintIntegrationFileBytes(backupBytes),
        transaction: backupProof
      },
      latest: latestProof,
      ...(previousProof ? { previous: previousProof } : {})
    };
  } catch (error) {
    if (
      error instanceof IntegrationFileTransactionError
      && error.code === "INTEGRATION_CONFIGURATION_UNCERTAIN"
    ) {
      let artifact: IntegrationReadinessRecoveryArtifact | undefined;
      let captureFailure: unknown;
      try {
        artifact = await captureIntegrationReadinessRecoveryArtifact(
          backupRecord,
          backupBytes,
          options
        );
      } catch (captureError) {
        captureFailure = captureError;
      }
      const cause = captureFailure === undefined ? error : new AggregateError(
        [error, captureFailure],
        "Readiness publication and recovery artifact capture both failed"
      );
      throw mapFileError(cause, "Readiness publication", {
        ...(artifact ? { artifact } : {}),
        transactionId
      });
    }
    let artifact: IntegrationReadinessRecoveryArtifact | undefined;
    try {
      artifact = await captureIntegrationReadinessRecoveryArtifact(
        backupRecord,
        backupBytes,
        options
      );
      await restoreIntegrationReadinessFromArtifactClaimed(artifact, options);
    } catch (recoveryError) {
      const combined = new AggregateError(
        [error, recoveryError],
        "Readiness publication and central-backup recovery both failed"
      );
      throw readinessError(
        isIntegrationMutationUncertainty(combined)
          ? "INTEGRATION_READINESS_UNCERTAIN"
          : "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Readiness publication failed and central-backup recovery is incomplete",
        [combined],
        { ...(artifact ? { artifact } : {}), transactionId }
      );
    }
    throw mapFileError(error, "Readiness publication", {
      ...(artifact ? { artifact } : {}),
      transactionId
    });
  }
}

export async function publishIntegrationReadiness(
  input: PortfolioReport,
  options: IntegrationReadinessPublishOptions
): Promise<IntegrationReadinessTransactionHandle> {
  return withIntegrationFileMutationClaim(options.leaseContext, async () =>
    issueIntegrationReadinessTransactionHandle(await publishClaimed(input, options)));
}

export async function restoreIntegrationReadinessFromRecovery(
  authority: IntegrationReadinessRecoveryAuthority,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    useIntegrationReadinessRecoveryAuthority(
      authority,
      options.stateDirectory,
      "restore",
      options.leaseContext,
      (binding) => restoreIntegrationReadinessFromBindingClaimed(binding, options)
    ));
}

export async function finalizeIntegrationReadinessFromRecovery(
  authority: IntegrationReadinessRecoveryAuthority,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    useIntegrationReadinessRecoveryAuthority(
      authority,
      options.stateDirectory,
      "finalize",
      options.leaseContext,
      (binding, assertCurrentLifecycleRecord) => finalizeIntegrationReadinessFromBindingClaimed(
        binding,
        options,
        (report) => appendIntegrationReportHistoryClaimed(
          binding.stateDirectory,
          report,
          options
        ),
        assertCurrentLifecycleRecord
      )
    ));
}

async function restoreClaimed(
  handle: IntegrationReadinessTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const proof = resolvePublishedIntegrationReadinessTransactionHandle(handle);
  if (resolve(options.stateDirectory) !== proof.stateDirectory) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness proof belongs to another state directory",
      []
    );
  }
  await restoreIntegrationReadinessFromArtifactClaimed(proof.recoveryArtifact, options);
  completeIntegrationReadinessTransaction(handle, "restored");
}

export async function restoreIntegrationReadiness(
  proof: IntegrationReadinessTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    restoreClaimed(proof, options));
}

async function finalizeClaimed(
  handle: IntegrationReadinessTransactionHandle,
  commitReceipt: IntegrationRecordCommitReceipt,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessFinalizeResult> {
  const initialAuthority = inspectIntegrationReadinessTransaction(handle);
  const proof = initialAuthority.proof;
  const firstFinalizeAttempt = initialAuthority.status === "published";
  if (resolve(options.stateDirectory) !== proof.stateDirectory) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness proof belongs to another state directory",
      []
    );
  }
  const committed = resolveIntegrationRecordCommitReceipt(commitReceipt);
  if (
    !committed
    || committed.stateDirectory !== proof.stateDirectory
    || committed.record.schemaVersion !== 2
    || committed.record.id !== proof.transactionId
    || committed.record.harness !== proof.trigger.harness
    || committed.record.trigger.planId !== proof.trigger.planId
    || committed.record.trigger.harness !== proof.trigger.harness
    || committed.record.trigger.createdAt !== proof.trigger.createdAt
  ) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness finalize requires the exact committed v2 lifecycle record",
      []
    );
  }
  assertIntegrationReadinessCommitPair(handle, commitReceipt as object);
  if (!claimIntegrationRecordCommitReceipt(commitReceipt, handle as object)) {
    throw readinessError(
      "INTEGRATION_READINESS_INVALID",
      "The committed lifecycle receipt is already paired with another readiness transaction",
      []
    );
  }
  const authority = commitIntegrationReadinessTransaction(handle, commitReceipt as object);
  if (authority.status === "finalized") {
    if (authority.finalResult === undefined) {
      throw readinessError(
        "INTEGRATION_READINESS_INVALID",
        "Finalized readiness authority is missing its cached result",
        []
      );
    }
    return immutableFinalizedResult();
  }
  try {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, proof.stateDirectory);
  } catch (error) {
    return committedWarning(
      "INTEGRATION_READINESS_FINALIZE_UNCERTAIN",
      "Integration committed but readiness finalize lease ownership is uncertain",
      error
    );
  }
  try {
    await verifyIntegrationReadinessRecoveryTarget(
      join(proof.stateDirectory, LATEST_REPORT),
      proof.recoveryArtifact.latest,
      proof.recoveryArtifact
    );
    await verifyIntegrationReadinessRecoveryTarget(
      join(proof.stateDirectory, PREVIOUS_REPORT),
      proof.recoveryArtifact.previous,
      proof.recoveryArtifact
    );
    await verifyIntegrationFileTransactionTargetClaimed(proof.latest, options);
    if (proof.previous) {
      await verifyIntegrationFileTransactionTargetClaimed(proof.previous, options);
    }
    if (firstFinalizeAttempt) {
      await verifyIntegrationFileTransactionTargetClaimed(proof.backup.transaction, options);
    }
  } catch (error) {
    return committedWarning(
      isIntegrationMutationUncertainty(error)
        ? "INTEGRATION_READINESS_FINALIZE_UNCERTAIN"
        : "INTEGRATION_READINESS_STATE_DRIFT",
      "Integration committed but readiness state integrity is unproven",
      error
    );
  }
  try {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, proof.stateDirectory);
  } catch (error) {
    return committedWarning(
      "INTEGRATION_READINESS_FINALIZE_UNCERTAIN",
      "Integration committed but readiness history lease ownership is uncertain",
      error
    );
  }
  try {
    await appendIntegrationReportHistoryClaimed(proof.stateDirectory, proof.report, options);
  } catch (error) {
    return committedWarning(
      isIntegrationMutationUncertainty(error)
        ? "INTEGRATION_READINESS_FINALIZE_UNCERTAIN"
        : "INTEGRATION_READINESS_HISTORY_PENDING",
      "Integration committed but readiness history could not be appended",
      error
    );
  }

  const cleanupErrors: unknown[] = [];
  for (const transaction of [proof.previous, proof.latest].filter(
    (value): value is IntegrationFileTransactionHandle => value !== undefined
  )) {
    if (integrationFileTransactionStatus(transaction) === "finalized") continue;
    try {
      await finalizeIntegrationFileTransactionClaimed(transaction, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    try {
      await cleanupIntegrationReadinessBackupClaimed(proof.recoveryArtifact, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    return {
      status: "committed-warning",
      warnings: [{
        code: "INTEGRATION_READINESS_CLEANUP_PENDING",
        message: "Integration committed but readiness artifact cleanup is pending",
        cause: cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Readiness cleanup failures")
      }]
    };
  }
  finalizeIntegrationReadinessTransaction(handle, immutableFinalizedResult());
  return immutableFinalizedResult();
}

export async function finalizeIntegrationReadiness(
  proof: IntegrationReadinessTransactionHandle,
  commitReceipt: IntegrationRecordCommitReceipt,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessFinalizeResult> {
  return withIntegrationFileMutationClaim(options.leaseContext, () =>
    finalizeClaimed(proof, commitReceipt, options));
}

export async function readIntegrationReadinessBackup(
  handle: IntegrationReadinessTransactionHandle,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessBackup> {
  const proof = resolveIntegrationReadinessTransactionHandle(handle);
  let bytes: Uint8Array;
  try {
    const verified = await withIntegrationFileMutationClaim(options.leaseContext, () =>
      verifyIntegrationFileTransactionTargetClaimed(
        proof.backup.transaction,
        options
      ));
    bytes = verified.bytes;
  } catch (error) {
    throw readinessError(
      isIntegrationMutationUncertainty(error)
        ? "INTEGRATION_READINESS_UNCERTAIN"
        : "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup is unavailable",
      [error]
    );
  }
  if (bytes.byteLength > MAX_BACKUP_BYTES || fingerprintIntegrationFileBytes(bytes) !== proof.backup.fingerprint) {
    throw readinessError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup no longer matches its recovery proof",
      []
    );
  }
  try {
    return integrationReadinessBackupSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ));
  } catch (error) {
    throw readinessError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup is invalid",
      [error]
    );
  }
}
