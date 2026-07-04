import { randomUUID } from "node:crypto";
import type { SkillRoot } from "@skill-steward/engine";
import {
  applyQuarantinePlan,
  applyRestorePlan,
  planQuarantine,
  planRestore,
  quarantinedSkillFromTransaction,
  readGovernanceTransactions,
  type GovernanceApplyResult,
  type GovernancePlan,
  type GovernancePostCommitWarning,
  type GovernanceTransaction
} from "@skill-steward/governance";
import {
  appendEvidenceEvent,
  readLatestReport
} from "@skill-steward/store";

export class GovernanceServiceError extends Error {
  constructor(
    public readonly code:
      | "GOVERNANCE_PLAN_NOT_FOUND"
      | "GOVERNANCE_SKILL_NOT_FOUND"
      | "GOVERNANCE_TRANSACTION_NOT_FOUND"
      | "GOVERNANCE_ACTION_INVALID",
    message: string
  ) {
    super(message);
    this.name = "GovernanceServiceError";
  }
}

export type GovernancePlanRequest =
  | { action: "quarantine"; skillId: string }
  | { action: "restore"; transactionId: string };

export interface GovernanceServices {
  plan(request: GovernancePlanRequest): Promise<GovernancePlan>;
  apply(planId: string): Promise<GovernanceApplyResult>;
  transactions(): Promise<GovernanceTransaction[]>;
}

export interface GovernanceServiceOptions {
  stateDirectory: string;
  activeRoots: () => SkillRoot[] | Promise<SkillRoot[]>;
  afterCommit: () => void | Promise<void>;
  recordEvidence?: (result: GovernanceApplyResult) => void | Promise<void>;
  now?: () => Date;
}

export function createGovernanceServices(
  options: GovernanceServiceOptions
): GovernanceServices {
  const now = options.now ?? (() => new Date());
  const plans = new Map<string, GovernancePlan>();

  async function record(result: GovernanceApplyResult): Promise<void> {
    if (options.recordEvidence) {
      await options.recordEvidence(result);
      return;
    }
    await appendEvidenceEvent(options.stateDirectory, {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: now().toISOString(),
      kind: "governance-applied",
      actionId: result.transaction.id,
      action: result.transaction.action,
      skillId: result.transaction.skillId
    });
  }

  return {
    async plan(request) {
      let plan: GovernancePlan;
      if (request.action === "quarantine") {
        const report = await readLatestReport(options.stateDirectory);
        const skill = report?.skills.find(({ id }) => id === request.skillId);
        if (!skill) {
          throw new GovernanceServiceError(
            "GOVERNANCE_SKILL_NOT_FOUND",
            `Skill '${request.skillId}' was not found in the latest portfolio`
          );
        }
        plan = await planQuarantine({
          skill,
          activeRoots: await options.activeRoots(),
          stateDirectory: options.stateDirectory,
          now: now()
        });
      } else {
        const transaction = (await readGovernanceTransactions(options.stateDirectory))
          .find(({ id }) => id === request.transactionId);
        if (!transaction) {
          throw new GovernanceServiceError(
            "GOVERNANCE_TRANSACTION_NOT_FOUND",
            `Governance transaction '${request.transactionId}' was not found`
          );
        }
        plan = await planRestore({
          quarantined: quarantinedSkillFromTransaction(transaction),
          activeRoots: await options.activeRoots(),
          stateDirectory: options.stateDirectory,
          now: now()
        });
      }
      plans.set(plan.id, plan);
      return plan;
    },
    async apply(planId) {
      const plan = plans.get(planId);
      if (!plan) {
        throw new GovernanceServiceError(
          "GOVERNANCE_PLAN_NOT_FOUND",
          "Review a current governance plan before applying it"
        );
      }
      const activeRoots = await options.activeRoots();
      const result = plan.kind === "quarantine"
        ? await applyQuarantinePlan(plan, {
            stateDirectory: options.stateDirectory,
            activeRoots,
            now
          })
        : await applyRestorePlan(plan, {
            stateDirectory: options.stateDirectory,
            activeRoots,
            now
          });
      plans.delete(planId);
      const postCommitWarnings: GovernancePostCommitWarning[] = [];
      try {
        await options.afterCommit();
      } catch {
        postCommitWarnings.push({
          code: "GOVERNANCE_REFRESH_FAILED",
          message: "Portfolio refresh failed after governance committed"
        });
      }
      try {
        await record(result);
      } catch {
        postCommitWarnings.push({
          code: "GOVERNANCE_EVIDENCE_FAILED",
          message: "Evidence recording failed after governance committed"
        });
      }
      return postCommitWarnings.length === 0
        ? result
        : { ...result, postCommitWarnings };
    },
    transactions: () => readGovernanceTransactions(options.stateDirectory)
  };
}
