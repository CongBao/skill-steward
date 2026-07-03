import { findingSchema, harnessIdSchema } from "@skill-steward/engine";
import { z } from "zod";

const safeRelativePath = z.string().min(1).max(512).refine(
  (value) => !value.startsWith("/") && !value.startsWith("\\") &&
    value.split(/[\\/]/).every((segment) => segment && segment !== "." && segment !== ".."),
  "Catalog subdirectory must be a safe relative path"
);

const publicHttpsUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Catalog URL must use HTTPS" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Catalog URL must not contain credentials" });
  }
});

export const catalogTrustSchema = z.enum(["vendor", "community", "user"]);
export const catalogCompatibilitySchema = z.enum(["declared", "portable", "unknown"]);
export const catalogSourceStatusSchema = z.enum(["disabled", "ready", "stale", "error"]);

export const catalogSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(120),
  kind: z.literal("git"),
  url: publicHttpsUrl,
  ref: z.string().min(1).max(200).optional(),
  subdirectory: safeRelativePath.optional(),
  enabled: z.boolean(),
  trust: catalogTrustSchema,
  preset: z.boolean()
});

export const catalogSkillRecordSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  relativePath: safeRelativePath,
  name: z.string().min(1),
  description: z.string(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  estimatedTokens: z.number().int().nonnegative(),
  scripts: z.array(z.string()),
  executables: z.array(z.string()),
  findings: z.array(findingSchema),
  compatibleHarnesses: z.array(harnessIdSchema),
  compatibility: catalogCompatibilitySchema
});

export const catalogSourceStateSchema = z.object({
  sourceId: z.string().min(1),
  status: catalogSourceStatusSchema,
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  refreshedAt: z.string().datetime().optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional(),
  skillCount: z.number().int().nonnegative()
});

export const catalogSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  sources: z.array(catalogSourceStateSchema).max(5),
  skills: z.array(catalogSkillRecordSchema).max(5_000)
});

export type CatalogSource = z.infer<typeof catalogSourceSchema>;
export type CatalogSkillRecord = z.infer<typeof catalogSkillRecordSchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type CatalogTrust = z.infer<typeof catalogTrustSchema>;
