import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import {
  bindIntegrationRecordV2,
  appendIntegrationRecoveryTransition,
  claimReviewedPlan,
  loadIntegrationFileRecoveryAuthority,
  loadIntegrationReadinessRecoveryAuthority,
  loadIntegrationRecoveryArtifactAuthority,
  finalizeIntegrationFileFromRecovery,
  finalizeIntegrationReadinessFromRecovery,
  readIntegrationRecordJournal,
  readIntegrationRecoveryInspection,
  restoreIntegrationFileFromRecovery,
  restoreIntegrationReadinessFromRecovery,
  writeReviewedPlan,
  withIntegrationMutationLease,
  type IntegrationMutationLeaseContext,
  type IntegrationRecordJournal,
  type IntegrationRecoveryInspection,
  type IntegrationRecoveryState
} from "@skill-steward/store";
import {
  cleanupOwnedTree,
  moveOwnedTree,
  ownedTreeSiblingPath,
  resumeOwnedTreeRecoveryArtifact,
  resumeOwnedTreeCleanup,
  restoreOwnedTreeUpgrade
} from "./companion-owned-tree.js";

interface IntegrationRecoveryStatusDependencies {
  readInspection: typeof readIntegrationRecoveryInspection;
  readJournal: typeof readIntegrationRecordJournal;
}

const statusDependencies: IntegrationRecoveryStatusDependencies = {
  readInspection: readIntegrationRecoveryInspection,
  readJournal: readIntegrationRecordJournal
};

interface IntegrationRecoveryPlanDependencies extends IntegrationRecoveryStatusDependencies {
  writePlan: typeof writeReviewedPlan;
}

const planDependencies: IntegrationRecoveryPlanDependencies = {
  ...statusDependencies,
  writePlan: writeReviewedPlan
};

export interface IntegrationRecoveryPlanOptions {
  stateDirectory: string;
  now?: () => Date;
  id?: () => string;
  platform?: NodeJS.Platform;
}

const recoveryTransactionSummarySchema = z.object({
  transactionId: z.string().uuid(),
  harness: z.enum(["codex", "claude-code", "github-copilot"]),
  action: z.enum(["create", "upgrade", "none", "disconnect"]),
  phase: z.enum([
    "prepared",
    "mutating",
    "recovery-required",
    "rolled-back",
    "committed",
    "cleanup-pending",
    "closed"
  ]),
  sequence: z.number().int().min(0).max(999_999)
}).strict();

const recoveryAvailabilitySchema = z.object({
  state: z.enum(["available", "unavailable"]),
  available: z.boolean(),
  reason: z.enum(["INTEGRATION_PLATFORM_UNSUPPORTED"]).nullable()
}).strict().superRefine((availability, context) => {
  if (
    (availability.state === "available") !== availability.available
    || (availability.available ? availability.reason !== null : availability.reason === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery availability fields are contradictory"
    });
  }
});

export const integrationRecoveryPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  action: z.enum(["rollback", "finalize"]),
  recoveryState: z.enum(["rollback-required", "finalize-required"]),
  availability: recoveryAvailabilitySchema,
  transaction: recoveryTransactionSummarySchema,
  evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  artifacts: z.object({
    configuration: z.boolean(),
    readiness: z.boolean(),
    companionRoles: z.array(z.enum(["stage", "backup", "cleanup", "installed"]))
      .max(4)
      .refine((roles) => JSON.stringify(roles) === JSON.stringify([...new Set(roles)].sort()), {
        message: "Recovery companion roles must be unique and sorted"
      })
  }).strict(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().superRefine((plan, context) => {
  if (
    (plan.action === "rollback") !== (plan.recoveryState === "rollback-required")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action"],
      message: "Recovery action must match the classified recovery state"
    });
  }
  if (Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Recovery plan must expire after creation"
    });
  }
});

export type IntegrationRecoveryPlan = z.infer<typeof integrationRecoveryPlanSchema>;

export const integrationRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  action: z.enum(["rollback", "finalize"]),
  outcome: z.enum(["recovered", "recovery-required"]),
  finalState: z.enum(["closed", "recovery-required", "cleanup-pending"]),
  reasonCode: z.string().min(1).max(128),
  nextSafeAction: z.enum(["create-new-plan", "review-recovery"])
}).strict();

export type IntegrationRecoveryReceipt = z.infer<typeof integrationRecoveryReceiptSchema>;

export interface IntegrationRecoveryApplyOptions {
  home: string;
  stateDirectory: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

interface IntegrationRecoveryApplyDependencies extends IntegrationRecoveryPlanDependencies {
  claimPlan: typeof claimReviewedPlan;
  appendRecovery: typeof appendIntegrationRecoveryTransition;
  withLease: typeof withIntegrationMutationLease;
  loadFileAuthority: typeof loadIntegrationFileRecoveryAuthority;
  restoreFile: typeof restoreIntegrationFileFromRecovery;
  finalizeFile: typeof finalizeIntegrationFileFromRecovery;
  loadReadinessAuthority: typeof loadIntegrationReadinessRecoveryAuthority;
  restoreReadiness: typeof restoreIntegrationReadinessFromRecovery;
  finalizeReadiness: typeof finalizeIntegrationReadinessFromRecovery;
  loadTreeAuthority: typeof loadIntegrationRecoveryArtifactAuthority;
  resumeCleanup: typeof resumeOwnedTreeCleanup;
  resumeArtifact: typeof resumeOwnedTreeRecoveryArtifact;
  moveTree: typeof moveOwnedTree;
  cleanupTree: typeof cleanupOwnedTree;
  restoreUpgrade: typeof restoreOwnedTreeUpgrade;
}

const applyDependencies: IntegrationRecoveryApplyDependencies = {
  ...planDependencies,
  claimPlan: claimReviewedPlan,
  appendRecovery: appendIntegrationRecoveryTransition,
  withLease: withIntegrationMutationLease,
  loadFileAuthority: loadIntegrationFileRecoveryAuthority,
  restoreFile: restoreIntegrationFileFromRecovery,
  finalizeFile: finalizeIntegrationFileFromRecovery,
  loadReadinessAuthority: loadIntegrationReadinessRecoveryAuthority,
  restoreReadiness: restoreIntegrationReadinessFromRecovery,
  finalizeReadiness: finalizeIntegrationReadinessFromRecovery,
  loadTreeAuthority: loadIntegrationRecoveryArtifactAuthority,
  resumeCleanup: resumeOwnedTreeCleanup,
  resumeArtifact: resumeOwnedTreeRecoveryArtifact,
  moveTree: moveOwnedTree,
  cleanupTree: cleanupOwnedTree,
  restoreUpgrade: restoreOwnedTreeUpgrade
};

export type IntegrationRecoveryDirection = "rollback" | "finalize";

interface IntegrationRecoveryTransactionSummary {
  transactionId: string;
  harness: IntegrationRecoveryState["harness"];
  action: IntegrationRecoveryState["action"];
  phase: IntegrationRecoveryState["state"];
  sequence: number;
}

export type IntegrationRecoveryStatus =
  | {
      state: "clear";
      reasonCode: "INTEGRATION_RECOVERY_CLEAR";
      recoverable: false;
    }
  | {
      state: "rollback-required" | "finalize-required";
      reasonCode: "INTEGRATION_RECOVERY_ROLLBACK_REQUIRED" | "INTEGRATION_RECOVERY_FINALIZE_REQUIRED";
      recoverable: true;
      direction: IntegrationRecoveryDirection;
      transaction: IntegrationRecoveryTransactionSummary;
    }
  | {
      state: "unknown";
      reasonCode: "INTEGRATION_RECOVERY_UNAVAILABLE" | "INTEGRATION_RECOVERY_RECORD_CONTRADICTORY";
      recoverable: false;
      transaction?: IntegrationRecoveryTransactionSummary;
    };

function transactionSummary(
  transaction: IntegrationRecoveryState
): IntegrationRecoveryTransactionSummary {
  return {
    transactionId: transaction.transactionId,
    harness: transaction.harness,
    action: transaction.action,
    phase: transaction.state,
    sequence: transaction.sequence
  };
}

function unknown(
  reasonCode: Extract<IntegrationRecoveryStatus, { state: "unknown" }>["reasonCode"],
  transaction?: IntegrationRecoveryState
): IntegrationRecoveryStatus {
  return {
    state: "unknown",
    reasonCode,
    recoverable: false,
    ...(transaction ? { transaction: transactionSummary(transaction) } : {})
  };
}

function actionable(
  direction: IntegrationRecoveryDirection,
  transaction: IntegrationRecoveryState
): IntegrationRecoveryStatus {
  return direction === "rollback"
    ? {
        state: "rollback-required",
        reasonCode: "INTEGRATION_RECOVERY_ROLLBACK_REQUIRED",
        recoverable: true,
        direction,
        transaction: transactionSummary(transaction)
      }
    : {
        state: "finalize-required",
        reasonCode: "INTEGRATION_RECOVERY_FINALIZE_REQUIRED",
        recoverable: true,
        direction,
        transaction: transactionSummary(transaction)
      };
}

/** Package-private evidence classifier. Edge surfaces must consume its common result. */
export function classifyIntegrationRecoveryEvidence(
  inspection: IntegrationRecoveryInspection,
  journal: IntegrationRecordJournal
): IntegrationRecoveryStatus {
  if (inspection.status === "clear") {
    return {
      state: "clear",
      reasonCode: "INTEGRATION_RECOVERY_CLEAR",
      recoverable: false
    };
  }
  if (inspection.status === "unavailable") {
    return unknown("INTEGRATION_RECOVERY_UNAVAILABLE");
  }

  const transaction = inspection.transaction;
  if (journal.changedDuringRead) {
    return unknown("INTEGRATION_RECOVERY_UNAVAILABLE", transaction);
  }
  const planRecords = journal.orderedRecords.filter((candidate) =>
    candidate.schemaVersion === 2 && candidate.trigger.planId === transaction.planId
  );

  if (transaction.state === "prepared") {
    return planRecords.length === 0
      ? actionable("rollback", transaction)
      : unknown("INTEGRATION_RECOVERY_RECORD_CONTRADICTORY", transaction);
  }

  const binding = transaction.lifecycleRecordBinding;
  if (binding === undefined) {
    return unknown("INTEGRATION_RECOVERY_RECORD_CONTRADICTORY", transaction);
  }
  const head = journal.orderedRecords[0];
  const exactCurrent = head?.schemaVersion === 2
    && bindIntegrationRecordV2(head).digest === binding.digest;
  if (exactCurrent) return actionable("finalize", transaction);

  if (planRecords.length > 0) {
    return unknown("INTEGRATION_RECOVERY_RECORD_CONTRADICTORY", transaction);
  }
  if (transaction.state === "committed" || transaction.state === "cleanup-pending") {
    return unknown("INTEGRATION_RECOVERY_RECORD_CONTRADICTORY", transaction);
  }
  if (transaction.state === "mutating" || transaction.state === "recovery-required") {
    return actionable("rollback", transaction);
  }
  return unknown("INTEGRATION_RECOVERY_RECORD_CONTRADICTORY", transaction);
}

/** Package-private read coordinator used by the high-level lifecycle API. */
export async function inspectIntegrationRecoveryStatus(
  stateDirectory: string,
  dependencyOverrides: Partial<IntegrationRecoveryStatusDependencies> = {}
): Promise<IntegrationRecoveryStatus> {
  const dependencies = { ...statusDependencies, ...dependencyOverrides };
  const inspection = await dependencies.readInspection(stateDirectory);
  if (inspection.status !== "unresolved") {
    return classifyIntegrationRecoveryEvidence(inspection, {
      changedDuringRead: false,
      records: [],
      orderedRecords: []
    });
  }
  try {
    return classifyIntegrationRecoveryEvidence(
      inspection,
      await dependencies.readJournal(stateDirectory)
    );
  } catch {
    return unknown("INTEGRATION_RECOVERY_UNAVAILABLE", inspection.transaction);
  }
}

function recoveryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function evidenceDigest(transaction: IntegrationRecoveryState): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(transaction))
    .digest("hex")}`;
}

export async function planIntegrationRecovery(
  options: IntegrationRecoveryPlanOptions,
  dependencyOverrides: Partial<IntegrationRecoveryPlanDependencies> = {}
): Promise<IntegrationRecoveryPlan> {
  const dependencies = { ...planDependencies, ...dependencyOverrides };
  const inspection = await dependencies.readInspection(options.stateDirectory);
  let status: IntegrationRecoveryStatus;
  if (inspection.status === "unresolved") {
    try {
      status = classifyIntegrationRecoveryEvidence(
        inspection,
        await dependencies.readJournal(options.stateDirectory)
      );
    } catch {
      status = unknown("INTEGRATION_RECOVERY_UNAVAILABLE", inspection.transaction);
    }
  } else {
    status = classifyIntegrationRecoveryEvidence(inspection, {
      changedDuringRead: false,
      records: [],
      orderedRecords: []
    });
  }
  if (!status.recoverable || inspection.status !== "unresolved") {
    const code = status.state === "clear"
      ? "INTEGRATION_RECOVERY_NOT_REQUIRED"
      : status.reasonCode;
    throw recoveryError(code, status.state === "clear"
      ? "No integration recovery is required"
      : "Integration recovery evidence is unavailable");
  }

  const now = options.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000).toISOString();
  const platform = options.platform ?? process.platform;
  const transaction = inspection.transaction;
  const plan = integrationRecoveryPlanSchema.parse({
    schemaVersion: 1,
    planId: options.id?.() ?? randomUUID(),
    action: status.direction,
    recoveryState: status.state,
    availability: platform === "win32"
      ? {
          state: "unavailable",
          available: false,
          reason: "INTEGRATION_PLATFORM_UNSUPPORTED"
        }
      : { state: "available", available: true, reason: null },
    transaction: transactionSummary(transaction),
    evidenceDigest: evidenceDigest(transaction),
    artifacts: {
      configuration: transaction.configurationArtifact !== undefined,
      readiness: transaction.readinessArtifact !== undefined,
      companionRoles: transaction.artifactProofs.map(({ role }) => role).sort()
    },
    createdAt,
    expiresAt
  });
  await dependencies.writePlan(options.stateDirectory, {
    schemaVersion: 1,
    id: plan.planId,
    kind: "integration-recovery",
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    payload: plan
  });
  return plan;
}

async function appendTerminalRecovery(
  stateDirectory: string,
  current: IntegrationRecoveryState,
  state: "rolled-back" | "committed" | "cleanup-pending" | "closed",
  transitionedAt: string,
  leaseContext: IntegrationMutationLeaseContext,
  dependencies: IntegrationRecoveryApplyDependencies,
  completedStepAdditions: Array<
    "readiness-finalized" | "configuration-finalized" | "companion-finalized"
  > = []
): Promise<IntegrationRecoveryState> {
  return dependencies.appendRecovery(stateDirectory, {
    transactionId: current.transactionId,
    expectedSequence: current.sequence,
    expectedState: current.state,
    state,
    transitionedAt,
    ...(completedStepAdditions.length > 0 ? { completedStepAdditions } : {})
  }, { leaseContext });
}

function isCleanupArtifactPath(
  transaction: IntegrationRecoveryState,
  path: string
): boolean {
  return path === ownedTreeSiblingPath(dirname(path), transaction.transactionId, "cleanup");
}

async function reopenTreeForCleanup(
  transaction: IntegrationRecoveryState,
  proof: IntegrationRecoveryState["artifactProofs"][number],
  options: IntegrationRecoveryApplyOptions,
  leaseContext: IntegrationMutationLeaseContext,
  dependencies: IntegrationRecoveryApplyDependencies
) {
  const authority = await dependencies.loadTreeAuthority(
    options.stateDirectory,
    { transactionId: transaction.transactionId, role: proof.role },
    { leaseContext }
  );
  const mutationOptions = { stateDirectory: options.stateDirectory, leaseContext };
  if (proof.role === "cleanup" || isCleanupArtifactPath(transaction, proof.path)) {
    if (proof.role !== "cleanup" && proof.role !== "stage" && proof.role !== "backup") {
      throw recoveryError(
        "INTEGRATION_RECOVERY_INCOMPLETE",
        "Persisted cleanup authority has an invalid companion role"
      );
    }
    return dependencies.resumeCleanup({
      transactionId: transaction.transactionId,
      homeBoundaryPath: options.home,
      role: proof.role,
      artifactAuthority: authority
    }, mutationOptions);
  }
  if (proof.role !== "stage" && proof.role !== "backup" && proof.role !== "installed") {
    throw recoveryError(
      "INTEGRATION_RECOVERY_INCOMPLETE",
      "Persisted companion authority cannot be reopened for cleanup"
    );
  }
  return dependencies.resumeArtifact({
    transactionId: transaction.transactionId,
    homeBoundaryPath: options.home,
    role: proof.role,
    expectedPath: proof.path,
    artifactAuthority: authority
  }, mutationOptions);
}

async function finalizeRecoverableTransaction(
  initial: IntegrationRecoveryState,
  options: IntegrationRecoveryApplyOptions,
  leaseContext: IntegrationMutationLeaseContext,
  dependencies: IntegrationRecoveryApplyDependencies
): Promise<IntegrationRecoveryState> {
  let transaction = initial;
  const transitionedAt = (options.now?.() ?? new Date()).toISOString();
  if (transaction.state === "mutating" || transaction.state === "recovery-required") {
    transaction = await appendTerminalRecovery(
      options.stateDirectory,
      transaction,
      "committed",
      transitionedAt,
      leaseContext,
      dependencies
    );
  }
  const mutationOptions = {
    stateDirectory: options.stateDirectory,
    leaseContext
  };
  if (
    transaction.readinessArtifact !== undefined
    && !transaction.completedSteps.includes("readiness-finalized")
  ) {
    const authority = await dependencies.loadReadinessAuthority(
      options.stateDirectory,
      { transactionId: transaction.transactionId, operation: "finalize" },
      { leaseContext }
    );
    await dependencies.finalizeReadiness(authority, mutationOptions);
    transaction = await appendTerminalRecovery(
      options.stateDirectory,
      transaction,
      transaction.state as "committed" | "cleanup-pending",
      transitionedAt,
      leaseContext,
      dependencies,
      ["readiness-finalized"]
    );
  }
  if (
    transaction.configurationArtifact !== undefined
    && !transaction.completedSteps.includes("configuration-finalized")
  ) {
    const authority = await dependencies.loadFileAuthority(
      options.stateDirectory,
      { transactionId: transaction.transactionId, operation: "finalize" },
      { leaseContext }
    );
    await dependencies.finalizeFile(authority, mutationOptions);
    transaction = await appendTerminalRecovery(
      options.stateDirectory,
      transaction,
      transaction.state as "committed" | "cleanup-pending",
      transitionedAt,
      leaseContext,
      dependencies,
      ["configuration-finalized"]
    );
  }
  if (
    transaction.action === "disconnect"
    && transaction.afterFingerprint === null
    && transaction.artifactProofs.some(({ role }) => role === "cleanup" || role === "backup")
    && !transaction.completedSteps.includes("companion-finalized")
  ) {
    const proof = transaction.artifactProofs.find(({ role }) => role === "cleanup")
      ?? transaction.artifactProofs.find(({ role }) => role === "backup")!;
    const cleanup = await reopenTreeForCleanup(
      transaction,
      proof,
      options,
      leaseContext,
      dependencies
    );
    const receipt = await dependencies.cleanupTree(cleanup, mutationOptions);
    if (receipt.state !== "cleaned") {
      throw recoveryError(
        "INTEGRATION_RECOVERY_INCOMPLETE",
        "Committed final-uninstall cleanup remains incomplete"
      );
    }
    transaction = await appendTerminalRecovery(
      options.stateDirectory,
      transaction,
      transaction.state as "committed" | "cleanup-pending",
      transitionedAt,
      leaseContext,
      dependencies,
      ["companion-finalized"]
    );
  }
  if (
    transaction.action === "upgrade"
    && !transaction.completedSteps.includes("companion-finalized")
  ) {
    const cleanupProof = transaction.artifactProofs.find(({ role }) => role === "cleanup");
    const backupProof = transaction.artifactProofs.find(({ role }) => role === "backup");
    const proof = cleanupProof ?? backupProof;
    if (!proof) {
      throw recoveryError(
        "INTEGRATION_RECOVERY_INCOMPLETE",
        "Committed upgrade recovery has no exact backup authority"
      );
    }
    const backup = await reopenTreeForCleanup(
      transaction,
      proof,
      options,
      leaseContext,
      dependencies
    );
    const receipt = await dependencies.cleanupTree(backup, mutationOptions);
    if (receipt.state !== "cleaned") {
      throw recoveryError(
        "INTEGRATION_RECOVERY_INCOMPLETE",
        "Committed upgrade backup cleanup remains incomplete"
      );
    }
    transaction = await appendTerminalRecovery(
      options.stateDirectory,
      transaction,
      transaction.state as "committed" | "cleanup-pending",
      transitionedAt,
      leaseContext,
      dependencies,
      ["companion-finalized"]
    );
  }
  return transaction;
}

async function rollbackRecoverableTransaction(
  transaction: IntegrationRecoveryState,
  options: IntegrationRecoveryApplyOptions,
  leaseContext: IntegrationMutationLeaseContext,
  dependencies: IntegrationRecoveryApplyDependencies
): Promise<void> {
  const mutationOptions = {
    stateDirectory: options.stateDirectory,
    leaseContext
  };
  if (transaction.readinessArtifact !== undefined) {
    const authority = await dependencies.loadReadinessAuthority(
      options.stateDirectory,
      { transactionId: transaction.transactionId, operation: "restore" },
      { leaseContext }
    );
    await dependencies.restoreReadiness(authority, mutationOptions);
  }
  if (transaction.action === "create" && transaction.state !== "prepared") {
    const role = transaction.artifactProofs.some((proof) => proof.role === "installed")
      ? "installed" as const
      : transaction.artifactProofs.some((proof) => proof.role === "stage")
        ? "stage" as const
        : undefined;
    if (role) {
      const proof = transaction.artifactProofs.find((candidate) => candidate.role === role)!;
      const authority = await dependencies.loadTreeAuthority(
        options.stateDirectory,
        { transactionId: transaction.transactionId, role },
        { leaseContext }
      );
      const tree = await dependencies.resumeArtifact({
        transactionId: transaction.transactionId,
        homeBoundaryPath: options.home,
        role,
        expectedPath: proof.path,
        artifactAuthority: authority
      }, mutationOptions);
      const cleanup = await dependencies.cleanupTree(tree, mutationOptions);
      if (cleanup.state !== "cleaned") {
        throw recoveryError(
          "INTEGRATION_RECOVERY_INCOMPLETE",
          "Created companion rollback cleanup remains incomplete"
        );
      }
    }
  }
  if (transaction.action === "upgrade" && transaction.state !== "prepared") {
    const installedProof = transaction.artifactProofs.find(({ role }) => role === "installed");
    const backupProof = transaction.artifactProofs.find(({ role }) => role === "backup");
    const stageProof = transaction.artifactProofs.find(({ role }) => role === "stage");
    if (installedProof && backupProof) {
      const [installedAuthority, backupAuthority] = await Promise.all([
        dependencies.loadTreeAuthority(
          options.stateDirectory,
          { transactionId: transaction.transactionId, role: "installed" },
          { leaseContext }
        ),
        dependencies.loadTreeAuthority(
          options.stateDirectory,
          { transactionId: transaction.transactionId, role: "backup" },
          { leaseContext }
        )
      ]);
      const installed = await dependencies.resumeArtifact({
        transactionId: transaction.transactionId,
        homeBoundaryPath: options.home,
        role: "installed",
        expectedPath: installedProof.path,
        artifactAuthority: installedAuthority
      }, mutationOptions);
      const backup = await dependencies.resumeArtifact({
        transactionId: transaction.transactionId,
        homeBoundaryPath: options.home,
        role: "backup",
        expectedPath: backupProof.path,
        artifactAuthority: backupAuthority
      }, mutationOptions);
      const restored = await dependencies.restoreUpgrade(installed, backup, mutationOptions);
      if (restored.state !== "restored") {
        throw recoveryError(
          "INTEGRATION_RECOVERY_INCOMPLETE",
          "Previous companion was restored but replacement cleanup remains incomplete"
        );
      }
    } else {
      if (stageProof) {
        const authority = await dependencies.loadTreeAuthority(
          options.stateDirectory,
          { transactionId: transaction.transactionId, role: "stage" },
          { leaseContext }
        );
        const stage = await dependencies.resumeArtifact({
          transactionId: transaction.transactionId,
          homeBoundaryPath: options.home,
          role: "stage",
          expectedPath: stageProof.path,
          artifactAuthority: authority
        }, mutationOptions);
        const cleanup = await dependencies.cleanupTree(stage, mutationOptions);
        if (cleanup.state !== "cleaned") {
          throw recoveryError(
            "INTEGRATION_RECOVERY_INCOMPLETE",
            "Staged upgrade cleanup remains incomplete"
          );
        }
      }
      if (backupProof) {
        const authority = await dependencies.loadTreeAuthority(
          options.stateDirectory,
          { transactionId: transaction.transactionId, role: "backup" },
          { leaseContext }
        );
        const backup = await dependencies.resumeArtifact({
          transactionId: transaction.transactionId,
          homeBoundaryPath: options.home,
          role: "backup",
          expectedPath: backupProof.path,
          artifactAuthority: authority
        }, mutationOptions);
        const restored = await dependencies.moveTree(
          backup,
          transaction.companionPath,
          mutationOptions
        );
        if (restored.state !== "moved") {
          throw recoveryError(
            "INTEGRATION_RECOVERY_INCOMPLETE",
            "Previous companion upgrade tree could not be restored"
          );
        }
      }
    }
  }
  if (
    transaction.action === "disconnect"
    && transaction.afterFingerprint === null
    && transaction.artifactProofs.some(({ role }) => role === "cleanup" || role === "backup")
  ) {
    const proof = transaction.artifactProofs.find(({ role }) => role === "cleanup")
      ?? transaction.artifactProofs.find(({ role }) => role === "backup")!;
    const cleanup = await reopenTreeForCleanup(
      transaction,
      proof,
      options,
      leaseContext,
      dependencies
    );
    const restored = await dependencies.moveTree(
      cleanup,
      transaction.companionPath,
      mutationOptions
    );
    if (restored.state !== "moved") {
      throw recoveryError(
        "INTEGRATION_RECOVERY_INCOMPLETE",
        "The exact final-uninstall companion could not be restored"
      );
    }
  }
  if (transaction.configurationArtifact !== undefined) {
    const authority = await dependencies.loadFileAuthority(
      options.stateDirectory,
      { transactionId: transaction.transactionId, operation: "restore" },
      { leaseContext }
    );
    await dependencies.restoreFile(authority, mutationOptions);
  }
}

export async function applyIntegrationRecoveryPlan(
  planId: string,
  options: IntegrationRecoveryApplyOptions,
  dependencyOverrides: Partial<IntegrationRecoveryApplyDependencies> = {}
): Promise<IntegrationRecoveryReceipt> {
  const dependencies = { ...applyDependencies, ...dependencyOverrides };
  return dependencies.withLease(options.stateDirectory, async (leaseContext) => {
    const envelope = await dependencies.claimPlan(options.stateDirectory, {
      id: planId,
      kind: "integration-recovery",
      now: options.now?.() ?? new Date()
    });
    const plan = integrationRecoveryPlanSchema.parse(envelope.payload);
    if (!plan.availability.available || (options.platform ?? process.platform) === "win32") {
      throw recoveryError(
        "INTEGRATION_PLATFORM_UNSUPPORTED",
        "Integration recovery mutation is unavailable on this platform"
      );
    }
    const inspection = await dependencies.readInspection(options.stateDirectory);
    if (inspection.status !== "unresolved") {
      throw recoveryError(
        "INTEGRATION_RECOVERY_PLAN_STALE",
        "Integration recovery state changed after review"
      );
    }
    let status: IntegrationRecoveryStatus;
    try {
      status = classifyIntegrationRecoveryEvidence(
        inspection,
        await dependencies.readJournal(options.stateDirectory)
      );
    } catch {
      throw recoveryError(
        "INTEGRATION_RECOVERY_UNAVAILABLE",
        "Integration recovery evidence could not be revalidated"
      );
    }
    const transaction = inspection.transaction;
    if (
      !status.recoverable
      || status.direction !== plan.action
      || status.state !== plan.recoveryState
      || evidenceDigest(transaction) !== plan.evidenceDigest
      || JSON.stringify(transactionSummary(transaction)) !== JSON.stringify(plan.transaction)
    ) {
      throw recoveryError(
        "INTEGRATION_RECOVERY_PLAN_STALE",
        "Integration recovery evidence changed after review"
      );
    }

    const transitionedAt = (options.now?.() ?? new Date()).toISOString();
    try {
      if (plan.action === "rollback") {
        await rollbackRecoverableTransaction(transaction, options, leaseContext, dependencies);
        const rolledBack = await appendTerminalRecovery(
          options.stateDirectory,
          transaction,
          "rolled-back",
          transitionedAt,
          leaseContext,
          dependencies
        );
        await appendTerminalRecovery(
          options.stateDirectory,
          rolledBack,
          "closed",
          transitionedAt,
          leaseContext,
          dependencies
        );
      } else {
        const committed = await finalizeRecoverableTransaction(
          transaction,
          options,
          leaseContext,
          dependencies
        );
        await appendTerminalRecovery(
          options.stateDirectory,
          committed,
          "closed",
          transitionedAt,
          leaseContext,
          dependencies
        );
      }
    } catch {
      let finalState: IntegrationRecoveryReceipt["finalState"] = "recovery-required";
      try {
        const latest = await dependencies.readInspection(options.stateDirectory);
        if (latest.status === "unresolved" && latest.transaction.state === "cleanup-pending") {
          finalState = "cleanup-pending";
        }
      } catch {
        // The receipt stays conservative when the latest state cannot be re-read.
      }
      return integrationRecoveryReceiptSchema.parse({
        schemaVersion: 1,
        transactionId: transaction.transactionId,
        planId: plan.planId,
        action: plan.action,
        outcome: "recovery-required",
        finalState,
        reasonCode: "INTEGRATION_RECOVERY_INCOMPLETE",
        nextSafeAction: "review-recovery"
      });
    }
    return integrationRecoveryReceiptSchema.parse({
      schemaVersion: 1,
      transactionId: transaction.transactionId,
      planId: plan.planId,
      action: plan.action,
      outcome: "recovered",
      finalState: "closed",
      reasonCode: plan.action === "rollback"
        ? "INTEGRATION_RECOVERY_ROLLED_BACK"
        : "INTEGRATION_RECOVERY_FINALIZED",
      nextSafeAction: "create-new-plan"
    });
  });
}
