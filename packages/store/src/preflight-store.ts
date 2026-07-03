import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  preflightFeedbackSchema,
  preflightResultSchema,
  type PreflightFeedback,
  type PreflightResult
} from "@skill-steward/preflight";
import { z } from "zod";

const PREFLIGHT_FILE = "preflights.json";

const evidenceCandidateSchema = z.object({
  skillId: z.string().min(1),
  relevance: z.number().min(0).max(1),
  uniqueCoverage: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
  redundancyPenalty: z.number().min(0).max(1),
  contextTokens: z.number().int().nonnegative(),
  decision: z.enum(["selected", "excluded"])
});

const evidenceFeedbackSchema = z.object({
  label: z.enum(["useful", "incomplete", "incorrect"]),
  selectedSkillIds: z.array(z.string().min(1)).max(5),
  createdAt: z.string().datetime()
});

const evidenceRecordSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  algorithmVersion: z.number().int().positive(),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskCharacterCount: z.number().int().nonnegative(),
  taskTermCount: z.number().int().nonnegative(),
  selectedSkillIds: z.array(z.string().min(1)).max(5),
  candidates: z.array(evidenceCandidateSchema),
  selectedContextTokens: z.number().int().nonnegative(),
  plausibleContextTokens: z.number().int().nonnegative(),
  estimatedContextSaved: z.number().int().nonnegative(),
  feedback: evidenceFeedbackSchema.optional()
});

const evidenceFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(evidenceRecordSchema)
});

export type PreflightEvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export class PreflightEvidenceError extends Error {
  constructor(
    public readonly code:
      | "PREFLIGHT_NOT_FOUND"
      | "INVALID_FEEDBACK_SKILL",
    message: string
  ) {
    super(message);
    this.name = "PreflightEvidenceError";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readFileState(
  stateDirectory: string
): Promise<{ schemaVersion: 1; records: PreflightEvidenceRecord[] }> {
  try {
    const source = await readFile(join(stateDirectory, PREFLIGHT_FILE), "utf8");
    return evidenceFileSchema.parse(JSON.parse(source));
  } catch (error) {
    if (isMissing(error)) return { schemaVersion: 1, records: [] };
    throw error;
  }
}

async function atomicWrite(
  stateDirectory: string,
  records: PreflightEvidenceRecord[]
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, PREFLIGHT_FILE);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const payload = evidenceFileSchema.parse({ schemaVersion: 1, records });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

function sanitize(result: PreflightResult): PreflightEvidenceRecord {
  const parsed = preflightResultSchema.parse(result);
  return evidenceRecordSchema.parse({
    id: parsed.id,
    createdAt: parsed.generatedAt,
    algorithmVersion: parsed.algorithmVersion,
    portfolioFingerprint: parsed.portfolioFingerprint,
    taskHash: parsed.taskHash,
    taskCharacterCount: parsed.taskCharacterCount,
    taskTermCount: parsed.taskTermCount,
    selectedSkillIds: parsed.selectedSkillIds,
    candidates: parsed.candidates.map(
      ({
        skillId,
        relevance,
        uniqueCoverage,
        riskPenalty,
        redundancyPenalty,
        contextTokens,
        decision
      }) => ({
        skillId,
        relevance,
        uniqueCoverage,
        riskPenalty,
        redundancyPenalty,
        contextTokens,
        decision
      })
    ),
    selectedContextTokens: parsed.selectedContextTokens,
    plausibleContextTokens: parsed.plausibleContextTokens,
    estimatedContextSaved: parsed.estimatedContextSaved
  });
}

export async function appendPreflightEvidence(
  stateDirectory: string,
  result: PreflightResult,
  options: { limit?: number } = {}
): Promise<void> {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Preflight evidence limit must be a positive integer");
  }
  const record = sanitize(result);
  const current = await readFileState(stateDirectory);
  const records = [
    record,
    ...current.records.filter(({ id }) => id !== record.id)
  ].slice(0, limit);
  await atomicWrite(stateDirectory, records);
}

export async function recordPreflightFeedback(
  stateDirectory: string,
  id: string,
  feedback: PreflightFeedback,
  now: Date
): Promise<void> {
  const parsed = preflightFeedbackSchema.parse(feedback);
  const current = await readFileState(stateDirectory);
  const index = current.records.findIndex((record) => record.id === id);
  if (index < 0) {
    throw new PreflightEvidenceError(
      "PREFLIGHT_NOT_FOUND",
      "Preflight evidence was not found"
    );
  }
  const record = current.records[index];
  if (!record) {
    throw new PreflightEvidenceError(
      "PREFLIGHT_NOT_FOUND",
      "Preflight evidence was not found"
    );
  }
  const candidateIds = new Set(record.candidates.map(({ skillId }) => skillId));
  if (parsed.selectedSkillIds.some((skillId) => !candidateIds.has(skillId))) {
    throw new PreflightEvidenceError(
      "INVALID_FEEDBACK_SKILL",
      "Feedback contains a Skill outside the preflight result"
    );
  }

  const updated = evidenceRecordSchema.parse({
    ...record,
    feedback: {
      ...parsed,
      createdAt: now.toISOString()
    }
  });
  const records = [...current.records];
  records[index] = updated;
  await atomicWrite(stateDirectory, records);
}

export async function readPreflightEvidence(
  stateDirectory: string
): Promise<PreflightEvidenceRecord[]> {
  return (await readFileState(stateDirectory)).records;
}
