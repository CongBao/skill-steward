import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  scanPortfolio,
  standardRoots
} from "@skill-steward/engine";
import {
  applyQuarantinePlan,
  applyRestorePlan,
  planQuarantine,
  planRestore,
  quarantinedSkillFromTransaction,
  readGovernanceTransactions,
  type GovernancePlan
} from "@skill-steward/governance";
import {
  appendEvidenceEvent,
  readLatestReport,
  writeLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import { terminalSafeText } from "../terminal.js";

class GovernCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GovernCommandError";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return terminalSafeText(`${error.code}: ${error.message}`);
  }
  return terminalSafeText(error instanceof Error ? error.message : String(error));
}

function printPlan(plan: GovernancePlan, json: boolean, context: CliContext): void {
  context.stdout(json
    ? `${JSON.stringify(plan, null, 2)}\n`
    : [
        `Governance plan: ${plan.kind} ${terminalSafeText(plan.skillName ?? basename(plan.activePath))}`,
        `Active: ${terminalSafeText(plan.activePath)}`,
        `Vault: ${terminalSafeText(plan.vaultPath)}`,
        `Fingerprint: ${terminalSafeText(plan.sourceFingerprint)}`,
        ...plan.operations.map(({ operation }) => `- ${terminalSafeText(operation)}`),
        "Rerun with --confirm to apply.",
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
  skillId: string,
  confirm: boolean,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const report = await readLatestReport(context.stateDir);
    const skill = report?.skills.find(({ id }) => id === skillId);
    if (!skill) throw new GovernCommandError("SKILL_NOT_FOUND", `Skill '${skillId}' was not found`);
    const plan = await planQuarantine({
      skill,
      activeRoots: standardRoots({ home: context.home, cwd: context.cwd }),
      stateDirectory: context.stateDir,
      now: context.now?.() ?? new Date()
    });
    if (!confirm) {
      printPlan(plan, json, context);
      return 0;
    }
    const result = await applyQuarantinePlan(plan, {
      stateDirectory: context.stateDir,
      ...(context.now ? { now: context.now } : {})
    });
    await rescan(context);
    await recordAction("quarantine", result.transaction.id, skill.id, context);
    context.stdout(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Quarantined '${terminalSafeText(skill.name)}' (${terminalSafeText(result.transaction.id)}).\n`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function governRestoreCommand(
  transactionId: string,
  confirm: boolean,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const transactions = await readGovernanceTransactions(context.stateDir);
    const source = transactions.find(({ id }) => id === transactionId);
    if (!source) {
      throw new GovernCommandError(
        "GOVERNANCE_TRANSACTION_NOT_FOUND",
        `Governance transaction '${transactionId}' was not found`
      );
    }
    const plan = await planRestore({
      quarantined: quarantinedSkillFromTransaction(source),
      activeRoots: standardRoots({ home: context.home, cwd: context.cwd }),
      stateDirectory: context.stateDir,
      now: context.now?.() ?? new Date()
    });
    if (!confirm) {
      printPlan(plan, json, context);
      return 0;
    }
    const result = await applyRestorePlan(plan, {
      stateDirectory: context.stateDir,
      ...(context.now ? { now: context.now } : {})
    });
    await rescan(context);
    await recordAction("restore", result.transaction.id, result.transaction.skillId, context);
    context.stdout(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Restored Skill '${terminalSafeText(result.transaction.skillName ?? basename(result.transaction.originalPath))}' (${terminalSafeText(result.transaction.id)}).\n`
    );
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
