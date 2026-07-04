import { sha256 } from "@skill-steward/engine";
import { z } from "zod";
import {
  preflightIdentifierSchema,
  preflightReasonCodeSchema,
  preflightResultSchema,
  type PreflightCandidate,
  type PreflightResult
} from "./domain.js";

export const COMPACT_PREFLIGHT_SCHEMA_VERSION = 1 as const;
export const COMPACT_PREFLIGHT_MAX_BYTES = 4_096 as const;

const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

const utf8String = (maxBytes: number) => z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= maxBytes,
  `String must be at most ${maxBytes} UTF-8 bytes`
);

const compactIdentifierSchema = preflightIdentifierSchema;
const compactCodeSchema = z.string().regex(STABLE_CODE);

export const compactPreflightRecommendationSchema = z.object({
  candidateId: compactIdentifierSchema,
  name: utf8String(48),
  contextTokens: z.number().int().nonnegative(),
  reasonCodes: z.array(preflightReasonCodeSchema).max(3)
}).strict();

export const compactPreflightResultSchema = z.object({
  schemaVersion: z.literal(COMPACT_PREFLIGHT_SCHEMA_VERSION),
  preflightId: compactIdentifierSchema,
  algorithmVersion: z.number().int().positive(),
  use: z.array(compactPreflightRecommendationSchema).max(5),
  install: z.array(compactPreflightRecommendationSchema).max(3),
  inventoryWarningCodes: z.array(compactCodeSchema).max(3),
  conflictWarningCodes: z.array(compactCodeSchema).max(4),
  capabilityGaps: z.array(utf8String(32)).max(6),
  installedCoverage: z.number().min(0).max(1),
  projectedCoverage: z.number().min(0).max(1),
  selectedContextTokens: z.number().int().nonnegative(),
  feedbackCommand: utf8String(256)
}).strict().superRefine((result, context) => {
  const expectedFeedbackCommand =
    `skill-steward evidence feedback --preflight ${result.preflightId} --label useful`;
  if (result.feedbackCommand !== expectedFeedbackCommand) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["feedbackCommand"],
      message: "Feedback command must reference the exact Preflight ID"
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > COMPACT_PREFLIGHT_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Compact Preflight exceeds ${COMPACT_PREFLIGHT_MAX_BYTES} UTF-8 bytes`
    });
  }
});

export type CompactPreflightRecommendation = z.infer<
  typeof compactPreflightRecommendationSchema
>;
export type CompactPreflightResult = z.infer<typeof compactPreflightResultSchema>;

export function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function compactText(value: string, maxBytes: number, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8(normalized, maxBytes).trim() || fallback;
}

function compactIdentifier(value: string): string {
  return compactIdentifierSchema.parse(value);
}

function compactCode(value: string): string {
  if (STABLE_CODE.test(value)) return value;
  return `CODE_${sha256(value).slice("sha256:".length, "sha256:".length + 59).toUpperCase()}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function recommendation(candidate: PreflightCandidate): CompactPreflightRecommendation {
  return {
    candidateId: compactIdentifier(candidate.candidateId),
    name: compactText(candidate.name, 48, "unnamed"),
    contextTokens: candidate.contextTokens,
    reasonCodes: unique(candidate.reasons.map(({ code }) => code)).slice(0, 3)
  };
}

function recommendations(
  result: PreflightResult,
  ids: string[]
): CompactPreflightRecommendation[] {
  const candidates = new Map(result.candidates.map((candidate) => [
    candidate.candidateId,
    candidate
  ]));
  return ids.flatMap((id) => {
    const candidate = candidates.get(id);
    return candidate ? [recommendation(candidate)] : [];
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function toCompactPreflight(input: PreflightResult): CompactPreflightResult {
  const result = preflightResultSchema.parse(input);
  const preflightId = compactIdentifier(result.id);
  const compact = {
    schemaVersion: COMPACT_PREFLIGHT_SCHEMA_VERSION,
    preflightId,
    algorithmVersion: result.algorithmVersion,
    use: recommendations(result, result.useCandidateIds),
    install: recommendations(result, result.installCandidateIds),
    inventoryWarningCodes: unique(result.inventoryWarnings.map(({ code }) =>
      compactCode(code)
    )).sort(compareCodeUnits).slice(0, 3),
    conflictWarningCodes: unique(result.conflicts.map(({ code }) =>
      compactCode(code)
    )).sort(compareCodeUnits).slice(0, 4),
    capabilityGaps: unique(result.capabilityGaps.map((gap) =>
      compactText(gap, 32, "unknown")
    )).slice(0, 6),
    installedCoverage: result.installedCoverage,
    projectedCoverage: result.projectedCoverage,
    selectedContextTokens: result.selectedContextTokens,
    feedbackCommand: `skill-steward evidence feedback --preflight ${preflightId} --label useful`
  } satisfies CompactPreflightResult;
  return compactPreflightResultSchema.parse(compact);
}
