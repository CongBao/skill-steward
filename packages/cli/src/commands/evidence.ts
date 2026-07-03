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
  compactEvidenceEvents,
  planEvidenceErase,
  planEvidencePolicyChange,
  readEvidenceEvents,
  readNormalizedPreflightEvidence,
  readEvidencePolicy,
  recordPreflightFeedback,
  writeEvidenceExport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
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
    mode: string;
    retentionDays: string;
    maxEvents: string;
    confirm: boolean;
    json: boolean;
  },
  context: CliContext
): Promise<number> {
  try {
    if (options.mode !== "minimal" && options.mode !== "learning") {
      throw new Error("mode must be minimal or learning");
    }
    const plan = await planEvidencePolicyChange(context.stateDir, {
      mode: options.mode,
      retentionDays: integer(options.retentionDays, "retention-days"),
      maxEvents: integer(options.maxEvents, "max-events")
    }, { now: context.now?.() ?? new Date() });
    const result = options.confirm
      ? await applyEvidencePolicyPlan(context.stateDir, plan, {
          now: context.now?.() ?? new Date()
        })
      : plan;
    context.stdout(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : options.confirm
        ? `Evidence policy updated to ${plan.after.mode}.\n`
        : `Evidence policy plan: ${plan.before.mode} -> ${plan.after.mode}\nRerun with --confirm to apply.\n`
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
  confirm: boolean,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const plan = await planEvidenceErase(context.stateDir, {
      now: context.now?.() ?? new Date()
    });
    if (confirm) {
      await applyEvidenceErasePlan(context.stateDir, plan, {
        now: context.now?.() ?? new Date()
      });
    }
    const result = confirm ? { erased: true, planId: plan.id } : plan;
    context.stdout(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : confirm
        ? "Local evidence records and salt erased.\n"
        : `${plan.paths.map(({ kind, path, exists }) => `- ${kind}: ${path} (${exists ? "present" : "absent"})`).join("\n")}\nRerun with --confirm to erase.\n`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
