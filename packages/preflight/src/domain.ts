import {
  findingSchema,
  harnessIdSchema,
  skillScopeSchema
} from "@skill-steward/engine";
import { z } from "zod";

export const PREFLIGHT_SCHEMA_VERSION = 1 as const;
export const PREFLIGHT_ALGORITHM_VERSION = 1 as const;

export const preflightReasonCodeSchema = z.enum([
  "TASK_TERM_MATCH",
  "NAME_MATCH",
  "PROJECT_SCOPE_FIT",
  "UNIQUE_COVERAGE",
  "REDUNDANT_WITH_SELECTED",
  "LOW_RELEVANCE",
  "PORTFOLIO_RISK"
]);

export const preflightReasonSchema = z.object({
  code: preflightReasonCodeSchema,
  detail: z.string().min(1)
});

export const preflightCandidateSchema = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  scope: skillScopeSchema,
  visibleTo: z.array(harnessIdSchema),
  relevance: z.number().min(0).max(1),
  uniqueCoverage: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
  redundancyPenalty: z.number().min(0).max(1),
  contextTokens: z.number().int().nonnegative(),
  decision: z.enum(["selected", "excluded"]),
  reasons: z.array(preflightReasonSchema).min(1)
});

export const preflightRequestSchema = z.object({
  task: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .max(20_000)
        .refine(
          (value) => value.replace(/\s/g, "").length >= 8,
          "Task must contain at least 8 non-whitespace characters"
        )
    ),
  maxSkills: z.number().int().min(1).max(5).default(5)
});

export const preflightFeedbackSchema = z.object({
  label: z.enum(["useful", "incomplete", "incorrect"]),
  selectedSkillIds: z
    .array(z.string().min(1))
    .max(5)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Selected Skill IDs must be unique"
    )
});

export const preflightResultSchema = z.object({
  schemaVersion: z.literal(PREFLIGHT_SCHEMA_VERSION),
  algorithmVersion: z.literal(PREFLIGHT_ALGORITHM_VERSION),
  id: z.string().min(1),
  generatedAt: z.string().datetime(),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskCharacterCount: z.number().int().nonnegative(),
  taskTermCount: z.number().int().nonnegative(),
  selectedSkillIds: z.array(z.string().min(1)).max(5),
  candidates: z.array(preflightCandidateSchema),
  conflicts: z.array(findingSchema),
  selectedContextTokens: z.number().int().nonnegative(),
  plausibleContextTokens: z.number().int().nonnegative(),
  estimatedContextSaved: z.number().int().nonnegative()
});

export type PreflightReasonCode = z.infer<typeof preflightReasonCodeSchema>;
export type PreflightReason = z.infer<typeof preflightReasonSchema>;
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;
export type PreflightFeedback = z.infer<typeof preflightFeedbackSchema>;
export type PreflightCandidate = z.infer<typeof preflightCandidateSchema>;
export type PreflightResult = z.infer<typeof preflightResultSchema>;
