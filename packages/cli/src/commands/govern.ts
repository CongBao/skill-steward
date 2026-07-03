import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  scanPortfolio,
  standardRoots
} from "@skill-steward/engine";
import {
  applyQuarantinePlan,
  applyRestorePlan,
  governancePlanSchema,
  planQuarantine,
  planRestore,
  quarantinedSkillFromTransaction,
  readGovernanceTransactions,
  type GovernancePlan
} from "@skill-steward/governance";
import {
  appendEvidenceEvent,
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
  readLatestReport,
  ReviewedPlanStoreError,
  writeReviewedPlan,
  writeLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import {
  applyClaimedReviewedPlan,
  matchesReviewedPlanIdentity,
  reviewedPlanRetryHint
} from "../reviewed-plan.js";
import { terminalSafeText } from "../terminal.js";

class GovernCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GovernCommandError";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return terminalSafeText(
      `${error.code}: ${error.message}${reviewedPlanRetryHint(error.code)}`
    );
  }
  return terminalSafeText(error instanceof Error ? error.message : String(error));
}

async function cleanupReviewedPlans(context: CliContext, now: Date): Promise<void> {
  try {
    await cleanupExpiredReviewedPlans(context.stateDir, now);
  } catch (error) {
    if (
      !(error instanceof ReviewedPlanStoreError)
      || error.code === "REVIEWED_PLAN_UNSAFE_STATE"
    ) {
      throw error;
    }
  }
}

function governanceApplyCommand(plan: GovernancePlan): string {
  return `skill-steward govern ${plan.kind} --plan ${plan.id} --confirm`;
}

function printPlan(plan: GovernancePlan, json: boolean, context: CliContext): void {
  const applyCommand = governanceApplyCommand(plan);
  context.stdout(json
    ? `${JSON.stringify({ ...plan, planId: plan.id, applyCommand }, null, 2)}\n`
    : [
        `Governance plan: ${plan.kind} ${terminalSafeText(plan.skillName ?? basename(plan.activePath))}`,
        `Active: ${terminalSafeText(plan.activePath)}`,
        `Vault: ${terminalSafeText(plan.vaultPath)}`,
        `Fingerprint: ${terminalSafeText(plan.sourceFingerprint)}`,
        ...plan.operations.map(({ operation }) => `- ${terminalSafeText(operation)}`),
        `Plan ID: ${plan.id}`,
        `Expires: ${plan.expiresAt}`,
        `Apply: ${applyCommand}`,
        ""
      ].join("\n")
  );
}

async function rescan(context: CliContext): Promise<void> {
  const report = await scanPortfolio(
    standardRoots({ home: context.home, cwd: context.cwd }),
    context.now?.() ?? new Date()
  );
  await writeLatestReport(context.stateDir, report);
}

interface PortfolioRefreshWarning {
  code: "PORTFOLIO_REFRESH_FAILED";
  message: string;
  recoveryCommand: "skill-steward scan";
}

type PortfolioRefreshResult = {
  refresh:
    | { status: "completed" }
    | { status: "failed"; recoveryCommand: "skill-steward scan" };
  warnings: PortfolioRefreshWarning[];
};

async function refreshAfterCommit(context: CliContext): Promise<PortfolioRefreshResult> {
  try {
    await rescan(context);
    return { refresh: { status: "completed" }, warnings: [] };
  } catch {
    const warning: PortfolioRefreshWarning = {
      code: "PORTFOLIO_REFRESH_FAILED",
      message: "The governance action committed, but the portfolio report was not refreshed.",
      recoveryCommand: "skill-steward scan"
    };
    context.stderr(
      `${warning.code}: ${warning.message} Run: ${warning.recoveryCommand}\n`
    );
    return {
      refresh: { status: "failed", recoveryCommand: warning.recoveryCommand },
      warnings: [warning]
    };
  }
}

async function recordAction(
  action: "quarantine" | "restore",
  actionId: string,
  skillId: string,
  context: CliContext
): Promise<void> {
  try {
    await appendEvidenceEvent(context.stateDir, {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: (context.now?.() ?? new Date()).toISOString(),
      kind: "governance-applied",
      actionId,
      action,
      skillId
    });
  } catch {
    // Governance has committed; optional evidence must not change the result.
  }
}

export async function governQuarantineCommand(
  options: { skill?: string; plan?: string; confirm: boolean; json: boolean },
  context: CliContext
): Promise<number> {
  try {
    const now = context.now?.() ?? new Date();
    if (options.plan !== undefined) {
      if (!options.confirm) {
        throw new GovernCommandError(
          "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
          "Use --confirm with the reviewed plan ID"
        );
      }
      if (options.skill !== undefined) {
        throw new GovernCommandError(
          "REVIEWED_PLAN_AMBIGUOUS",
          "Apply accepts only --plan <id> --confirm; --skill is ambiguous"
        );
      }
      const envelope = await claimReviewedPlan(context.stateDir, {
        id: options.plan,
        kind: "governance",
        now
      });
      const { plan, result } = await applyClaimedReviewedPlan(async () => {
        const parsed = governancePlanSchema.safeParse(envelope.payload);
        if (
          !parsed.success
          || parsed.data.kind !== "quarantine"
          || !matchesReviewedPlanIdentity(envelope, parsed.data)
        ) {
          throw new GovernCommandError(
            "REVIEWED_PLAN_INVALID",
            "Stored governance payload is not a valid quarantine plan"
          );
        }
        return {
          plan: parsed.data,
          result: await applyQuarantinePlan(parsed.data, {
            stateDirectory: context.stateDir,
            ...(context.now ? { now: context.now } : {})
          })
        };
      });
      const refreshResult = await refreshAfterCommit(context);
      await recordAction("quarantine", result.transaction.id, plan.skillId, context);
      context.stdout(options.json
        ? `${JSON.stringify({
            ...result,
            planId: envelope.id,
            ...refreshResult
          }, null, 2)}\n`
        : [
            `Quarantined '${terminalSafeText(plan.skillName ?? basename(plan.activePath))}' (${terminalSafeText(result.transaction.id)}).`,
            `Plan ID: ${envelope.id}`,
            ""
          ].join("\n")
      );
      return 0;
    }
    if (options.confirm) {
      throw new GovernCommandError(
        "REVIEWED_PLAN_REQUIRED",
        "--confirm requires --plan <id>; run govern quarantine --skill <id> first to preview it"
      );
    }
    if (options.skill === undefined) {
      throw new GovernCommandError(
        "REVIEWED_PLAN_PREVIEW_REQUIRED",
        "Preview requires --skill <id>"
      );
    }
    await cleanupReviewedPlans(context, now);
    const report = await readLatestReport(context.stateDir);
    const skill = report?.skills.find(({ id }) => id === options.skill);
    if (!skill) {
      throw new GovernCommandError("SKILL_NOT_FOUND", `Skill '${options.skill}' was not found`);
    }
    const plan = await planQuarantine({
      skill,
      activeRoots: standardRoots({ home: context.home, cwd: context.cwd }),
      stateDirectory: context.stateDir,
      now
    });
    await writeReviewedPlan(context.stateDir, {
      schemaVersion: 1,
      id: plan.id,
      kind: "governance",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
    printPlan(plan, options.json, context);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function governRestoreCommand(
  options: { transaction?: string; plan?: string; confirm: boolean; json: boolean },
  context: CliContext
): Promise<number> {
  try {
    const now = context.now?.() ?? new Date();
    if (options.plan !== undefined) {
      if (!options.confirm) {
        throw new GovernCommandError(
          "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
          "Use --confirm with the reviewed plan ID"
        );
      }
      if (options.transaction !== undefined) {
        throw new GovernCommandError(
          "REVIEWED_PLAN_AMBIGUOUS",
          "Apply accepts only --plan <id> --confirm; --transaction is ambiguous"
        );
      }
      const envelope = await claimReviewedPlan(context.stateDir, {
        id: options.plan,
        kind: "governance",
        now
      });
      const { result } = await applyClaimedReviewedPlan(async () => {
        const parsed = governancePlanSchema.safeParse(envelope.payload);
        if (
          !parsed.success
          || parsed.data.kind !== "restore"
          || !matchesReviewedPlanIdentity(envelope, parsed.data)
        ) {
          throw new GovernCommandError(
            "REVIEWED_PLAN_INVALID",
            "Stored governance payload is not a valid restore plan"
          );
        }
        return {
          result: await applyRestorePlan(parsed.data, {
            stateDirectory: context.stateDir,
            ...(context.now ? { now: context.now } : {})
          })
        };
      });
      const refreshResult = await refreshAfterCommit(context);
      await recordAction("restore", result.transaction.id, result.transaction.skillId, context);
      context.stdout(options.json
        ? `${JSON.stringify({
            ...result,
            planId: envelope.id,
            ...refreshResult
          }, null, 2)}\n`
        : [
            `Restored Skill '${terminalSafeText(result.transaction.skillName ?? basename(result.transaction.originalPath))}' (${terminalSafeText(result.transaction.id)}).`,
            `Plan ID: ${envelope.id}`,
            ""
          ].join("\n")
      );
      return 0;
    }
    if (options.confirm) {
      throw new GovernCommandError(
        "REVIEWED_PLAN_REQUIRED",
        "--confirm requires --plan <id>; run govern restore --transaction <id> first to preview it"
      );
    }
    if (options.transaction === undefined) {
      throw new GovernCommandError(
        "REVIEWED_PLAN_PREVIEW_REQUIRED",
        "Preview requires --transaction <id>"
      );
    }
    await cleanupReviewedPlans(context, now);
    const transactions = await readGovernanceTransactions(context.stateDir);
    const source = transactions.find(({ id }) => id === options.transaction);
    if (!source) {
      throw new GovernCommandError(
        "GOVERNANCE_TRANSACTION_NOT_FOUND",
        `Governance transaction '${options.transaction}' was not found`
      );
    }
    const plan = await planRestore({
      quarantined: quarantinedSkillFromTransaction(source),
      activeRoots: standardRoots({ home: context.home, cwd: context.cwd }),
      stateDirectory: context.stateDir,
      now
    });
    await writeReviewedPlan(context.stateDir, {
      schemaVersion: 1,
      id: plan.id,
      kind: "governance",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
    printPlan(plan, options.json, context);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function governHistoryCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const transactions = await readGovernanceTransactions(context.stateDir);
    context.stdout(json
      ? `${JSON.stringify(transactions, null, 2)}\n`
      : `${transactions.map(({ id, action, status, originalPath, skillName }) =>
          `${terminalSafeText(id)}: ${action} ${terminalSafeText(skillName ?? basename(originalPath))} (${status})`
        ).join("\n")}${transactions.length ? "\n" : "No governance transactions.\n"}`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
