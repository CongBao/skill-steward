import {
  findingSchema,
  harnessIdSchema,
  sha256,
  severitySchema,
  skillScopeSchema
} from "@skill-steward/engine";
import { z } from "zod";

export const PREFLIGHT_SCHEMA_VERSION = 5 as const;

export interface IntlRuntimeVersions {
  cldr: string | undefined;
  icu: string | undefined;
  unicode: string | undefined;
}

const REFERENCE_INTL_RUNTIME = "cldr=48.0;icu=78.2;unicode=17.0";

export function algorithmVersionForIntlRuntime(runtime: IntlRuntimeVersions): number {
  const fingerprint = [
    `cldr=${runtime.cldr ?? "unknown"}`,
    `icu=${runtime.icu ?? "unknown"}`,
    `unicode=${runtime.unicode ?? "unknown"}`
  ].join(";");
  if (fingerprint === REFERENCE_INTL_RUNTIME) return 9;

  const runtimeHash = sha256(fingerprint).slice("sha256:".length, "sha256:".length + 12);
  return 9_000_000_000_000 + Number.parseInt(runtimeHash, 16);
}

export const PREFLIGHT_ALGORITHM_VERSION = algorithmVersionForIntlRuntime({
  cldr: process.versions.cldr,
  icu: process.versions.icu,
  unicode: process.versions.unicode
});

export const preflightReasonCodeSchema = z.enum([
  "TASK_TERM_MATCH",
  "NAME_MATCH",
  "HIGH_CONFIDENCE_TRIGGER",
  "PROJECT_SCOPE_FIT",
  "UNIQUE_COVERAGE",
  "REDUNDANT_WITH_SELECTED",
  "LOW_RELEVANCE",
  "PORTFOLIO_RISK",
  "INSTALL_REQUIRED",
  "CRITICAL_RISK",
  "HARNESS_INCOMPATIBLE",
  "HARNESS_SHADOWED",
  "HARNESS_INACTIVE",
  "HARNESS_AMBIGUOUS",
  "INVENTORY_RESCAN_REQUIRED",
  "NEGATIVE_TRIGGER",
  "CAPABILITY_MATCH",
  "EXACT_TRIGGER_MATCH",
  "MARGINAL_CAPABILITY",
  "REDUNDANT_CAPABILITY"
]);

export const preflightReasonSchema = z.object({
  code: preflightReasonCodeSchema,
  detail: z.string().min(1).max(200)
});

export const inventoryWarningSchema = z.object({
  code: z.literal("HARNESS_AMBIGUOUS"),
  harness: harnessIdSchema,
  detail: z.string().min(1).max(200).refine(
    (value) => !/[\\/]/u.test(value),
    "Inventory warnings cannot contain paths"
  )
}).strict();

export class PreflightError extends Error {
  constructor(
    public readonly code: "INVENTORY_RESCAN_REQUIRED"
  ) {
    super(code);
    this.name = "PreflightError";
  }
}

export const candidateAvailabilitySchema = z.enum(["installed", "available"]);
export const candidateDecisionSchema = z.enum(["use", "install", "excluded"]);
export const preflightIdentifierSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/u,
  "Preflight identifiers must be safe ASCII and at most 96 characters"
);

export const preflightCandidateFeatureSchema = z.object({
  taskCoverage: z.number().min(0).max(1),
  skillPrecision: z.number().min(0).max(1),
  nameMatch: z.boolean(),
  projectScopeFit: z.boolean(),
  capabilityCoverage: z.number().min(0).max(1),
  capabilityPrecision: z.number().min(0).max(1),
  triggerConfidence: z.enum(["none", "partial", "exact"])
}).strict();

const candidateSourceSchema = z.object({
  sourceId: z.string().min(1),
  trust: z.enum(["vendor", "community", "user"]),
  url: z.string().url(),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  relativePath: z.string().min(1)
});

export const preflightCandidateSchema = z.object({
  candidateId: preflightIdentifierSchema,
  availability: candidateAvailabilitySchema,
  installedSkillId: preflightIdentifierSchema.optional(),
  catalogSkillId: preflightIdentifierSchema.optional(),
  name: z.string().min(1),
  description: z.string(),
  scope: skillScopeSchema,
  compatibleHarnesses: z.array(harnessIdSchema),
  compatibility: z.enum(["declared", "portable", "unknown"]),
  scripts: z.array(z.string()),
  executables: z.array(z.string()),
  highestSeverity: severitySchema.nullable(),
  relevance: z.number().min(0).max(1),
  uniqueCoverage: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
  redundancyPenalty: z.number().min(0).max(1),
  installPenalty: z.number().min(0).max(1),
  contextTokens: z.number().int().nonnegative(),
  features: preflightCandidateFeatureSchema,
  decision: candidateDecisionSchema,
  source: candidateSourceSchema.optional(),
  reasons: z.array(preflightReasonSchema).min(1).max(12)
}).superRefine((candidate, context) => {
  if (candidate.availability === "installed") {
    if (candidate.installedSkillId !== candidate.candidateId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Installed candidate identity must match its candidate ID",
        path: ["installedSkillId"]
      });
    }
    if (candidate.catalogSkillId || candidate.source || candidate.decision === "install") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Installed candidates cannot carry catalog identity or install decisions"
      });
    }
  } else {
    if (candidate.catalogSkillId !== candidate.candidateId || !candidate.source) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Available candidates require matching catalog identity and source"
      });
    }
    if (candidate.installedSkillId || candidate.decision === "use") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Available candidates cannot carry installed identity or use decisions"
      });
    }
  }
});

export const preflightRequestSchema = z.object({
  task: z.string().transform((value) => value.trim()).pipe(
    z.string().max(20_000).refine(
      (value) => value.replace(/\s/g, "").length >= 8,
      "Task must contain at least 8 non-whitespace characters"
    )
  ),
  maxSkills: z.number().int().min(1).max(5).default(5),
  harness: harnessIdSchema.optional(),
  includeAvailable: z.boolean().default(true)
});

export const preflightFeedbackSchema = z.object({
  label: z.enum(["useful", "incomplete", "incorrect"]),
  candidateIds: z.array(z.string().min(1)).max(8).refine(
    (ids) => new Set(ids).size === ids.length,
    "Candidate IDs must be unique"
  )
});

export const preflightResultSchema = z.object({
  schemaVersion: z.literal(PREFLIGHT_SCHEMA_VERSION),
  algorithmVersion: z.literal(PREFLIGHT_ALGORITHM_VERSION),
  id: preflightIdentifierSchema,
  generatedAt: z.string().datetime(),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskCharacterCount: z.number().int().nonnegative(),
  taskTermCount: z.number().int().nonnegative(),
  useCandidateIds: z.array(preflightIdentifierSchema).max(5),
  installCandidateIds: z.array(preflightIdentifierSchema).max(3),
  candidates: z.array(preflightCandidateSchema),
  conflicts: z.array(findingSchema),
  inventoryWarnings: z.array(inventoryWarningSchema).max(3),
  capabilityGaps: z.array(z.string().min(1)).max(6),
  installedCoverage: z.number().min(0).max(1),
  projectedCoverage: z.number().min(0).max(1),
  selectedContextTokens: z.number().int().nonnegative(),
  plausibleContextTokens: z.number().int().nonnegative(),
  estimatedContextSaved: z.number().int().nonnegative()
}).superRefine((result, context) => {
  const ids = result.candidates.map(({ candidateId }) => candidateId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate IDs must be unique" });
  }
  const useIds = new Set(result.useCandidateIds);
  const installIds = new Set(result.installCandidateIds);
  if (useIds.size !== result.useCandidateIds.length || installIds.size !== result.installCandidateIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Decision ID lists must be unique" });
  }
  if ([...useIds].some((id) => installIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Use and install decisions cannot overlap" });
  }
  for (const candidate of result.candidates) {
    const expected = candidate.decision === "use"
      ? useIds.has(candidate.candidateId)
      : candidate.decision === "install"
        ? installIds.has(candidate.candidateId)
        : !useIds.has(candidate.candidateId) && !installIds.has(candidate.candidateId);
    if (!expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Candidate decisions must match decision ID lists",
        path: ["candidates", candidate.candidateId]
      });
    }
  }
  const candidateIds = new Set(ids);
  if ([...useIds, ...installIds].some((id) => !candidateIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Decision ID references an unknown candidate" });
  }
  if (result.projectedCoverage < result.installedCoverage) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Projected coverage cannot be lower than installed coverage" });
  }
});

export type CandidateAvailability = z.infer<typeof candidateAvailabilitySchema>;
export type CandidateDecision = z.infer<typeof candidateDecisionSchema>;
export type PreflightReasonCode = z.infer<typeof preflightReasonCodeSchema>;
export type PreflightReason = z.infer<typeof preflightReasonSchema>;
export type InventoryWarning = z.infer<typeof inventoryWarningSchema>;
export type PreflightCandidateFeature = z.infer<typeof preflightCandidateFeatureSchema>;
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;
export type PreflightFeedback = z.infer<typeof preflightFeedbackSchema>;
export type PreflightCandidate = z.infer<typeof preflightCandidateSchema>;
export type PreflightResult = z.infer<typeof preflightResultSchema>;
