import { resolve } from "node:path";
import {
  aggregateEvidence,
  evidenceDatasetSchema,
  type EvidenceDataset
} from "@skill-steward/evidence";
import { readInstallationHistory } from "@skill-steward/installer";
import { preflightFeedbackSchema } from "@skill-steward/preflight";
import {
  applyEvidenceErasePlan,
  applyEvidencePolicyPlan,
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
  compactEvidenceEvents,
  evidenceErasePlanSchema,
  evidencePolicyPlanSchema,
  planEvidenceErase,
  planEvidencePolicyChange,
  readEvidenceEvents,
  readNormalizedPreflightEvidence,
  readEvidencePolicy,
  recordPreflightFeedback,
  ReviewedPlanStoreError,
  writeReviewedPlan,
  writeEvidenceExport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import {
  matchesReviewedPlanIdentity,
  reviewedPlanRetryHint
} from "../reviewed-plan.js";

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `${error.code}: ${error.message}${reviewedPlanRetryHint(error.code)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

class EvidenceReviewedPlanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EvidenceReviewedPlanError";
  }
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

function policyApplyCommand(id: string): string {
  return `skill-steward evidence policy set --plan ${id} --confirm`;
}

function eraseApplyCommand(id: string): string {
  return `skill-steward evidence erase --plan ${id} --confirm`;
}

function integer(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

export async function readLocalEvidenceDataset(stateDirectory: string): Promise<EvidenceDataset> {
  const [preflights, events, installations] = await Promise.all([
    readNormalizedPreflightEvidence(stateDirectory),
    readEvidenceEvents(stateDirectory),
    readInstallationHistory(stateDirectory)
  ]);
  return evidenceDatasetSchema.parse({
    schemaVersion: 1,
    preflights,
    events,
    installations: installations
      .filter((record) => record.status === "installed" && record.provenance)
      .map((record) => ({
        schemaVersion: 1,
        id: record.id,
        createdAt: record.createdAt,
        preflightId: record.provenance!.preflightId,
        candidateId: record.provenance!.candidateId
      }))
  });
}

export async function evidencePolicyCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const policy = await readEvidencePolicy(context.stateDir);
    context.stdout(json
      ? `${JSON.stringify(policy, null, 2)}\n`
      : `Evidence policy: ${policy.mode}, ${policy.retentionDays} days, ${policy.maxEvents} events\n`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidencePolicySetCommand(
  options: {
    mode?: string;
    retentionDays?: string;
    maxEvents?: string;
    plan?: string;
    confirm: boolean;
    json: boolean;
  },
  context: CliContext
): Promise<number> {
  try {
    const now = context.now?.() ?? new Date();
    const hasRequest = options.mode !== undefined
      || options.retentionDays !== undefined
      || options.maxEvents !== undefined;
    if (options.plan !== undefined) {
      if (!options.confirm) {
        throw new EvidenceReviewedPlanError(
          "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
          "Use --confirm with the reviewed plan ID"
        );
      }
      if (hasRequest) {
        throw new EvidenceReviewedPlanError(
          "REVIEWED_PLAN_AMBIGUOUS",
          "Apply accepts only --plan <id> --confirm; request options are ambiguous"
        );
      }
      const envelope = await claimReviewedPlan(context.stateDir, {
        id: options.plan,
        kind: "evidence-policy",
        now
      });
      const parsed = evidencePolicyPlanSchema.safeParse(envelope.payload);
      if (!parsed.success || !matchesReviewedPlanIdentity(envelope, parsed.data)) {
        throw new EvidenceReviewedPlanError(
          "REVIEWED_PLAN_INVALID",
          "Stored evidence policy payload or identity is invalid"
        );
      }
      const policy = await applyEvidencePolicyPlan(context.stateDir, parsed.data, { now });
      context.stdout(options.json
        ? `${JSON.stringify({ ...policy, planId: envelope.id }, null, 2)}\n`
        : `Evidence policy updated to ${policy.mode} (plan ${envelope.id}).\n`
      );
      return 0;
    }
    if (options.confirm) {
      throw new EvidenceReviewedPlanError(
        "REVIEWED_PLAN_REQUIRED",
        "--confirm requires --plan <id>; run the policy set request first to preview it"
      );
    }
    if (
      options.mode === undefined
      || options.retentionDays === undefined
      || options.maxEvents === undefined
    ) {
      throw new EvidenceReviewedPlanError(
        "REVIEWED_PLAN_PREVIEW_REQUIRED",
        "Preview requires --mode, --retention-days, and --max-events"
      );
    }
    if (options.mode !== "minimal" && options.mode !== "learning") {
      throw new Error("mode must be minimal or learning");
    }
    await cleanupReviewedPlans(context, now);
    const plan = await planEvidencePolicyChange(context.stateDir, {
      mode: options.mode,
      retentionDays: integer(options.retentionDays, "retention-days"),
      maxEvents: integer(options.maxEvents, "max-events")
    }, { now });
    await writeReviewedPlan(context.stateDir, {
      schemaVersion: 1,
      id: plan.id,
      kind: "evidence-policy",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
    const applyCommand = policyApplyCommand(plan.id);
    context.stdout(options.json
      ? `${JSON.stringify({ ...plan, planId: plan.id, applyCommand }, null, 2)}\n`
      : [
          "Evidence policy plan:",
          `Mode: ${plan.before.mode} -> ${plan.after.mode}`,
          `Retention days: ${plan.before.retentionDays} -> ${plan.after.retentionDays}`,
          `Max events: ${plan.before.maxEvents} -> ${plan.after.maxEvents}`,
          `Plan ID: ${plan.id}`,
          `Expires: ${plan.expiresAt}`,
          `Apply: ${applyCommand}`,
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidenceSummaryCommand(
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const summary = aggregateEvidence(
      await readLocalEvidenceDataset(context.stateDir),
      context.now?.() ?? new Date()
    );
    context.stdout(json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : [
          `Evidence: ${summary.totals.labeled}/${summary.totals.preflights} labeled preflights`,
          `Readiness: ${summary.readiness.status}`,
          ...summary.readiness.reasons.map((reason) => `- ${reason}`),
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidenceFeedbackCommand(
  options: {
    preflight: string;
    label: string;
    candidates: string[];
    json: boolean;
  },
  context: CliContext
): Promise<number> {
  try {
    const label = preflightFeedbackSchema.shape.label.parse(options.label);
    let candidateIds = options.candidates;
    if (candidateIds.length === 0 && label === "useful") {
      const preflight = (await readNormalizedPreflightEvidence(context.stateDir))
        .find((record) => record.id === options.preflight);
      candidateIds = preflight
        ? [...preflight.useCandidateIds, ...preflight.installCandidateIds]
        : [];
    }
    if (candidateIds.length === 0 && label === "incomplete") {
      throw new Error("--candidate must provide the complete correct candidate set for incomplete feedback");
    }
    const feedback = preflightFeedbackSchema.parse({
      label,
      candidateIds
    });
    await recordPreflightFeedback(
      context.stateDir,
      options.preflight,
      feedback,
      context.now?.() ?? new Date()
    );
    context.stdout(options.json
      ? `${JSON.stringify({
          recorded: true,
          preflightId: options.preflight,
          ...feedback
        }, null, 2)}\n`
      : `Feedback recorded for Preflight ${options.preflight}.\n`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidenceExportCommand(
  output: string,
  replace: boolean,
  context: CliContext
): Promise<number> {
  try {
    const path = resolve(context.cwd, output);
    await writeEvidenceExport(path, await readLocalEvidenceDataset(context.stateDir), { replace });
    context.stdout(`Evidence exported to ${path}.\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidenceCompactCommand(context: CliContext): Promise<number> {
  try {
    const result = await compactEvidenceEvents(
      context.stateDir,
      await readEvidencePolicy(context.stateDir),
      context.now?.() ?? new Date()
    );
    context.stdout(`Evidence compacted: ${result.kept} kept, ${result.removed} removed.\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function evidenceEraseCommand(
  options: { plan?: string; confirm: boolean; json: boolean },
  context: CliContext
): Promise<number> {
  try {
    const now = context.now?.() ?? new Date();
    if (options.plan !== undefined) {
      if (!options.confirm) {
        throw new EvidenceReviewedPlanError(
          "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
          "Use --confirm with the reviewed plan ID"
        );
      }
      const envelope = await claimReviewedPlan(context.stateDir, {
        id: options.plan,
        kind: "evidence-erase",
        now
      });
      const parsed = evidenceErasePlanSchema.safeParse(envelope.payload);
      if (!parsed.success || !matchesReviewedPlanIdentity(envelope, parsed.data)) {
        throw new EvidenceReviewedPlanError(
          "REVIEWED_PLAN_INVALID",
          "Stored evidence erase payload or identity is invalid"
        );
      }
      await applyEvidenceErasePlan(context.stateDir, parsed.data, { now });
      context.stdout(options.json
        ? `${JSON.stringify({ erased: true, planId: envelope.id }, null, 2)}\n`
        : `Local evidence records and salt erased (plan ${envelope.id}).\n`
      );
      return 0;
    }
    if (options.confirm) {
      throw new EvidenceReviewedPlanError(
        "REVIEWED_PLAN_REQUIRED",
        "--confirm requires --plan <id>; run evidence erase first to preview it"
      );
    }
    await cleanupReviewedPlans(context, now);
    const plan = await planEvidenceErase(context.stateDir, {
      now
    });
    await writeReviewedPlan(context.stateDir, {
      schemaVersion: 1,
      id: plan.id,
      kind: "evidence-erase",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
    const applyCommand = eraseApplyCommand(plan.id);
    context.stdout(options.json
      ? `${JSON.stringify({ ...plan, planId: plan.id, applyCommand }, null, 2)}\n`
      : [
          ...plan.paths.map(({ kind, path, exists }) =>
            `- ${kind}: ${path} (${exists ? "present" : "absent"})`
          ),
          `Plan ID: ${plan.id}`,
          `Expires: ${plan.expiresAt}`,
          `Apply: ${applyCommand}`,
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
