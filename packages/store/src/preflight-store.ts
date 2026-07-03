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
const MAX_RECORDS = 200;

const evidenceCandidateV1Schema = z.object({
  skillId: z.string().min(1),
  relevance: z.number().min(0).max(1),
  uniqueCoverage: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
  redundancyPenalty: z.number().min(0).max(1),
  contextTokens: z.number().int().nonnegative(),
  decision: z.enum(["selected", "excluded"])
});

const evidenceFeedbackV1Schema = z.object({
  label: z.enum(["useful", "incomplete", "incorrect"]),
  selectedSkillIds: z.array(z.string().min(1)).max(5),
  createdAt: z.string().datetime()
});

const evidenceRecordV1BodySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  algorithmVersion: z.literal(1),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskCharacterCount: z.number().int().nonnegative(),
  taskTermCount: z.number().int().nonnegative(),
  selectedSkillIds: z.array(z.string().min(1)).max(5),
  candidates: z.array(evidenceCandidateV1Schema),
  selectedContextTokens: z.number().int().nonnegative(),
  plausibleContextTokens: z.number().int().nonnegative(),
  estimatedContextSaved: z.number().int().nonnegative(),
  feedback: evidenceFeedbackV1Schema.optional()
});

const evidenceRecordV1Schema = evidenceRecordV1BodySchema.extend({
  schemaVersion: z.literal(1)
});

const evidenceCandidateV2Schema = z.object({
  candidateId: z.string().min(1),
  availability: z.enum(["installed", "available"]),
  relevance: z.number().min(0).max(1),
  uniqueCoverage: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
  redundancyPenalty: z.number().min(0).max(1),
  installPenalty: z.number().min(0).max(1),
  contextTokens: z.number().int().nonnegative(),
  decision: z.enum(["use", "install", "excluded"]),
  sourceId: z.string().min(1).optional()
});

const evidenceFeedbackV2Schema = z.object({
  label: z.enum(["useful", "incomplete", "incorrect"]),
  candidateIds: z.array(z.string().min(1)).max(8),
  createdAt: z.string().datetime()
});

const evidenceRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  algorithmVersion: z.literal(2),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskCharacterCount: z.number().int().nonnegative(),
  taskTermCount: z.number().int().nonnegative(),
  useCandidateIds: z.array(z.string().min(1)).max(5),
  installCandidateIds: z.array(z.string().min(1)).max(3),
  candidates: z.array(evidenceCandidateV2Schema),
  installedCoverage: z.number().min(0).max(1),
  projectedCoverage: z.number().min(0).max(1),
  selectedContextTokens: z.number().int().nonnegative(),
  estimatedContextSaved: z.number().int().nonnegative(),
  feedback: evidenceFeedbackV2Schema.optional()
});

const evidenceRecordSchema = z.discriminatedUnion("schemaVersion", [
  evidenceRecordV1Schema,
  evidenceRecordV2Schema
]);

const evidenceFileV1Schema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(evidenceRecordV1BodySchema).max(MAX_RECORDS)
});

const evidenceFileV2Schema = z.object({
  schemaVersion: z.literal(2),
  records: z.array(evidenceRecordSchema).max(MAX_RECORDS)
});

export type PreflightEvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export class PreflightEvidenceError extends Error {
  constructor(
    public readonly code:
      | "PREFLIGHT_NOT_FOUND"
      | "INVALID_FEEDBACK_CANDIDATE",
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
): Promise<{ schemaVersion: 2; records: PreflightEvidenceRecord[] }> {
  try {
    const source = await readFile(join(stateDirectory, PREFLIGHT_FILE), "utf8");
    const value: unknown = JSON.parse(source);
    if (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      value.schemaVersion === 1
    ) {
      const legacy = evidenceFileV1Schema.parse(value);
      return {
        schemaVersion: 2,
        records: legacy.records.map((record) =>
          evidenceRecordV1Schema.parse({ schemaVersion: 1, ...record })
        )
      };
    }
    return evidenceFileV2Schema.parse(value);
  } catch (error) {
    if (isMissing(error)) return { schemaVersion: 2, records: [] };
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
  const payload = evidenceFileV2Schema.parse({ schemaVersion: 2, records });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

function sanitize(result: PreflightResult): PreflightEvidenceRecord {
  const parsed = preflightResultSchema.parse(result);
  return evidenceRecordV2Schema.parse({
    schemaVersion: 2,
    id: parsed.id,
    createdAt: parsed.generatedAt,
    algorithmVersion: parsed.algorithmVersion,
    portfolioFingerprint: parsed.portfolioFingerprint,
    taskHash: parsed.taskHash,
    taskCharacterCount: parsed.taskCharacterCount,
    taskTermCount: parsed.taskTermCount,
    useCandidateIds: parsed.useCandidateIds,
    installCandidateIds: parsed.installCandidateIds,
    candidates: parsed.candidates.map(({
      candidateId,
      availability,
      relevance,
      uniqueCoverage,
      riskPenalty,
      redundancyPenalty,
      installPenalty,
      contextTokens,
      decision,
      source
    }) => ({
      candidateId,
      availability,
      relevance,
      uniqueCoverage,
      riskPenalty,
      redundancyPenalty,
      installPenalty,
      contextTokens,
      decision,
      ...(source ? { sourceId: source.sourceId } : {})
    })),
    installedCoverage: parsed.installedCoverage,
    projectedCoverage: parsed.projectedCoverage,
    selectedContextTokens: parsed.selectedContextTokens,
    estimatedContextSaved: parsed.estimatedContextSaved
  });
}

export async function appendPreflightEvidence(
  stateDirectory: string,
  result: PreflightResult,
  options: { limit?: number } = {}
): Promise<void> {
  const limit = options.limit ?? MAX_RECORDS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    throw new Error(`Preflight evidence limit must be between 1 and ${MAX_RECORDS}`);
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
  const record = current.records[index];
  if (index < 0 || !record) {
    throw new PreflightEvidenceError(
      "PREFLIGHT_NOT_FOUND",
      "Preflight evidence was not found"
    );
  }
  const candidateIds = new Set(
    record.schemaVersion === 1
      ? record.candidates.map(({ skillId }) => skillId)
      : record.candidates.map(({ candidateId }) => candidateId)
  );
  if (parsed.candidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
    throw new PreflightEvidenceError(
      "INVALID_FEEDBACK_CANDIDATE",
      "Feedback contains a candidate outside the preflight result"
    );
  }

  const updated: PreflightEvidenceRecord = record.schemaVersion === 1
    ? evidenceRecordV1Schema.parse({
        ...record,
        feedback: {
          label: parsed.label,
          selectedSkillIds: parsed.candidateIds,
          createdAt: now.toISOString()
        }
      })
    : evidenceRecordV2Schema.parse({
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
