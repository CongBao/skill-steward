import { harnessIdSchema, skillScopeSchema } from "@skill-steward/engine";
import { z } from "zod";

const pathSchema = z.string().min(1);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const governancePlanIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/);

export const governanceAliasSchema = z.object({
  harness: harnessIdSchema,
  scope: skillScopeSchema,
  rootPath: pathSchema
}).strict();

export const governanceOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("copy-to-staging"), from: pathSchema, to: pathSchema }).strict(),
  z.object({ operation: z.literal("verify-staging"), path: pathSchema, fingerprint: fingerprintSchema }).strict(),
  z.object({ operation: z.literal("move-active-to-rollback"), from: pathSchema, to: pathSchema }).strict(),
  z.object({ operation: z.literal("commit-vault"), from: pathSchema, to: pathSchema }).strict(),
  z.object({ operation: z.literal("restore-active"), from: pathSchema, to: pathSchema }).strict(),
  z.object({ operation: z.literal("append-journal"), transactionId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("cleanup-rollback"), path: pathSchema }).strict(),
  z.object({ operation: z.literal("cleanup-vault"), path: pathSchema }).strict()
]);

export const governancePlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: governancePlanIdSchema,
  kind: z.enum(["quarantine", "restore"]),
  skillId: z.string().min(1).max(256),
  activePath: pathSchema,
  vaultPath: pathSchema,
  stagingPath: pathSchema,
  rollbackPath: pathSchema.optional(),
  sourceFingerprint: fingerprintSchema,
  expectedDestinationFingerprint: fingerprintSchema.nullable(),
  visibleAliases: z.array(governanceAliasSchema),
  operations: z.array(governanceOperationSchema).min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export const quarantinedSkillSchema = z.object({
  transactionId: governancePlanIdSchema,
  skillId: z.string().min(1).max(256),
  originalPath: pathSchema,
  vaultPath: pathSchema,
  fingerprint: fingerprintSchema,
  visibleAliases: z.array(governanceAliasSchema)
}).strict();

export type GovernanceAlias = z.infer<typeof governanceAliasSchema>;
export type GovernanceOperation = z.infer<typeof governanceOperationSchema>;
export type GovernancePlan = z.infer<typeof governancePlanSchema>;
export type QuarantinedSkill = z.infer<typeof quarantinedSkillSchema>;

export type GovernanceErrorCode =
  | "PLAN_INVALID"
  | "SOURCE_UNSAFE"
  | "SOURCE_OUTSIDE_ACTIVE_ROOT"
  | "SOURCE_DRIFT"
  | "VAULT_DRIFT"
  | "DESTINATION_CONFLICT"
  | "UNSAFE_DESTINATION"
  | "UNSUPPORTED_FILESYSTEM";

export class GovernanceError extends Error {
  constructor(public readonly code: GovernanceErrorCode, message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}
