import {
  harnessIdSchema,
  type HarnessId
} from "@skill-steward/engine";
import { z } from "zod";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z.string().min(1).max(256);
const dateTimeSchema = z.string().datetime();
const countSchema = z.number().int().nonnegative();
const probabilitySchema = z.number().min(0).max(1);

export const pseudonymousKeySchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
type EvidenceHarnessId = Exclude<HarnessId, "claude"> | "claude-code";
const evidenceHarnessIds = harnessIdSchema.options.map((harness) =>
  harness === "claude" ? "claude-code" : harness
) as [EvidenceHarnessId, ...EvidenceHarnessId[]];
export const evidenceHarnessSchema = z.enum(evidenceHarnessIds);
export const evidenceDeliverySchema = z.enum(["cli", "dashboard", "hook"]);
export const evidenceModeSchema = z.enum(["minimal", "learning"]);

export function normalizeEvidenceHarness(harness: string | undefined): EvidenceHarness | undefined {
  const parsed = evidenceHarnessSchema.safeParse(
    harness === "claude" ? "claude-code" : harness
  );
  return parsed.success ? parsed.data : undefined;
}

export const evidencePolicySchema = z.object({
  schemaVersion: z.literal(1),
  mode: evidenceModeSchema,
  retentionDays: z.number().int().min(7).max(365),
  maxEvents: z.number().int().min(100).max(10_000)
}).strict();

export const candidateFeatureSnapshotSchema = z.object({
  candidateId: identifierSchema,
  availability: z.enum(["installed", "available"]),
  taskCoverage: probabilitySchema,
  skillPrecision: probabilitySchema,
  nameMatch: z.boolean(),
  projectScopeFit: z.boolean(),
  relevance: probabilitySchema,
  uniqueCoverage: probabilitySchema,
  riskPenalty: probabilitySchema,
  redundancyPenalty: probabilitySchema,
  installPenalty: probabilitySchema,
  contextTokens: countSchema,
  decision: z.enum(["use", "install", "excluded"])
}).strict();

const uniqueCandidateIdsSchema = z.array(identifierSchema).max(8).refine(
  (ids) => new Set(ids).size === ids.length,
  "Candidate IDs must be unique"
);

export const evidenceFeedbackSchema = z.object({
  schemaVersion: z.literal(1),
  preflightId: identifierSchema,
  recordedAt: dateTimeSchema,
  label: z.enum(["useful", "incomplete", "incorrect"]),
  candidateIds: uniqueCandidateIdsSchema
}).strict();

export const evidencePreflightSchema = z.object({
  schemaVersion: z.literal(3),
  id: identifierSchema,
  createdAt: dateTimeSchema,
  portfolioFingerprint: sha256Schema,
  taskHash: sha256Schema,
  taskCharacterCount: countSchema,
  taskTermCount: countSchema,
  algorithmVersion: z.number().int().positive(),
  harness: evidenceHarnessSchema.optional(),
  delivery: evidenceDeliverySchema.optional(),
  candidateIds: z.array(identifierSchema).max(6_000),
  useCandidateIds: z.array(identifierSchema).max(5),
  installCandidateIds: z.array(identifierSchema).max(3),
  candidateFeatures: z.array(candidateFeatureSnapshotSchema).optional(),
  feedback: evidenceFeedbackSchema.optional()
}).strict().superRefine((record, context) => {
  const useIds = new Set(record.useCandidateIds);
  const installIds = new Set(record.installCandidateIds);
  const candidateIds = new Set(record.candidateIds);
  if (candidateIds.size !== record.candidateIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate IDs must be unique" });
  }
  if (useIds.size !== record.useCandidateIds.length || installIds.size !== record.installCandidateIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Decision candidate IDs must be unique" });
  }
  if ([...useIds].some((id) => installIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Use and install decisions cannot overlap" });
  }
  if ([...useIds, ...installIds].some((id) => !candidateIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Decisions must reference known candidates" });
  }
  if (record.candidateFeatures?.some(({ candidateId }) => !candidateIds.has(candidateId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Features must reference known candidates" });
  }
  if (record.feedback && record.feedback.preflightId !== record.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Feedback must reference its preflight" });
  }
});

const eventBase = {
  schemaVersion: z.literal(1),
  id: identifierSchema,
  createdAt: dateTimeSchema
};

const deliveryEventSchema = z.object({
  ...eventBase,
  kind: z.literal("preflight-delivered"),
  harness: evidenceHarnessSchema,
  preflightId: identifierSchema,
  algorithmVersion: z.number().int().positive(),
  sessionKey: pseudonymousKeySchema.optional(),
  turnKey: pseudonymousKeySchema.optional()
}).strict();

const turnEventSchema = z.object({
  ...eventBase,
  kind: z.literal("turn-finished"),
  harness: evidenceHarnessSchema,
  preflightId: identifierSchema.optional(),
  sessionKey: pseudonymousKeySchema.optional(),
  turnKey: pseudonymousKeySchema.optional(),
  reason: z.enum(["complete", "error", "abort", "timeout", "other"])
}).strict();

const sessionEventSchema = z.object({
  ...eventBase,
  kind: z.literal("session-ended"),
  harness: evidenceHarnessSchema,
  sessionKey: pseudonymousKeySchema.optional(),
  reason: z.enum(["complete", "error", "abort", "timeout", "user-exit", "other"])
}).strict();

const promptObservedEventSchema = z.object({
  ...eventBase,
  kind: z.literal("prompt-observed"),
  harness: evidenceHarnessSchema,
  sessionKey: pseudonymousKeySchema.optional()
}).strict();

const installationEventSchema = z.object({
  ...eventBase,
  kind: z.literal("installation-applied"),
  preflightId: identifierSchema,
  candidateId: identifierSchema,
  actionId: identifierSchema
}).strict();

const governanceEventSchema = z.object({
  ...eventBase,
  kind: z.literal("governance-applied"),
  actionId: identifierSchema,
  action: z.enum(["quarantine", "restore"]),
  skillId: identifierSchema
}).strict();

export const evidenceEventSchema = z.discriminatedUnion("kind", [
  deliveryEventSchema,
  turnEventSchema,
  sessionEventSchema,
  promptObservedEventSchema,
  installationEventSchema,
  governanceEventSchema
]);

export const evidenceInstallationSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifierSchema,
  createdAt: dateTimeSchema,
  preflightId: identifierSchema,
  candidateId: identifierSchema
}).strict();

export const evidenceMetricSchema = z.object({
  numerator: countSchema,
  denominator: countSchema,
  value: probabilitySchema.nullable()
}).strict().superRefine((metric, context) => {
  if (metric.denominator === 0) {
    if (metric.numerator !== 0 || metric.value !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Empty metrics must have a null value" });
    }
    return;
  }
  const expected = metric.numerator / metric.denominator;
  if (metric.numerator > metric.denominator || metric.value === null || Math.abs(metric.value - expected) > 1e-9) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Metric value must match its numerator and denominator" });
  }
});

export const evidenceMetricsSchema = z.object({
  feedbackRate: evidenceMetricSchema,
  usefulRate: evidenceMetricSchema,
  incompleteRate: evidenceMetricSchema,
  incorrectRate: evidenceMetricSchema,
  correctionPrecision: evidenceMetricSchema,
  correctionRecall: evidenceMetricSchema,
  correctionF1: evidenceMetricSchema,
  installConversion: evidenceMetricSchema
}).strict();

const evidenceTotalsSchema = z.object({
  preflights: countSchema,
  labeled: countSchema,
  portfolios: countSchema,
  events: countSchema
}).strict();

export const evidenceBreakdownSchema = z.object({
  key: z.string().min(1),
  totals: evidenceTotalsSchema,
  metrics: evidenceMetricsSchema
}).strict();

export const evidenceReadinessSchema = z.object({
  status: z.enum(["insufficient-evidence", "ready-for-calibration"]),
  reasons: z.array(z.string().min(1))
}).strict().superRefine((readiness, context) => {
  if (readiness.status === "ready-for-calibration" && readiness.reasons.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ready evidence cannot include missing-threshold reasons" });
  }
});

const lifecycleReasonSchema = z.enum(["complete", "error", "abort", "timeout", "user-exit", "other"]);

export const evidenceSummarySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: dateTimeSchema,
  period: z.object({
    from: dateTimeSchema.nullable(),
    to: dateTimeSchema.nullable()
  }).strict(),
  totals: evidenceTotalsSchema,
  metrics: evidenceMetricsSchema,
  lifecycleReasons: z.record(lifecycleReasonSchema, countSchema),
  harnesses: z.array(evidenceBreakdownSchema),
  algorithms: z.array(evidenceBreakdownSchema),
  windows: z.object({
    last7Days: evidenceBreakdownSchema,
    last30Days: evidenceBreakdownSchema
  }).strict(),
  readiness: evidenceReadinessSchema
}).strict();

export const evidenceDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  preflights: z.array(evidencePreflightSchema),
  events: z.array(evidenceEventSchema),
  installations: z.array(evidenceInstallationSchema)
}).strict();

export type PseudonymousKey = z.infer<typeof pseudonymousKeySchema>;
export type EvidenceHarness = z.infer<typeof evidenceHarnessSchema>;
export type EvidenceDelivery = z.infer<typeof evidenceDeliverySchema>;
export type EvidenceMode = z.infer<typeof evidenceModeSchema>;
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;
export type CandidateFeatureSnapshot = z.infer<typeof candidateFeatureSnapshotSchema>;
export type EvidenceFeedback = z.infer<typeof evidenceFeedbackSchema>;
export type EvidencePreflight = z.infer<typeof evidencePreflightSchema>;
export type EvidenceEvent = z.infer<typeof evidenceEventSchema>;
export type EvidenceInstallation = z.infer<typeof evidenceInstallationSchema>;
export type EvidenceMetric = z.infer<typeof evidenceMetricSchema>;
export type EvidenceMetrics = z.infer<typeof evidenceMetricsSchema>;
export type EvidenceBreakdown = z.infer<typeof evidenceBreakdownSchema>;
export type EvidenceReadiness = z.infer<typeof evidenceReadinessSchema>;
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;
export type EvidenceDataset = z.infer<typeof evidenceDatasetSchema>;
