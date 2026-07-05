import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  appendIntegrationRecord,
  appendIntegrationRecoveryTransition,
  assertIntegrationMutationLeaseOwned,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent,
  finalizeIntegrationFileTransaction,
  finalizeIntegrationReadiness,
  fingerprintIntegrationFileBytes,
  IntegrationFileTransactionError,
  inspectIntegrationFileState,
  integrationReadinessTransactionReceipt,
  publishIntegrationFileTransaction,
  publishIntegrationReadiness,
  readIntegrationRecordJournal,
  readIntegrationRecoveryState,
  claimReviewedPlan,
  peekReviewedPlan,
  restoreIntegrationFileTransaction,
  restoreIntegrationReadiness,
  withIntegrationMutationLease,
  type IntegrationFileExpectedState,
  type IntegrationFileRecoveryArtifact,
  type IntegrationFileTransactionHandle,
  type IntegrationMutationLeaseContext,
  type IntegrationReadinessTransactionHandle,
  type IntegrationRecordCommitReceipt,
  type IntegrationRecordV2,
  type IntegrationRecoveryArtifactProof,
  type IntegrationRecoveryState,
  type IntegrationReadinessRecoveryBinding
} from "@skill-steward/store";
import { z } from "zod";
import {
  cleanupOwnedTree,
  createOwnedTreeAncestors,
  createOwnedTreeStage,
  moveOwnedTree,
  ownedTreeRecoveryArtifactProof,
  ownedTreeSiblingPath,
  proveOwnedTree,
  restoreOwnedTreeUpgrade,
  rollbackCreatedOwnedTreeAncestors,
  type CreatedOwnedTreeAncestorProof,
  type OwnedTreeHandle,
  type OwnedTreeMutationHooks
} from "./companion-owned-tree.js";
import type { CompanionSubplan } from "./companion-domain.js";
import { assertCompanionPlanNativeCapability } from "./companion-native-capability.js";
import { resolveCompanionConsumers } from "./companion-legacy.js";
import { inspectCompanionTree } from "./companion-manifest.js";
import {
  IntegrationError,
  integrationPlanSchema,
  revalidateClaimedIntegrationPlan,
  integrationDisconnectPlanSchema,
  revalidateClaimedIntegrationDisconnect,
  type IntegrationConfigOptions,
  type IntegrationDisconnectPlan,
  type IntegrationPlan
} from "./config.js";
import { integrationHarnessSchema, type IntegrationHarness } from "./domain.js";

const stableReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/);

export const companionTransactionReceiptSchema = z.object({
  transactionId: z.string().uuid(),
  outcome: z.enum(["ready", "rolled-back", "recovery-required"]),
  hook: z.enum(["unchanged", "installed", "removed", "restored", "unknown"]),
  companion: z.enum([
    "unchanged",
    "created",
    "upgraded",
    "retained",
    "restored",
    "unknown"
  ]),
  recordId: z.string().min(1).max(128),
  cleanup: z.enum(["clean", "pending"]),
  reasonCode: stableReasonCodeSchema,
  nextSafeAction: z.enum([
    "none",
    "create-new-plan",
    "recover-transaction",
    "review-final-cleanup"
  ])
}).strict();

export type CompanionTransactionReceipt = z.infer<
  typeof companionTransactionReceiptSchema
>;

export class CompanionTransactionError extends Error {
  readonly code: string;
  readonly receipt: CompanionTransactionReceipt;

  constructor(cause: unknown, receipt: CompanionTransactionReceipt) {
    const message = receipt.outcome === "rolled-back"
      ? "Companion transaction rolled back; create a fresh reviewed plan"
      : "Companion transaction requires recovery before another mutation";
    super(message, { cause });
    this.name = "CompanionTransactionError";
    this.receipt = companionTransactionReceiptSchema.parse(receipt);
    this.code = this.receipt.reasonCode;
  }

  toJSON(): { name: string; message: string; receipt: CompanionTransactionReceipt } {
    return { name: this.name, message: this.message, receipt: this.receipt };
  }
}

type ApplyableCompanionSubplan = Extract<
  CompanionSubplan,
  { action: "create" | "upgrade" | "none" }
>;

type ApplyableIntegrationPlan = IntegrationPlan & {
  companion: ApplyableCompanionSubplan;
};

type CompanionTransactionPlan = ApplyableIntegrationPlan | IntegrationDisconnectPlan;

function isDisconnectPlan(plan: CompanionTransactionPlan): plan is IntegrationDisconnectPlan {
  return "action" in plan && plan.action === "disconnect";
}

export interface CompanionReadinessContext {
  transactionId: string;
  recordId: string;
  planId: string;
  harness: CompanionTransactionPlan["harness"];
  action: ApplyableCompanionSubplan["action"] | "disconnect";
}

export interface CompanionTransactionOptions extends IntegrationConfigOptions {
  expectedHarness?: IntegrationHarness;
  generateReadiness(
    context: CompanionReadinessContext
  ): Promise<Parameters<typeof publishIntegrationReadiness>[0]>;
}

function assertExpectedReviewedHarness(
  envelope: { payload: unknown },
  expectedHarness: IntegrationHarness
): void {
  if (
    typeof envelope.payload !== "object"
    || envelope.payload === null
    || !("harness" in envelope.payload)
  ) return;
  const harness = integrationHarnessSchema.safeParse(envelope.payload.harness);
  if (harness.success && harness.data !== expectedHarness) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_MISMATCH",
      "Reviewed integration plan belongs to a different Harness"
    );
  }
}

export type CompanionTransactionBoundary =
  | "lease-assert"
  | "plan-revalidate"
  | "recovery-intent"
  | "recovery-checkpoint"
  | "stage"
  | "backup-rename"
  | "install-rename"
  | "config-ancestors"
  | "config-publish"
  | "readiness-generate"
  | "readiness-publish"
  | "journal-append"
  | "recovery-commit"
  | "readiness-finalize"
  | "tree-cleanup"
  | "config-finalize"
  | "recovery-close";

export interface CompanionTransactionDependencies {
  transactionId(): string;
  recordId(): string;
  beforeBoundary(boundary: CompanionTransactionBoundary): Promise<void>;
  afterBoundary(boundary: CompanionTransactionBoundary): Promise<void>;
  ownedTreeHooks?: OwnedTreeMutationHooks;
  appendRecord: typeof appendIntegrationRecord;
  appendRecovery: typeof appendIntegrationRecoveryTransition;
  assertLease: typeof assertIntegrationMutationLeaseOwned;
  cleanupTree: typeof cleanupOwnedTree;
  createIntent: typeof createIntegrationRecoveryIntent;
  createAncestors: typeof createOwnedTreeAncestors;
  createStage: typeof createOwnedTreeStage;
  finalizeConfig: typeof finalizeIntegrationFileTransaction;
  finalizeReadiness: typeof finalizeIntegrationReadiness;
  inspectFile: typeof inspectIntegrationFileState;
  moveTree: typeof moveOwnedTree;
  proveTree: typeof proveOwnedTree;
  publishConfig: typeof publishIntegrationFileTransaction;
  publishReadiness: typeof publishIntegrationReadiness;
  readJournal: typeof readIntegrationRecordJournal;
  readRecovery: typeof readIntegrationRecoveryState;
  restoreConfig: typeof restoreIntegrationFileTransaction;
  restoreReadiness: typeof restoreIntegrationReadiness;
  restoreUpgrade: typeof restoreOwnedTreeUpgrade;
  rollbackAncestors: typeof rollbackCreatedOwnedTreeAncestors;
  withLease: typeof withIntegrationMutationLease;
}

const defaultDependencies: CompanionTransactionDependencies = {
  transactionId: randomUUID,
  recordId: randomUUID,
  beforeBoundary: async () => undefined,
  afterBoundary: async () => undefined,
  appendRecord: appendIntegrationRecord,
  appendRecovery: appendIntegrationRecoveryTransition,
  assertLease: assertIntegrationMutationLeaseOwned,
  cleanupTree: cleanupOwnedTree,
  createIntent: createIntegrationRecoveryIntent,
  createAncestors: createOwnedTreeAncestors,
  createStage: createOwnedTreeStage,
  finalizeConfig: finalizeIntegrationFileTransaction,
  finalizeReadiness: finalizeIntegrationReadiness,
  inspectFile: inspectIntegrationFileState,
  moveTree: moveOwnedTree,
  proveTree: proveOwnedTree,
  publishConfig: publishIntegrationFileTransaction,
  publishReadiness: publishIntegrationReadiness,
  readJournal: readIntegrationRecordJournal,
  readRecovery: readIntegrationRecoveryState,
  restoreConfig: restoreIntegrationFileTransaction,
  restoreReadiness: restoreIntegrationReadiness,
  restoreUpgrade: restoreOwnedTreeUpgrade,
  rollbackAncestors: rollbackCreatedOwnedTreeAncestors,
  withLease: withIntegrationMutationLease
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]+$/.test(error.code)
    ? error.code
    : undefined;
}

const uncertaintyCodes = new Set([
  "INTEGRATION_CONFIGURATION_CLEANUP_PENDING",
  "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE",
  "INTEGRATION_CONFIGURATION_UNCERTAIN",
  "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN",
  "INTEGRATION_LEASE_LOST",
  "INTEGRATION_LEASE_UNSAFE",
  "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
  "INTEGRATION_READINESS_UNCERTAIN",
  "INTEGRATION_RECOVERY_REQUIRED",
  "INTEGRATION_RECOVERY_UNAVAILABLE",
  "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN"
]);

function isUncertain(error: unknown, seen = new Set<unknown>()): boolean {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const code = errorCode(error);
  if (code !== undefined && uncertaintyCodes.has(code)) return true;
  if (error instanceof AggregateError && error.errors.some((entry) => isUncertain(entry, seen))) {
    return true;
  }
  return "cause" in error && isUncertain(error.cause, seen);
}

function proofCategory(
  proof: ApplyableCompanionSubplan["proof"]
): IntegrationRecordV2["companion"]["proof"] {
  if (proof.kind === "new") return { category: "new" };
  if (proof.kind === "recorded") return { category: "recorded" };
  if (proof.kind === "legacy-alpha") return { category: "legacy-alpha" };
  throw new IntegrationError(
    "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
    "Companion transaction proof is not mutation-authorizing"
  );
}

function exactBeforeFingerprint(companion: ApplyableCompanionSubplan): string {
  if (companion.expectedBefore.state !== "exact") {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Existing companion transaction requires an exact before fingerprint"
    );
  }
  return companion.expectedBefore.fingerprint;
}

function buildLifecycleRecord(
  plan: ApplyableIntegrationPlan,
  recordId: string,
  createdAt: string,
  companionBeforeFingerprint: string | null,
  consumers: IntegrationRecordV2["companion"]["consumers"]
): IntegrationRecordV2 {
  return {
    schemaVersion: 2,
    id: recordId,
    harness: plan.harness,
    action: "apply",
    status: "installed",
    targetPath: plan.targetPath,
    beforeFingerprint: plan.expectedBeforeFingerprint,
    afterFingerprint: plan.afterFingerprint,
    installedEntryFingerprint: plan.installedEntryFingerprint,
    companion: {
      action: plan.companion.action,
      path: plan.companion.path,
      before: plan.companion.action === "create"
        ? { state: "absent" }
        : {
            state: "exact",
            fingerprint: companionBeforeFingerprint!
          },
      after: { state: "exact", fingerprint: plan.companion.after.fingerprint },
      source: { fingerprint: plan.companion.source.fingerprint },
      proof: proofCategory(plan.companion.proof),
      installedFingerprint: plan.companion.after.fingerprint,
      consumers
    },
    trigger: { planId: plan.id, harness: plan.harness, createdAt },
    createdAt
  };
}

function buildDisconnectLifecycleRecord(
  plan: IntegrationDisconnectPlan,
  recordId: string
): IntegrationRecordV2 {
  return {
    schemaVersion: 2,
    id: recordId,
    harness: plan.harness,
    action: "remove",
    status: "removed",
    targetPath: plan.configuration.path,
    beforeFingerprint: plan.configuration.before.fingerprint,
    afterFingerprint: plan.configuration.after.fingerprint,
    installedEntryFingerprint: plan.configuration.installedEntryFingerprint,
    companion: {
      action: "retain",
      path: plan.companion.path,
      before: { state: "exact", fingerprint: plan.companion.fingerprint },
      after: { state: "exact", fingerprint: plan.companion.fingerprint },
      source: { fingerprint: plan.companion.sourceFingerprint },
      proof: { category: "recorded" },
      installedFingerprint: plan.companion.installedFingerprint,
      consumers: plan.companion.remainingConsumers
    },
    trigger: plan.readiness.trigger,
    createdAt: plan.createdAt
  };
}

function fileFingerprint(state: IntegrationFileExpectedState): string {
  return state.state === "file"
    ? state.fingerprint
    : fingerprintIntegrationFileBytes(Buffer.alloc(0));
}

function exactTransactionPlan(
  left: CompanionTransactionPlan,
  right: CompanionTransactionPlan
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function checkedBoundary<T>(
  dependencies: CompanionTransactionDependencies,
  boundary: CompanionTransactionBoundary,
  operation: () => Promise<T>
): Promise<T> {
  await dependencies.beforeBoundary(boundary);
  const result = await operation();
  await dependencies.afterBoundary(boundary);
  return result;
}

function installedProof(handle: OwnedTreeHandle): IntegrationRecoveryArtifactProof {
  const proof = ownedTreeRecoveryArtifactProof(handle);
  return structuredClone({ ...proof, role: "installed" as const });
}

async function moveOrThrow(
  handle: OwnedTreeHandle,
  destination: string,
  mutationOptions: {
    stateDirectory: string;
    leaseContext: IntegrationMutationLeaseContext;
    hooks?: OwnedTreeMutationHooks;
  },
  dependencies: CompanionTransactionDependencies
): Promise<OwnedTreeHandle> {
  const outcome = await dependencies.moveTree(handle, destination, mutationOptions);
  if (outcome.state === "moved") return outcome.handle;
  if (outcome.state === "uncertain") throw outcome.error;
  throw outcome.cause;
}

function recoveryReceipt(input: {
  transactionId: string;
  recordId: string;
  outcome: "rolled-back" | "recovery-required";
  reasonCode: string;
  hook: CompanionTransactionReceipt["hook"];
  companion: CompanionTransactionReceipt["companion"];
}): CompanionTransactionReceipt {
  return companionTransactionReceiptSchema.parse({
    transactionId: input.transactionId,
    outcome: input.outcome,
    hook: input.hook,
    companion: input.companion,
    recordId: input.recordId,
    cleanup: input.outcome === "rolled-back" ? "clean" : "pending",
    reasonCode: input.reasonCode,
    nextSafeAction: input.outcome === "rolled-back"
      ? "create-new-plan"
      : "recover-transaction"
  });
}

type CompanionTerminalResult =
  | { kind: "ready"; receipt: CompanionTransactionReceipt }
  | { kind: "failure"; error: unknown };

function cleanupPendingReceipt(
  receipt: CompanionTransactionReceipt
): CompanionTransactionReceipt {
  return companionTransactionReceiptSchema.parse({
    ...receipt,
    cleanup: "pending",
    reasonCode: receipt.outcome === "ready"
      ? "INTEGRATION_READY_CLEANUP_PENDING"
      : receipt.reasonCode,
    nextSafeAction: "recover-transaction"
  });
}

async function runWithTerminalLease(
  dependencies: CompanionTransactionDependencies,
  stateDirectory: string,
  transactionId: string,
  recordId: string,
  operation: (leaseContext: IntegrationMutationLeaseContext) => Promise<CompanionTransactionReceipt>
): Promise<CompanionTransactionReceipt> {
  let terminal: CompanionTerminalResult | undefined;
  try {
    await dependencies.withLease(stateDirectory, async (leaseContext) => {
      try {
        terminal = { kind: "ready", receipt: await operation(leaseContext) };
      } catch (error) {
        terminal = { kind: "failure", error };
      }
    });
  } catch (leaseError) {
    if (terminal?.kind === "ready") {
      return cleanupPendingReceipt(terminal.receipt);
    }
    if (terminal?.kind === "failure") {
      const failure = terminal.error;
      if (failure instanceof CompanionTransactionError) {
        throw new CompanionTransactionError(
          failure.cause,
          cleanupPendingReceipt(failure.receipt)
        );
      }
      throw new CompanionTransactionError(leaseError, companionTransactionReceiptSchema.parse({
        transactionId,
        outcome: "recovery-required",
        hook: "unknown",
        companion: "unknown",
        recordId,
        cleanup: "pending",
        reasonCode: errorCode(failure) ?? errorCode(leaseError) ?? "INTEGRATION_LEASE_UNSAFE",
        nextSafeAction: "recover-transaction"
      }));
    }
    throw new CompanionTransactionError(leaseError, companionTransactionReceiptSchema.parse({
      transactionId,
      outcome: "recovery-required",
      hook: "unknown",
      companion: "unknown",
      recordId,
      cleanup: "pending",
      reasonCode: errorCode(leaseError) ?? "INTEGRATION_LEASE_UNSAFE",
      nextSafeAction: "recover-transaction"
    }));
  }
  if (terminal?.kind === "ready") return terminal.receipt;
  if (terminal?.kind === "failure") throw terminal.error;
  throw new CompanionTransactionError(
    new Error("Integration lease ended without a terminal transaction result"),
    companionTransactionReceiptSchema.parse({
      transactionId,
      outcome: "recovery-required",
      hook: "unknown",
      companion: "unknown",
      recordId,
      cleanup: "pending",
      reasonCode: "INTEGRATION_LEASE_UNSAFE",
      nextSafeAction: "recover-transaction"
    })
  );
}

export async function applyCompanionIntegrationTransaction(
  inputPlan: unknown,
  options: CompanionTransactionOptions,
  dependencyOverrides: Partial<CompanionTransactionDependencies> = {}
): Promise<CompanionTransactionReceipt> {
  return runCompanionIntegrationTransaction(
    { kind: "apply", inputPlan },
    options,
    dependencyOverrides
  );
}

/** Package-private high-level entry point. The reviewed plan is claimed inside the mutation lease. */
export async function applyReviewedCompanionIntegrationTransaction(
  planId: string,
  options: CompanionTransactionOptions,
  dependencyOverrides: Partial<CompanionTransactionDependencies> = {}
): Promise<CompanionTransactionReceipt> {
  return runCompanionIntegrationTransaction(
    { kind: "apply-reviewed", planId },
    options,
    dependencyOverrides
  );
}

/** Package-private until the Phase 4 common-surface activation gate. */
export async function disconnectCompanionIntegrationTransaction(
  planId: string,
  options: CompanionTransactionOptions,
  dependencyOverrides: Partial<CompanionTransactionDependencies> = {}
): Promise<CompanionTransactionReceipt> {
  return runCompanionIntegrationTransaction(
    { kind: "disconnect", planId },
    options,
    dependencyOverrides
  );
}

async function runCompanionIntegrationTransaction(
  request:
    | { kind: "apply"; inputPlan: unknown }
    | { kind: "apply-reviewed"; planId: string }
    | { kind: "disconnect"; planId: string },
  options: CompanionTransactionOptions,
  dependencyOverrides: Partial<CompanionTransactionDependencies>
): Promise<CompanionTransactionReceipt> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  let applyPlan: ApplyableIntegrationPlan | undefined;
  if (request.kind === "apply") {
    const parsed = integrationPlanSchema.safeParse(request.inputPlan);
    if (!parsed.success) {
      throw new IntegrationError(
        "INTEGRATION_PLAN_INVALID",
        "Integration plan failed strict transaction validation",
        { cause: parsed.error }
      );
    }
    if (parsed.data.companion.action === "conflict") {
      throw new IntegrationError(
        "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
        "Conflict and unknown companion plans cannot start a transaction"
      );
    }
    applyPlan = parsed.data as ApplyableIntegrationPlan;
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.planId)) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Reviewed disconnect plan ID is invalid"
    );
  }
  if (
    process.platform === "win32"
    || (applyPlan !== undefined && applyPlan.companion.after.platform !== "posix")
  ) {
    throw new IntegrationError(
      "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
      "Companion transactions are unavailable on this platform"
    );
  }
  const transactionId = dependencies.transactionId();
  const recordId = dependencies.recordId();
  return runWithTerminalLease(
    dependencies,
    options.stateDirectory,
    transactionId,
    recordId,
    async (leaseContext) => {
    let plan: CompanionTransactionPlan;
    if (request.kind === "disconnect" || request.kind === "apply-reviewed") {
      await dependencies.assertLease(leaseContext, options.stateDirectory);
      const kind = request.kind === "disconnect" ? "integration-disconnect" : "integration";
      const expectedHarness = options.expectedHarness;
      if (expectedHarness !== undefined) {
        assertExpectedReviewedHarness(await peekReviewedPlan(options.stateDirectory, {
          id: request.planId,
          kind,
          now: options.now?.() ?? new Date()
        }), expectedHarness);
      }
      const envelope = await claimReviewedPlan(options.stateDirectory, {
        id: request.planId,
        kind,
        now: options.now?.() ?? new Date(),
        ...(expectedHarness === undefined
          ? {}
          : {
              validate: (candidate: { payload: unknown }) => {
                assertExpectedReviewedHarness(candidate, expectedHarness);
              }
            })
      });
      if (request.kind === "disconnect") {
        const parsed = integrationDisconnectPlanSchema.safeParse(envelope.payload);
        if (
          !parsed.success
          || parsed.data.id !== envelope.id
          || parsed.data.createdAt !== envelope.createdAt
          || parsed.data.expiresAt !== envelope.expiresAt
        ) {
          throw new IntegrationError(
            "INTEGRATION_PLAN_INVALID",
            "Reviewed disconnect plan failed strict transaction validation",
            parsed.success ? undefined : { cause: parsed.error }
          );
        }
        plan = parsed.data;
      } else {
        const parsed = integrationPlanSchema.safeParse(envelope.payload);
        if (
          !parsed.success
          || parsed.data.id !== envelope.id
          || parsed.data.createdAt !== envelope.createdAt
          || parsed.data.expiresAt !== envelope.expiresAt
        ) {
          throw new IntegrationError(
            "INTEGRATION_PLAN_INVALID",
            "Reviewed integration plan failed strict transaction validation",
            parsed.success ? undefined : { cause: parsed.error }
          );
        }
        if (parsed.data.companion.action === "conflict") {
          throw new IntegrationError(
            "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
            "Conflict and unknown companion plans cannot start a transaction"
          );
        }
        plan = parsed.data as ApplyableIntegrationPlan;
      }
    } else {
      plan = applyPlan!;
    }
    const disconnecting = isDisconnectPlan(plan);
    const disconnectPlan = disconnecting ? plan as IntegrationDisconnectPlan : undefined;
    const applyTransactionPlan = disconnecting
      ? undefined
      : plan as ApplyableIntegrationPlan;
    if (applyTransactionPlan !== undefined) {
      await assertCompanionPlanNativeCapability(applyTransactionPlan);
    }
    const mutationOptions = {
      stateDirectory: options.stateDirectory,
      leaseContext,
      ...(dependencies.ownedTreeHooks ? { hooks: dependencies.ownedTreeHooks } : {})
    };
    let recovery: IntegrationRecoveryState | undefined;
    let stage: OwnedTreeHandle | undefined;
    let backup: OwnedTreeHandle | undefined;
    let installed: OwnedTreeHandle | undefined;
    let createdAncestors: readonly CreatedOwnedTreeAncestorProof[] = [];
    let configAncestors: readonly CreatedOwnedTreeAncestorProof[] = [];
    let backupMoved = false;
    let installedPublished = false;
    let configHandle: IntegrationFileTransactionHandle | undefined;
    let readinessHandle: IntegrationReadinessTransactionHandle | undefined;
    let commitReceipt: IntegrationRecordCommitReceipt | undefined;
    let hookOutcome: CompanionTransactionReceipt["hook"] = "unchanged";
    const checkpoint = async (
      additions: IntegrationRecoveryArtifactProof[] = [],
      publications: {
        configurationArtifactAddition?: IntegrationFileRecoveryArtifact;
        readinessArtifactAddition?: IntegrationReadinessRecoveryBinding;
      } = {},
      lifecycleRecordBindingAddition?: ReturnType<typeof bindIntegrationRecordV2>
    ): Promise<void> => {
      if (!recovery) throw new Error("Recovery intent is unavailable");
      await dependencies.beforeBoundary("recovery-checkpoint");
      recovery = await dependencies.appendRecovery(options.stateDirectory, {
          transactionId,
          expectedSequence: recovery!.sequence,
          expectedState: recovery!.state,
          state: "mutating",
          transitionedAt: (options.now?.() ?? new Date()).toISOString(),
          ...(lifecycleRecordBindingAddition ? { lifecycleRecordBindingAddition } : {}),
          ...(additions.length > 0 ? { artifactProofAdditions: additions } : {}),
          ...publications
        }, { leaseContext });
      await dependencies.afterBoundary("recovery-checkpoint");
    };
    const terminalRecovery = async (
      state: "rolled-back" | "recovery-required" | "committed" | "cleanup-pending" | "closed"
    ): Promise<void> => {
      if (!recovery) return;
      recovery = await dependencies.appendRecovery(options.stateDirectory, {
        transactionId,
        expectedSequence: recovery.sequence,
        expectedState: recovery.state,
        state,
        transitionedAt: (options.now?.() ?? new Date()).toISOString()
      }, { leaseContext });
    };

    let record!: IntegrationRecordV2;
    let configBefore!: IntegrationFileExpectedState;
    try {
      await checkedBoundary(dependencies, "lease-assert", () =>
        dependencies.assertLease(leaseContext, options.stateDirectory));
      const currentTime = options.now?.() ?? new Date();
      const createdAt = disconnectPlan?.createdAt ?? currentTime.toISOString();
      const companionBeforeFingerprint = disconnectPlan
        ? disconnectPlan.companion.fingerprint
        : applyTransactionPlan!.companion.action === "create"
          ? null
          : exactBeforeFingerprint(applyTransactionPlan!.companion);
      const companionPath = disconnectPlan?.companion.path
        ?? applyTransactionPlan!.companion.path;
      const parent = dirname(companionPath);
      const artifactHints = disconnectPlan || applyTransactionPlan!.companion.action === "none"
        ? []
        : [
            {
              role: "stage" as const,
              path: ownedTreeSiblingPath(parent, transactionId, "stage")
            },
            ...(applyTransactionPlan!.companion.action === "upgrade"
              ? [{
                  role: "backup" as const,
                  path: ownedTreeSiblingPath(parent, transactionId, "backup")
                }]
              : [])
          ];
      const recoverySummary = await dependencies.readRecovery(options.stateDirectory);
      if (recoverySummary.status !== "clear") {
        throw Object.assign(new Error(
          recoverySummary.status === "unresolved"
            ? "A companion recovery transaction must be resolved before applying another plan"
            : "Companion recovery state could not be proven"
        ), { code: recoverySummary.reason });
      }
      await dependencies.beforeBoundary("recovery-intent");
      recovery = await dependencies.createIntent(options.stateDirectory, {
        schemaVersion: 1,
        transactionId,
        planId: plan.id,
        harness: plan.harness,
        action: disconnectPlan ? "disconnect" : applyTransactionPlan!.companion.action,
        companionPath,
        configPath: disconnectPlan?.configuration.path ?? applyTransactionPlan!.targetPath,
        beforeFingerprint: companionBeforeFingerprint,
        afterFingerprint: disconnectPlan?.companion.fingerprint
          ?? applyTransactionPlan!.companion.after.fingerprint,
        createdAt,
        artifactHints
      }, { leaseContext });
      await dependencies.afterBoundary("recovery-intent");

      if (currentTime.getTime() >= Date.parse(plan.expiresAt)) {
        throw new IntegrationError("INTEGRATION_PLAN_EXPIRED", "Integration plan has expired");
      }
      await dependencies.beforeBoundary("plan-revalidate");
      const revalidationOptions = {
        home: options.home,
        stateDirectory: options.stateDirectory,
        ...(options.companionSourceDirectory
          ? { companionSourceDirectory: options.companionSourceDirectory }
          : {}),
        now: () => new Date(plan.createdAt),
        id: () => plan.id
      };
      const replanned: CompanionTransactionPlan = disconnectPlan
        ? await revalidateClaimedIntegrationDisconnect(disconnectPlan, revalidationOptions)
        : await revalidateClaimedIntegrationPlan(plan.harness, revalidationOptions) as ApplyableIntegrationPlan;
      if (!exactTransactionPlan(plan, replanned)) {
        throw new IntegrationError(
          "INTEGRATION_DRIFTED",
          "The reviewed integration plan is stale and was consumed without mutation"
        );
      }
      const journal = await dependencies.readJournal(options.stateDirectory);
      if (journal.changedDuringRead || journal.orderedRecords.some((entry) =>
        entry.schemaVersion === 2 && entry.trigger.planId === plan.id
      )) {
        throw new IntegrationError(
          "INTEGRATION_DRIFTED",
          "The reviewed integration plan was already consumed or lifecycle evidence changed"
        );
      }
      if (disconnectPlan) {
        const currentHead = journal.orderedRecords[0];
        const currentConsumer = journal.orderedRecords.find(
          (entry) => entry.harness === disconnectPlan.harness
        );
        if (
          currentHead?.schemaVersion !== 2
          || currentConsumer?.schemaVersion !== 2
          || currentHead.id !== disconnectPlan.lifecycleHead.recordId
          || currentConsumer.id !== disconnectPlan.consumerRecord.recordId
          || bindIntegrationRecordV2(currentHead).digest
            !== disconnectPlan.lifecycleHead.binding.digest
          || bindIntegrationRecordV2(currentConsumer).digest
            !== disconnectPlan.consumerRecord.binding.digest
        ) {
          throw new IntegrationError(
            "INTEGRATION_DRIFTED",
            "The reviewed disconnect lifecycle head changed before binding"
          );
        }
      }
      let revalidatedRecord: IntegrationRecordV2;
      if (disconnectPlan) {
        revalidatedRecord = buildDisconnectLifecycleRecord(disconnectPlan, recordId);
      } else {
        const consumerResolution = await resolveCompanionConsumers(
          options.home,
          plan.harness,
          journal
        );
        if (consumerResolution.state !== "proven") {
          throw new IntegrationError(
            "INTEGRATION_DRIFTED",
            "Companion consumer evidence could not be revalidated exactly"
          );
        }
        revalidatedRecord = buildLifecycleRecord(
          applyTransactionPlan!,
          recordId,
          createdAt,
          companionBeforeFingerprint,
          consumerResolution.consumers
        );
      }
      const lifecycleRecordBinding = bindIntegrationRecordV2(revalidatedRecord);
      record = revalidatedRecord;
      let beforeManifest: Awaited<ReturnType<typeof inspectCompanionTree>> | undefined;
      if (applyTransactionPlan?.companion.action === "upgrade") {
        beforeManifest = await inspectCompanionTree(applyTransactionPlan.companion.path, {
          boundary: options.home,
          platform: process.platform
        });
        if (beforeManifest.fingerprint !== companionBeforeFingerprint) {
          throw new IntegrationError(
            "INTEGRATION_DRIFTED",
            "Companion tree changed after review"
          );
        }
      }
      await dependencies.afterBoundary("plan-revalidate");
      await checkpoint([], {}, lifecycleRecordBinding);

      if (applyTransactionPlan && applyTransactionPlan.companion.action !== "none") {
        await dependencies.beforeBoundary("stage");
        const staged = await dependencies.createStage({
          transactionId,
          sourcePath: applyTransactionPlan.companion.source.path,
          destinationPath: applyTransactionPlan.companion.path,
          homeBoundaryPath: options.home,
          expectedManifest: applyTransactionPlan.companion.after
        }, mutationOptions);
        stage = staged.tree;
        createdAncestors = staged.createdAncestors;
        await checkpoint([ownedTreeRecoveryArtifactProof(stage)]);
        await dependencies.afterBoundary("stage");

        if (applyTransactionPlan.companion.action === "upgrade") {
          if (!beforeManifest) throw new Error("Upgrade before manifest is unavailable");
          backup = await dependencies.proveTree({
            transactionId,
            role: "backup",
            path: applyTransactionPlan.companion.path,
            homeBoundaryPath: options.home,
            expectedManifest: beforeManifest
          }, mutationOptions);
          await dependencies.beforeBoundary("backup-rename");
          backup = await moveOrThrow(
            backup,
            ownedTreeSiblingPath(parent, transactionId, "backup"),
            mutationOptions,
            dependencies
          );
          backupMoved = true;
          backup = await dependencies.proveTree({
            transactionId,
            role: "backup",
            path: ownedTreeSiblingPath(parent, transactionId, "backup"),
            homeBoundaryPath: options.home,
            expectedManifest: beforeManifest
          }, mutationOptions);
          await checkpoint([ownedTreeRecoveryArtifactProof(backup)]);
          await dependencies.afterBoundary("backup-rename");
        }

        await dependencies.beforeBoundary("install-rename");
        stage = await moveOrThrow(
          stage,
          applyTransactionPlan.companion.path,
          mutationOptions,
          dependencies
        );
        installedPublished = true;
        installed = await dependencies.proveTree({
          transactionId,
          role: "stage",
          path: applyTransactionPlan.companion.path,
          homeBoundaryPath: options.home,
          expectedManifest: applyTransactionPlan.companion.after
        }, mutationOptions);
        await checkpoint([installedProof(installed)]);
        await dependencies.afterBoundary("install-rename");
      }

      const absentFingerprint = fingerprintIntegrationFileBytes(Buffer.alloc(0));
      const configPath = disconnectPlan?.configuration.path ?? applyTransactionPlan!.targetPath;
      const expectedConfigBeforeFingerprint = disconnectPlan?.configuration.before.fingerprint
        ?? applyTransactionPlan!.expectedBeforeFingerprint;
      const expectedConfigAfterFingerprint = disconnectPlan?.configuration.after.fingerprint
        ?? applyTransactionPlan!.afterFingerprint;
      const configAfter = disconnectPlan?.configuration.after.config
        ?? applyTransactionPlan!.afterConfig;
      const exactConfigNoop = applyTransactionPlan?.changes.length === 0;
      if (!disconnectPlan && expectedConfigBeforeFingerprint === absentFingerprint) {
        await dependencies.beforeBoundary("config-ancestors");
        configAncestors = await dependencies.createAncestors({
          destinationPath: configPath,
          homeBoundaryPath: options.home
        }, mutationOptions);
        await dependencies.afterBoundary("config-ancestors");
      }
      configBefore = await dependencies.inspectFile(
        configPath,
        options.home,
        mutationOptions
      );
      if (fileFingerprint(configBefore) !== expectedConfigBeforeFingerprint) {
        throw new IntegrationError(
          "INTEGRATION_DRIFTED",
          "Harness configuration changed after review"
        );
      }

      if (exactConfigNoop) {
        if (
          configBefore.state !== "file"
          || expectedConfigBeforeFingerprint !== expectedConfigAfterFingerprint
        ) {
          throw new IntegrationError(
            "INTEGRATION_DRIFTED",
            "Reviewed no-op Hook evidence is contradictory"
          );
        }
      } else {
        const afterBytes = Buffer.from(stableJson(configAfter), "utf8");
        if (fingerprintIntegrationFileBytes(afterBytes) !== expectedConfigAfterFingerprint) {
          throw new IntegrationError("INTEGRATION_DRIFTED", "Reviewed Hook content changed");
        }
        await dependencies.beforeBoundary("config-publish");
        configHandle = await dependencies.publishConfig({
          targetPath: configPath,
          allowedBoundaryPath: options.home,
          expectedBefore: configBefore,
          after: {
            state: "file",
            bytes: afterBytes,
            fingerprint: expectedConfigAfterFingerprint,
            mode: 0o600
          },
          recovery: {
            transactionId,
            beforePublish: (artifact) => checkpoint([], {
              configurationArtifactAddition: artifact
            })
          }
        }, mutationOptions);
        hookOutcome = disconnectPlan ? "removed" : "installed";
        const afterConfig = await dependencies.inspectFile(
          configPath,
          options.home,
          mutationOptions
        );
        if (
          afterConfig.state !== "file"
          || afterConfig.fingerprint !== expectedConfigAfterFingerprint
        ) {
          throw new IntegrationError(
            "INTEGRATION_DRIFTED",
            "Published Harness Hook could not be reverified"
          );
        }
        await dependencies.afterBoundary("config-publish");
      }

      const readiness = await checkedBoundary(dependencies, "readiness-generate", () =>
        options.generateReadiness({
          transactionId,
          recordId,
          planId: plan.id,
          harness: plan.harness,
          action: disconnectPlan ? "disconnect" : applyTransactionPlan!.companion.action
        }));
      await dependencies.beforeBoundary("readiness-publish");
      readinessHandle = await dependencies.publishReadiness(readiness, {
        stateDirectory: options.stateDirectory,
        leaseContext,
        transactionId: recordId,
        trigger: record.trigger,
        recovery: {
          transactionId,
          beforePublish: (artifact) => checkpoint([], {
            readinessArtifactAddition: artifact
          })
        }
      });
      const readinessReceipt = integrationReadinessTransactionReceipt(readinessHandle);
      if (readinessReceipt.transactionId !== recordId || readinessReceipt.status !== "published") {
        throw new Error("Readiness publication proof does not match the lifecycle record");
      }
      await dependencies.afterBoundary("readiness-publish");

      await dependencies.beforeBoundary("journal-append");
      commitReceipt = await dependencies.appendRecord(
        options.stateDirectory,
        record,
        { beforePublish: () => dependencies.assertLease(leaseContext, options.stateDirectory) }
      );
    } catch (error) {
      if (commitReceipt !== undefined) {
        return finishCommitted(error);
      }
      if (
        error instanceof IntegrationFileTransactionError
        && error.recoveryArtifact !== undefined
        && recovery?.configurationArtifact === undefined
      ) {
        await checkpoint([], {
          configurationArtifactAddition: error.recoveryArtifact
        }).catch(() => undefined);
      }
      const primaryCode = errorCode(error) ?? "INTEGRATION_TRANSACTION_FAILED";
      if (isUncertain(error)) {
        await terminalRecovery("recovery-required").catch(() => undefined);
        throw new CompanionTransactionError(error, recoveryReceipt({
          transactionId,
          recordId,
          outcome: "recovery-required",
          reasonCode: primaryCode,
          hook: "unknown",
          companion: "unknown"
        }));
      }

      const compensationErrors: unknown[] = [];
      let compensationBlocked = false;
      if (readinessHandle) {
        try {
          await dependencies.restoreReadiness(readinessHandle, mutationOptions);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
          compensationBlocked = true;
        }
      }
      if (!compensationBlocked && configHandle) {
        try {
          await dependencies.restoreConfig(configHandle, mutationOptions);
          hookOutcome = "restored";
        } catch (compensationError) {
          compensationErrors.push(compensationError);
          hookOutcome = "unknown";
          compensationBlocked = true;
        }
      }
      if (!compensationBlocked && configAncestors.length > 0) {
        try {
          await dependencies.rollbackAncestors(configAncestors, mutationOptions);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
          compensationBlocked = true;
        }
      }
      if (!compensationBlocked) {
        try {
          if (applyTransactionPlan?.companion.action === "upgrade" && backupMoved && backup) {
            if (installedPublished && installed) {
              const restored = await dependencies.restoreUpgrade(
                installed,
                backup,
                mutationOptions
              );
              if (restored.state !== "restored") throw restored.warning;
            } else {
              backup = await moveOrThrow(
                backup,
                applyTransactionPlan.companion.path,
                mutationOptions,
                dependencies
              );
              if (stage) {
                const cleanup = await dependencies.cleanupTree(stage, mutationOptions);
                if (cleanup.state !== "cleaned") throw cleanup.warning;
              }
            }
          } else if (applyTransactionPlan?.companion.action === "create" && (installed ?? stage)) {
            const cleanup = await dependencies.cleanupTree(installed ?? stage!, mutationOptions);
            if (cleanup.state !== "cleaned") throw cleanup.warning;
          } else if (stage) {
            const cleanup = await dependencies.cleanupTree(stage, mutationOptions);
            if (cleanup.state !== "cleaned") throw cleanup.warning;
          }
        } catch (compensationError) {
          compensationErrors.push(compensationError);
          compensationBlocked = true;
        }
      }
      if (!compensationBlocked && createdAncestors.length > 0) {
        try {
          await dependencies.rollbackAncestors(createdAncestors, mutationOptions);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
          compensationBlocked = true;
        }
      }
      if (compensationErrors.length === 0) {
        try {
          await terminalRecovery("rolled-back");
          await terminalRecovery("closed");
        } catch (recoveryError) {
          compensationErrors.push(recoveryError);
        }
      }
      if (compensationErrors.length > 0) {
        await terminalRecovery("recovery-required").catch(() => undefined);
        throw new CompanionTransactionError(error, recoveryReceipt({
          transactionId,
          recordId,
          outcome: "recovery-required",
          reasonCode: primaryCode,
          hook: hookOutcome === "unchanged" ? "unknown" : hookOutcome,
          companion: "unknown"
        }));
      }
      throw new CompanionTransactionError(error, recoveryReceipt({
        transactionId,
        recordId,
        outcome: "rolled-back",
        reasonCode: primaryCode,
        hook: hookOutcome === "unchanged" ? "unchanged" : "restored",
        companion: disconnectPlan
          ? "retained"
          : applyTransactionPlan!.companion.action === "none"
            ? "unchanged"
            : "restored"
      }));
    }

    return finishCommitted();

    async function finishCommitted(postCommitError?: unknown): Promise<CompanionTransactionReceipt> {
      const warnings: unknown[] = postCommitError === undefined ? [] : [postCommitError];
      try {
        await dependencies.afterBoundary("journal-append");
      } catch (error) {
        warnings.push(error);
      }
      try {
        await checkedBoundary(dependencies, "recovery-commit", () => terminalRecovery("committed"));
      } catch (error) {
        warnings.push(error);
        if (recovery?.state === "committed") {
          await terminalRecovery("cleanup-pending").catch(() => undefined);
        } else if (recovery?.state === "mutating") {
          await terminalRecovery("recovery-required").catch(() => undefined);
        }
        return companionTransactionReceiptSchema.parse({
          transactionId,
          outcome: "ready",
          hook: hookOutcome,
          companion: disconnectPlan
            ? "retained"
            : applyTransactionPlan!.companion.action === "create"
            ? "created"
            : applyTransactionPlan!.companion.action === "upgrade"
              ? "upgraded"
              : "unchanged",
          recordId,
          cleanup: "pending",
          reasonCode: "INTEGRATION_READY_CLEANUP_PENDING",
          nextSafeAction: "recover-transaction"
        });
      }
      if (readinessHandle && commitReceipt) {
        try {
          const finalized = await checkedBoundary(dependencies, "readiness-finalize", () =>
            dependencies.finalizeReadiness(
              readinessHandle!,
              commitReceipt!,
              mutationOptions
            ));
          if (finalized.status === "committed-warning") warnings.push(...finalized.warnings);
        } catch (error) {
          warnings.push(error);
        }
      }
      if (applyTransactionPlan?.companion.action === "upgrade" && backup) {
        try {
          const cleanup = await checkedBoundary(dependencies, "tree-cleanup", () =>
            dependencies.cleanupTree(backup!, mutationOptions));
          if (cleanup.state === "cleanup-pending") warnings.push(cleanup.warning);
        } catch (error) {
          warnings.push(error);
        }
      }
      if (configHandle) {
        try {
          await checkedBoundary(dependencies, "config-finalize", () =>
            dependencies.finalizeConfig(configHandle!, mutationOptions));
        } catch (error) {
          warnings.push(error);
        }
      }
      if (warnings.length === 0) {
        try {
          await checkedBoundary(dependencies, "recovery-close", () => terminalRecovery("closed"));
        } catch (error) {
          warnings.push(error);
        }
      }
      if (warnings.length > 0 && recovery?.state === "committed") {
        await terminalRecovery("cleanup-pending").catch(() => undefined);
      }
      return companionTransactionReceiptSchema.parse({
        transactionId,
        outcome: "ready",
        hook: hookOutcome,
        companion: disconnectPlan
          ? "retained"
          : applyTransactionPlan!.companion.action === "create"
          ? "created"
          : applyTransactionPlan!.companion.action === "upgrade"
            ? "upgraded"
            : "unchanged",
        recordId,
        cleanup: warnings.length === 0 ? "clean" : "pending",
        reasonCode: warnings.length === 0
          ? disconnectPlan?.companion.remainingConsumers.length === 0
            ? "INTEGRATION_READY_FINAL_CLEANUP_PENDING"
            : "INTEGRATION_READY"
          : "INTEGRATION_READY_CLEANUP_PENDING",
        nextSafeAction: warnings.length === 0
          ? disconnectPlan?.companion.remainingConsumers.length === 0
            ? "review-final-cleanup"
            : "none"
          : "recover-transaction"
      });
    }
    }
  );
}
