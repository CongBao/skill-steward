import { z } from "zod";
import {
  openSpecToolDirectories,
  type OpenSpecToolId
} from "./tool-catalog.js";

export type HarnessId = "agents" | OpenSpecToolId | "unknown";

const harnessIds = [
  "agents",
  ...openSpecToolDirectories.map(({ id }) => id),
  "unknown"
] as [HarnessId, ...HarnessId[]];

export const harnessIdSchema = z.enum(harnessIds);

export const skillScopeSchema = z.enum(["global", "project", "unknown"]);
export const severitySchema = z.enum(["info", "warning", "error", "critical"]);

export const skillFileSchema = z.object({
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative()
});

export const skillRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  root: z.string().min(1),
  scope: skillScopeSchema,
  visibleTo: z.array(harnessIdSchema),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  files: z.array(skillFileSchema),
  estimatedTokens: z.number().int().nonnegative()
});

export const findingSchema = z.object({
  id: z.string().min(1),
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  severity: severitySchema,
  skillIds: z.array(z.string().min(1)),
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export const findingLabelSchema = z.object({
  findingId: z.string().min(1),
  label: z.enum(["useful", "incorrect", "unclear", "already-known"]),
  createdAt: z.string().datetime(),
  comment: z.string().max(2000).optional()
});

export const portfolioReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  skills: z.array(skillRecordSchema),
  findings: z.array(findingSchema)
});

export type SkillScope = z.infer<typeof skillScopeSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillRecord = z.infer<typeof skillRecordSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type FindingLabel = z.infer<typeof findingLabelSchema>;
export type PortfolioReport = z.infer<typeof portfolioReportSchema>;

export interface ParsedSkill extends SkillRecord {
  body: string;
}

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  visibleTo: HarnessId[];
}

export interface DiscoveredSkill {
  path: string;
  roots: SkillRoot[];
}

export interface ParseFailure {
  path: string;
  message: string;
}
