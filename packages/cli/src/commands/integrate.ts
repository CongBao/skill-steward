import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { scanInventory } from "@skill-steward/engine";
import {
  applyIntegrationPlan,
  CompanionSkillError,
  companionSkillDirectory,
  integrationHarnessSchema,
  integrationPlanSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan
} from "@skill-steward/integrations";
import {
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
  withIntegrationMutationLease,
  writeLatestReport,
  writeReviewedPlan,
  type ReviewedPlanEnvelope
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import {
  applyClaimedReviewedPlan,
  matchesReviewedPlanIdentity,
  reviewedPlanRetryHint
} from "../reviewed-plan.js";
import { terminalSafeText } from "../terminal.js";

const allHarnesses = ["codex", "claude-code", "github-copilot"] as const;

export interface IntegrateApplyOptions {
  plan?: string;
  harness?: string;
  confirm: boolean;
  json: boolean;
}

export interface IntegrateApplyDependencies {
  applyPlan: typeof applyIntegrationPlan;
  rollbackPlan: typeof rollbackIntegrationPlan;
  withLease: typeof withIntegrationMutationLease;
}

const integrateApplyDefaults: IntegrateApplyDependencies = {
  applyPlan: applyIntegrationPlan,
  rollbackPlan: rollbackIntegrationPlan,
  withLease: withIntegrationMutationLease
};

export interface IntegrateRemoveDependencies {
  remove: typeof removeIntegration;
  withLease: typeof withIntegrationMutationLease;
}

const integrateRemoveDefaults: IntegrateRemoveDependencies = {
  remove: removeIntegration,
  withLease: withIntegrationMutationLease
};

class IntegrateCommandError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrateCommandError";
  }
}

function packagedSkillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith(join("src", "commands"))
    ? resolve(moduleDirectory, "../../../integrations/assets/skill-steward-preflight")
    : resolve(moduleDirectory, "integrations/skill-steward-preflight");
}

function configOptions(context: CliContext): IntegrationConfigOptions {
  return {
    home: context.home,
    stateDirectory: context.stateDir,
    companionSourceDirectory: packagedSkillDirectory(),
    ...(context.now ? { now: context.now } : {})
  };
}

function printPlan(plan: IntegrationPlan, context: CliContext, json: boolean): void {
  const applyUnavailableReason = "COMPANION_TRANSACTION_NOT_ENABLED";
  if (json) {
    context.stdout(`${JSON.stringify({
      ...plan,
      planId: plan.id,
      applyAvailable: false,
      applyCommand: null,
      applyUnavailableReason
    }, null, 2)}\n`);
    return;
  }
  const lines = [
    `Harness integration plan: ${terminalSafeText(plan.harness)}`,
    `Target: ${terminalSafeText(plan.targetPath)}`,
    `Companion Skill: ${terminalSafeText(companionSkillDirectory(context.home))}`,
    ...plan.changes.map(({ operation, path }) =>
      `- ${terminalSafeText(operation)} ${terminalSafeText(path)}`
    ),
    `Plan ID: ${terminalSafeText(plan.id)}`,
    `Expires: ${plan.expiresAt}`,
    "Apply: unavailable until transaction-safe companion lifecycle support is enabled.",
    `Reason: ${applyUnavailableReason}`,
    ""
  ];
  context.stdout(lines.join("\n"));
}

function errorText(error: unknown): string {
  if (error instanceof CompanionSkillError) {
    return terminalSafeText(`${error.code}: ${error.message}`);
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return terminalSafeText(
      `${error.code}: ${error.message}${reviewedPlanRetryHint(error.code)}`
    );
  }
  return terminalSafeText(error instanceof Error ? error.message : String(error));
}

function parseStoredPlan(envelope: ReviewedPlanEnvelope<unknown>): IntegrationPlan {
  const parsed = integrationPlanSchema.safeParse(envelope.payload);
  if (!parsed.success || !matchesReviewedPlanIdentity(envelope, parsed.data)) {
    throw new IntegrateCommandError(
      "REVIEWED_PLAN_INVALID",
      "Stored integration plan or identity is invalid"
    );
  }
  return parsed.data;
}

async function initialReadinessScan(context: CliContext): Promise<void> {
  const report = await scanInventory(
    { home: context.home, cwd: context.cwd },
    context.now?.() ?? new Date()
  );
  await writeLatestReport(context.stateDir, report);
}

async function rollbackFailedReadiness(
  plan: IntegrationPlan,
  context: CliContext,
  readinessError: unknown,
  dependencies: IntegrateApplyDependencies
): Promise<never> {
  const failures: string[] = [];
  if (plan.changes.length > 0) {
    try {
      await dependencies.rollbackPlan(plan, configOptions(context));
    } catch (error) {
      failures.push(`configuration: ${errorText(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new IntegrateCommandError(
      "INTEGRATION_ROLLBACK_FAILED",
      `The initial readiness scan failed and rollback was incomplete (${failures.join("; ")}). Inspect integration status before retrying.`,
      { cause: readinessError }
    );
  }
  throw new IntegrateCommandError(
    "INTEGRATION_READINESS_FAILED",
    "The initial readiness scan failed; artifacts created by this apply were rolled back. Create a fresh plan after fixing local scan storage.",
    { cause: readinessError }
  );
}

export async function integratePlanCommand(
  inputHarness: string,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const now = context.now?.() ?? new Date();
    await cleanupExpiredReviewedPlans(context.stateDir, now);
    const harness = integrationHarnessSchema.parse(inputHarness);
    const plan = await planIntegration(harness, configOptions(context));
    const payload = integrationPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    await writeReviewedPlan(context.stateDir, {
      schemaVersion: 1,
      id: plan.id,
      kind: "integration",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload
    });
    printPlan(plan, context, json);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function integrateApplyCommand(
  options: IntegrateApplyOptions,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateApplyDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateApplyDefaults, ...dependencyOverrides };
  try {
    if (options.plan === undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_REQUIRED",
        "Integration apply requires --plan <id> --confirm; run integrate plan first"
      );
    }
    if (!options.confirm) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
        "Use --confirm with the reviewed integration plan ID"
      );
    }
    if (options.harness !== undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_AMBIGUOUS",
        "Apply accepts only --plan <id> --confirm; --harness is ambiguous"
      );
    }
    const transaction = await dependencies.withLease(context.stateDir, async () => {
      const envelope = await claimReviewedPlan(context.stateDir, {
        id: options.plan!,
        kind: "integration",
        now: context.now?.() ?? new Date()
      });
      const result = await applyClaimedReviewedPlan(async () => {
        const plan = parseStoredPlan(envelope);
        const record = await dependencies.applyPlan(plan, configOptions(context));
        try {
          await initialReadinessScan(context);
        } catch (error) {
          return rollbackFailedReadiness(plan, context, error, dependencies);
        }
        await integrationStatus(plan.harness, configOptions(context));
        return { plan, record };
      });
      return { envelope, result };
    });
    context.stdout(options.json
      ? `${JSON.stringify({ record: transaction.result.record, planId: transaction.envelope.id, readiness: "ready" }, null, 2)}\n`
      : [
          `Installed ${terminalSafeText(transaction.result.plan.harness)} integration (${terminalSafeText(transaction.result.record.id)}).`,
          `Plan ID: ${terminalSafeText(transaction.envelope.id)}`,
          "Initial portfolio scan: ready",
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function integrateStatusCommand(
  inputHarness: string | undefined,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const harnesses: IntegrationHarness[] = inputHarness
      ? [integrationHarnessSchema.parse(inputHarness)]
      : [...allHarnesses];
    const statuses = await Promise.all(
      harnesses.map((harness) => integrationStatus(harness, configOptions(context)))
    );
    const output = inputHarness ? statuses[0] : statuses;
    if (json) context.stdout(`${JSON.stringify(output, null, 2)}\n`);
    else context.stdout(`${statuses.map(({ harness, status, targetPath }) =>
      `${harness}: ${status} (${terminalSafeText(targetPath)})`
    ).join("\n")}\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function integrateRemoveCommand(
  inputHarness: string,
  confirm: boolean,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateRemoveDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateRemoveDefaults, ...dependencyOverrides };
  try {
    if (!confirm) throw new Error("Integration removal requires --confirm");
    const harness = integrationHarnessSchema.parse(inputHarness);
    const record = await dependencies.withLease(context.stateDir, async () => {
      const removed = await dependencies.remove(harness, configOptions(context));
      await integrationStatus(harness, configOptions(context));
      return removed;
    });
    context.stdout([
      `Removed ${harness} integration (${record.id}).`,
      "Shared companion Skill retained pending reviewed consumer-aware removal.",
      ""
    ].join("\n"));
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
