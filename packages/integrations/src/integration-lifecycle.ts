import {
  withIntegrationMutationLease,
  writeLatestReport,
  writeReviewedPlan
} from "@skill-steward/store";
import {
  integrationApplyAvailability,
  integrationStatus as inspectIntegrationStatus,
  planIntegration as planIntegrationInternal,
  planIntegrationDisconnect as planIntegrationDisconnectInternal,
  removeIntegration as removeLegacyIntegrationInternal,
  type IntegrationApplyAvailability,
  type IntegrationConfigOptions,
  type IntegrationPlan as InternalIntegrationPlan,
  type IntegrationStatusValue
} from "./config.js";
import {
  applyReviewedCompanionIntegrationTransaction,
  CompanionTransactionError,
  disconnectCompanionIntegrationTransaction,
  type CompanionTransactionReceipt
} from "./companion-transaction.js";
import { assertCompanionPlanNativeCapability } from "./companion-native-capability.js";
import {
  integrationHarnessSchema,
  type IntegrationHarness
} from "./domain.js";
import type { CompanionSkillStatus } from "./companion-shared.js";
import {
  applyIntegrationRecoveryPlan as applyIntegrationRecoveryPlanInternal,
  inspectIntegrationRecoveryStatus,
  planIntegrationRecovery as planIntegrationRecoveryInternal,
  type IntegrationRecoveryPlan as InternalIntegrationRecoveryPlan,
  type IntegrationRecoveryReceipt as InternalIntegrationRecoveryReceipt,
  type IntegrationRecoveryStatus as InternalIntegrationRecoveryStatus
} from "./integration-recovery.js";

const strictPlanId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type IntegrationPlanAction =
  | "create"
  | "upgrade"
  | "connect"
  | "disconnect"
  | "blocked";

export type IntegrationArtifactRole = "companion-skill" | "harness-configuration";

export interface IntegrationPlanAvailability {
  state: "available" | "unavailable";
  available: boolean;
  reason: string | null;
}

export interface IntegrationPlan {
  schemaVersion: 1;
  planId: string;
  harness: IntegrationHarness;
  action: Exclude<IntegrationPlanAction, "disconnect">;
  status: CompanionSkillStatus;
  availability: IntegrationPlanAvailability;
  targets: {
    hook: string;
    companion: string;
  };
  fingerprintCategory: "new" | "recorded" | "legacy-alpha" | "conflict" | "unknown";
  artifacts: Array<{
    role: IntegrationArtifactRole;
    operation: "create" | "upgrade" | "connect";
  }>;
  createdAt: string;
  expiresAt: string;
}

export interface IntegrationDisconnectPlan {
  schemaVersion: 1;
  planId: string;
  harness: IntegrationHarness;
  action: "disconnect";
  status: "current";
  availability: IntegrationPlanAvailability;
  targets: {
    hook: string;
    companion: string;
  };
  fingerprintCategory: "recorded";
  artifacts: [{ role: "harness-configuration"; operation: "disconnect" }];
  companion: "retained" | "removed";
  companionRetained: boolean;
  lastConsumer: boolean;
  remainingConsumers: number;
  createdAt: string;
  expiresAt: string;
}

export interface IntegrationStatusAvailability {
  state: "available" | "unavailable";
  available: boolean;
  reason: string | null;
}

export interface IntegrationStatusV2 {
  schemaVersion: 2;
  harness: IntegrationHarness;
  hook: {
    status: IntegrationStatusValue;
    reason: string;
    target: string;
    availability: IntegrationStatusAvailability;
    lastChangedAt?: string;
  };
  companion: {
    status: CompanionSkillStatus;
    reason: string;
    target: string;
    proofCategory: "new" | "recorded" | "legacy-alpha" | "conflict" | "unknown";
    availability: IntegrationStatusAvailability;
    lastChangedAt?: string;
  };
  availability: IntegrationStatusAvailability;
  /** @deprecated Alpha compatibility alias for companion.status. */
  status: CompanionSkillStatus;
  /** @deprecated Alpha compatibility alias for companion.reason. */
  reason: string;
  /** @deprecated Alpha compatibility alias for hook.status. */
  hookStatus: IntegrationStatusValue;
  lastChangedAt?: string;
}

export type IntegrationStatus = IntegrationStatusV2;

export type IntegrationRecoveryStatus = InternalIntegrationRecoveryStatus;
export type IntegrationRecoveryPlan = InternalIntegrationRecoveryPlan;
export type IntegrationRecoveryReceipt = InternalIntegrationRecoveryReceipt;

export interface IntegrationRecoveryStatusOptions {
  stateDirectory: string;
}

export interface IntegrationRecoveryPlanOptions extends IntegrationRecoveryStatusOptions {
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export interface IntegrationRecoveryApplyOptions extends IntegrationRecoveryPlanOptions {
  home: string;
}

export interface IntegrationReadinessContext {
  transactionId: string;
  recordId: string;
  planId: string;
  harness: IntegrationHarness;
  action: "create" | "upgrade" | "none" | "disconnect";
}

export interface IntegrationTransactionOptions extends IntegrationConfigOptions {
  expectedHarness?: IntegrationHarness;
  generateReadiness(context: IntegrationReadinessContext): Promise<unknown>;
}

export interface IntegrationTransactionReceipt {
  transactionId: string;
  outcome: "ready" | "rolled-back" | "recovery-required";
  hook: "unchanged" | "installed" | "removed" | "restored" | "unknown";
  companion: "unchanged" | "created" | "upgraded" | "retained" | "removed" | "restored" | "unknown";
  recordId: string;
  cleanup: "clean" | "pending";
  reasonCode: string;
  nextSafeAction: "none" | "create-new-plan" | "recover-transaction";
}

const publicIntegrationErrorDefinitions = {
  INVALID_INTEGRATION_HARNESS: {
    message: "The requested integration Harness is not supported.",
    httpStatus: 400
  },
  INVALID_INTEGRATION_PLAN_REQUEST: {
    message: "The integration plan request is invalid.",
    httpStatus: 400
  },
  REVIEWED_PLAN_REQUIRED: {
    message: "A reviewed integration plan is required.",
    httpStatus: 400
  },
  REVIEWED_PLAN_CONFIRMATION_REQUIRED: {
    message: "The reviewed integration plan must be confirmed.",
    httpStatus: 400
  },
  REVIEWED_PLAN_AMBIGUOUS: {
    message: "The reviewed integration plan request is ambiguous.",
    httpStatus: 400
  },
  REVIEWED_PLAN_NOT_FOUND: {
    message: "The reviewed integration plan was not found. Create a fresh plan.",
    httpStatus: 404
  },
  REVIEWED_PLAN_EXPIRED: {
    message: "The reviewed integration plan expired. Create a fresh plan.",
    httpStatus: 409
  },
  REVIEWED_PLAN_KIND_MISMATCH: {
    message: "The reviewed plan is not an integration plan. Create a fresh plan.",
    httpStatus: 409
  },
  REVIEWED_PLAN_INVALID: {
    message: "The reviewed integration plan is invalid. Create a fresh plan.",
    httpStatus: 409
  },
  REVIEWED_PLAN_CONFLICT: {
    message: "The reviewed integration plan conflicts with another operation. Create a fresh plan.",
    httpStatus: 409
  },
  REVIEWED_PLAN_UNSAFE_STATE: {
    message: "The reviewed integration plan is in an unsafe state. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_PLAN_REQUIRED: {
    message: "A reviewed integration plan is required.",
    httpStatus: 400
  },
  INTEGRATION_PLAN_EXPIRED: {
    message: "The integration plan expired. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_PLAN_INVALID: {
    message: "The integration plan is invalid. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_PLAN_MISMATCH: {
    message: "The integration plan does not match this Harness. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_COMPANION_ACTION_UNAVAILABLE: {
    message: "The reviewed companion Skill action is unavailable.",
    httpStatus: 409
  },
  INTEGRATION_CONFIG_INVALID: {
    message: "The integration configuration is invalid.",
    httpStatus: 409
  },
  INTEGRATION_DUPLICATE: {
    message: "The integration is already configured.",
    httpStatus: 409
  },
  INTEGRATION_DRIFTED: {
    message: "The reviewed integration state changed. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_LEGACY_CLEANUP_UNAVAILABLE: {
    message: "Legacy integration cleanup is unavailable for this state.",
    httpStatus: 409
  },
  INTEGRATION_NOT_INSTALLED: {
    message: "The integration is not installed.",
    httpStatus: 409
  },
  INTEGRATION_ROLLBACK_FAILED: {
    message: "Integration rollback could not be completed. Recovery is required.",
    httpStatus: 409
  },
  INTEGRATION_UNSAFE_PATH: {
    message: "The integration target could not be verified safely.",
    httpStatus: 409
  },
  INTEGRATION_READINESS_FAILED: {
    message: "Integration readiness could not be published safely.",
    httpStatus: 409
  },
  INTEGRATION_BUSY: {
    message: "Another integration operation is in progress.",
    httpStatus: 409
  },
  SHARED_SKILL_CONFLICT: {
    message: "The shared companion Skill conflicts with the reviewed integration.",
    httpStatus: 409
  },
  COMPANION_SOURCE_INVALID: {
    message: "The packaged companion Skill source is invalid.",
    httpStatus: 409
  },
  INTEGRATION_TRANSACTION_FAILED: {
    message: "The integration transaction was rolled back. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_REQUIRED: {
    message: "Integration recovery is required before another change.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_NOT_REQUIRED: {
    message: "No integration recovery is required.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_UNAVAILABLE: {
    message: "Integration recovery evidence is unavailable. No recovery action was selected.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_RECORD_CONTRADICTORY: {
    message: "Integration recovery evidence is contradictory. No recovery action was selected.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_PLAN_STALE: {
    message: "The reviewed recovery plan is stale. Create a fresh plan.",
    httpStatus: 409
  },
  INTEGRATION_RECOVERY_INCOMPLETE: {
    message: "Integration recovery remains incomplete. Review the current recovery state.",
    httpStatus: 409
  },
  INTEGRATION_PLATFORM_UNSUPPORTED: {
    message: "Managed integration recovery is unavailable on this platform.",
    httpStatus: 409
  },
  INTEGRATION_OPERATION_FAILED: {
    message: "Integration operation could not be completed safely.",
    httpStatus: 500
  }
} as const;

export type PublicIntegrationErrorCode = keyof typeof publicIntegrationErrorDefinitions;

export interface PublicIntegrationError {
  code: PublicIntegrationErrorCode;
  message: string;
  httpStatus: 400 | 404 | 409 | 500;
  receipt?: IntegrationTransactionReceipt;
}

export interface IntegrationLegacyRemovalReceipt {
  outcome: "removed";
  harness: IntegrationHarness;
  recordId: string;
  readiness: "ready";
  companion: "retained";
}

export class IntegrationTransactionError extends Error {
  readonly code: string;
  readonly receipt: IntegrationTransactionReceipt;

  constructor(error: CompanionTransactionError) {
    super(error.message, { cause: error.cause });
    this.name = "IntegrationTransactionError";
    this.code = error.code;
    this.receipt = sanitizeReceipt(error.receipt);
  }

  toJSON(): {
    name: string;
    message: string;
    code: string;
    receipt: IntegrationTransactionReceipt;
  } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      receipt: this.receipt
    };
  }
}

function sanitizeReceipt(receipt: CompanionTransactionReceipt): IntegrationTransactionReceipt {
  return {
    transactionId: receipt.transactionId,
    outcome: receipt.outcome,
    hook: receipt.hook,
    companion: receipt.companion,
    recordId: receipt.recordId,
    cleanup: receipt.cleanup,
    reasonCode: receipt.reasonCode,
    nextSafeAction: receipt.nextSafeAction
  };
}

function errorCode(error: unknown): string | undefined {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function publicIntegrationError(
  code: PublicIntegrationErrorCode,
  receipt?: IntegrationTransactionReceipt
): PublicIntegrationError {
  const definition = publicIntegrationErrorDefinitions[code];
  return {
    code,
    message: definition.message,
    httpStatus: definition.httpStatus,
    ...(receipt ? { receipt } : {})
  };
}

export function serializePublicIntegrationError(error: unknown): PublicIntegrationError {
  if (error instanceof IntegrationTransactionError) {
    const code = Object.hasOwn(publicIntegrationErrorDefinitions, error.code)
      ? error.code as PublicIntegrationErrorCode
      : error.receipt.outcome === "recovery-required"
        ? "INTEGRATION_RECOVERY_REQUIRED"
        : "INTEGRATION_TRANSACTION_FAILED";
    return publicIntegrationError(code, {
      ...error.receipt,
      reasonCode: code
    });
  }

  const code = errorCode(error);
  if (code && Object.hasOwn(publicIntegrationErrorDefinitions, code)) {
    return publicIntegrationError(code as PublicIntegrationErrorCode);
  }
  return publicIntegrationError("INTEGRATION_OPERATION_FAILED");
}

export async function integrationRecoveryStatus(
  options: IntegrationRecoveryStatusOptions
): Promise<IntegrationRecoveryStatus> {
  return inspectIntegrationRecoveryStatus(options.stateDirectory);
}

export async function planIntegrationRecovery(
  options: IntegrationRecoveryPlanOptions
): Promise<IntegrationRecoveryPlan> {
  return planIntegrationRecoveryInternal(options);
}

export async function applyIntegrationRecoveryPlan(
  planId: string,
  options: IntegrationRecoveryApplyOptions
): Promise<IntegrationRecoveryReceipt> {
  assertPlanId(planId);
  return applyIntegrationRecoveryPlanInternal(planId, options);
}

function companionStatus(plan: InternalIntegrationPlan): CompanionSkillStatus {
  if (plan.companion.action === "create") return "missing";
  if (plan.companion.action === "upgrade") return "upgrade-available";
  if (plan.companion.action === "none") return "current";
  return plan.companion.proof.kind === "unknown" ? "unknown" : "conflict";
}

function planAction(plan: InternalIntegrationPlan): IntegrationPlan["action"] {
  if (plan.companion.action === "none") return "connect";
  if (plan.companion.action === "conflict") return "blocked";
  return plan.companion.action;
}

async function publicAvailability(
  plan: InternalIntegrationPlan,
  availability: IntegrationApplyAvailability
): Promise<IntegrationPlanAvailability> {
  if (availability.applyAvailable) {
    try {
      await assertCompanionPlanNativeCapability(plan);
    } catch {
      return {
        state: "unavailable",
        available: false,
        reason: "INTEGRATION_NATIVE_CAPABILITY_UNAVAILABLE"
      };
    }
  }
  return availability.applyAvailable
    ? { state: "available", available: true, reason: null }
    : {
        state: "unavailable",
        available: false,
        reason: availability.unavailableReason
      };
}

async function sanitizePlan(plan: InternalIntegrationPlan): Promise<IntegrationPlan> {
  const action = planAction(plan);
  const availability = await publicAvailability(plan, integrationApplyAvailability(plan));
  const artifacts: IntegrationPlan["artifacts"] = [];
  if (action === "create" || action === "upgrade") {
    artifacts.push({ role: "companion-skill", operation: action });
  }
  if (action !== "blocked") {
    artifacts.push({ role: "harness-configuration", operation: "connect" });
  }
  return {
    schemaVersion: 1,
    planId: plan.id,
    harness: plan.harness,
    action,
    status: companionStatus(plan),
    availability,
    targets: {
      hook: plan.targetPath,
      companion: plan.companion.path
    },
    fingerprintCategory: plan.companion.proof.kind,
    artifacts,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt
  };
}

function assertPlanId(planId: string): void {
  if (!strictPlanId.test(planId)) {
    const error = new Error("Reviewed integration plan ID is invalid") as Error & { code: string };
    error.code = "INTEGRATION_PLAN_INVALID";
    throw error;
  }
}

export async function planIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationPlan> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const plan = await planIntegrationInternal(harness, options);
  await writeReviewedPlan(options.stateDirectory, {
    schemaVersion: 1,
    id: plan.id,
    kind: "integration",
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    payload: plan
  });
  return sanitizePlan(plan);
}

export async function applyIntegrationPlan(
  planId: string,
  options: IntegrationTransactionOptions
): Promise<IntegrationTransactionReceipt> {
  assertPlanId(planId);
  try {
    return sanitizeReceipt(await applyReviewedCompanionIntegrationTransaction(
      planId,
      options as Parameters<typeof applyReviewedCompanionIntegrationTransaction>[1]
    ));
  } catch (error) {
    if (error instanceof CompanionTransactionError) throw new IntegrationTransactionError(error);
    throw error;
  }
}

export async function integrationStatus(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationStatus> {
  const status = await inspectIntegrationStatus(inputHarness, options);
  const hookReason = status.status === "not-installed"
    ? "HOOK_NOT_INSTALLED"
    : status.status === "installed"
      ? "HOOK_INSTALLED"
      : status.status === "needs-trust"
        ? "HOOK_NEEDS_TRUST"
        : status.status === "drifted"
          ? "HOOK_DRIFTED"
          : "HOOK_INVALID";
  const hookAvailability: IntegrationStatusAvailability =
    status.status === "drifted" || status.status === "invalid"
      ? { state: "unavailable", available: false, reason: hookReason }
      : { state: "available", available: true, reason: null };
  const companionAvailability: IntegrationStatusAvailability =
    status.companion.status === "conflict" || status.companion.status === "unknown"
      ? {
          state: "unavailable",
          available: false,
          reason: status.companion.reason
        }
      : { state: "available", available: true, reason: null };
  const availability = !hookAvailability.available
    ? hookAvailability
    : companionAvailability;
  return {
    schemaVersion: 2,
    harness: status.harness,
    hook: {
      status: status.status,
      reason: hookReason,
      target: status.targetPath,
      availability: hookAvailability,
      ...(status.lastChangedAt ? { lastChangedAt: status.lastChangedAt } : {})
    },
    companion: {
      status: status.companion.status,
      reason: status.companion.reason,
      target: status.companion.path,
      proofCategory: status.companion.proofCategory,
      availability: companionAvailability,
      ...(status.lastChangedAt ? { lastChangedAt: status.lastChangedAt } : {})
    },
    availability,
    status: status.companion.status,
    reason: status.companion.reason,
    hookStatus: status.status,
    ...(status.lastChangedAt ? { lastChangedAt: status.lastChangedAt } : {})
  };
}

export async function planIntegrationDisconnect(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationDisconnectPlan> {
  const plan = await planIntegrationDisconnectInternal(inputHarness, options);
  return {
    schemaVersion: 1,
    planId: plan.id,
    harness: plan.harness,
    action: "disconnect",
    status: "current",
    availability: { state: "available", available: true, reason: null },
    targets: {
      hook: plan.configuration.path,
      companion: plan.companion.path
    },
    fingerprintCategory: "recorded",
    artifacts: [{ role: "harness-configuration", operation: "disconnect" }],
    companion: plan.companion.status,
    companionRetained: plan.companion.status === "retained",
    lastConsumer: plan.companion.status === "removed",
    remainingConsumers: plan.companion.remainingConsumers.length,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt
  };
}

export async function applyIntegrationDisconnect(
  planId: string,
  options: IntegrationTransactionOptions
): Promise<IntegrationTransactionReceipt> {
  assertPlanId(planId);
  try {
    return sanitizeReceipt(await disconnectCompanionIntegrationTransaction(
      planId,
      options as Parameters<typeof disconnectCompanionIntegrationTransaction>[1]
    ));
  } catch (error) {
    if (error instanceof CompanionTransactionError) throw new IntegrationTransactionError(error);
    throw error;
  }
}

export async function removeLegacyIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationTransactionOptions
): Promise<IntegrationLegacyRemovalReceipt> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  return withIntegrationMutationLease(options.stateDirectory, async (leaseContext) => {
    const record = await removeLegacyIntegrationInternal(harness, {
      ...options,
      leaseContext
    });
    let report: unknown;
    try {
      report = await options.generateReadiness({
        transactionId: record.id,
        recordId: record.id,
        planId: record.id,
        harness,
        action: "disconnect"
      });
      await writeLatestReport(
        options.stateDirectory,
        report as Parameters<typeof writeLatestReport>[1]
      );
    } catch (cause) {
      const error = new Error(
        "Legacy integration was removed, but readiness publication failed",
        { cause }
      ) as Error & { code: string };
      error.code = "INTEGRATION_READINESS_FAILED";
      throw error;
    }
    return {
      outcome: "removed",
      harness,
      recordId: record.id,
      readiness: "ready",
      companion: "retained"
    };
  });
}
