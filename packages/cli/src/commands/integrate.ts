import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import {
  applyIntegrationPlan,
  CompanionSkillError,
  companionSkillDirectory,
  installCompanionSkill,
  integrationHarnessSchema,
  integrationPlanSchema,
  integrationStatus,
  planIntegration,
  removeManagedCompanionSkill,
  removeIntegration,
  rethrowAfterIntegrationApplyFailure,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan
} from "@skill-steward/integrations";
import {
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
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
  removeCompanion: typeof removeManagedCompanionSkill;
}

const integrateApplyDefaults: IntegrateApplyDependencies = {
  removeCompanion: removeManagedCompanionSkill
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
    ...(context.now ? { now: context.now } : {})
  };
}

async function installSharedSkill(context: CliContext): Promise<{ created: boolean; path: string }> {
  return installCompanionSkill({
    home: context.home,
    sourceDirectory: packagedSkillDirectory()
  });
}

async function removeSharedSkillIfUnused(context: CliContext): Promise<void> {
  const active = await Promise.all(
    allHarnesses.map((harness) => integrationStatus(harness, configOptions(context)))
  );
  if (active.some(({ status }) => status === "installed" || status === "needs-trust")) return;
  await removeManagedCompanionSkill({
    home: context.home,
    sourceDirectory: packagedSkillDirectory()
  });
}

function printPlan(plan: IntegrationPlan, context: CliContext, json: boolean): void {
  const applyCommand = `skill-steward integrate apply --plan ${plan.id} --confirm`;
  if (json) {
    context.stdout(`${JSON.stringify({ ...plan, planId: plan.id, applyCommand }, null, 2)}\n`);
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
    ...(plan.changes.length > 0
      ? [`Apply: ${applyCommand}`]
      : ["Harness configuration already matches; apply still performs the readiness scan.", `Apply: ${applyCommand}`]),
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
  const report = await scanPortfolio(
    standardRoots({ home: context.home, cwd: context.cwd }),
    context.now?.() ?? new Date()
  );
  await writeLatestReport(context.stateDir, report);
}

async function rollbackFailedReadiness(
  plan: IntegrationPlan,
  installed: { created: boolean; path: string },
  context: CliContext,
  readinessError: unknown,
  dependencies: IntegrateApplyDependencies
): Promise<never> {
  const failures: string[] = [];
  if (plan.changes.length > 0) {
    try {
      await rollbackIntegrationPlan(plan, configOptions(context));
    } catch (error) {
      failures.push(`configuration: ${errorText(error)}`);
    }
  }
  if (installed.created && failures.length === 0) {
    try {
      const removed = await dependencies.removeCompanion({
        home: context.home,
        sourceDirectory: packagedSkillDirectory()
      });
      if (!removed) failures.push("companion Skill changed before rollback");
    } catch (error) {
      failures.push(`companion Skill: ${errorText(error)}`);
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
  dependencies: IntegrateApplyDependencies = integrateApplyDefaults
): Promise<number> {
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
    const envelope = await claimReviewedPlan(context.stateDir, {
      id: options.plan,
      kind: "integration",
      now: context.now?.() ?? new Date()
    });
    const result = await applyClaimedReviewedPlan(async () => {
      const plan = parseStoredPlan(envelope);
      const installed = await installSharedSkill(context);
      let applied = false;
      try {
        const record = await applyIntegrationPlan(plan, configOptions(context));
        applied = true;
        try {
          await initialReadinessScan(context);
        } catch (error) {
          return rollbackFailedReadiness(plan, installed, context, error, dependencies);
        }
        return { plan, record };
      } catch (error) {
        return rethrowAfterIntegrationApplyFailure({
          error,
          companionCreated: !applied && installed.created,
          removeCompanion: () => dependencies.removeCompanion({
              home: context.home,
              sourceDirectory: packagedSkillDirectory()
          })
        });
      }
    });
    context.stdout(options.json
      ? `${JSON.stringify({ record: result.record, planId: envelope.id, readiness: "ready" }, null, 2)}\n`
      : [
          `Installed ${terminalSafeText(result.plan.harness)} integration (${terminalSafeText(result.record.id)}).`,
          `Plan ID: ${terminalSafeText(envelope.id)}`,
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
  context: CliContext
): Promise<number> {
  try {
    if (!confirm) throw new Error("Integration removal requires --confirm");
    const harness = integrationHarnessSchema.parse(inputHarness);
    const record = await removeIntegration(harness, configOptions(context));
    await removeSharedSkillIfUnused(context);
    context.stdout(`Removed ${harness} integration (${record.id}).\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
