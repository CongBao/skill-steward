import {
  harnessIdSchema,
  skillScopeSchema,
  type HarnessId
} from "@skill-steward/engine";
import { z } from "zod";

const pathSchema = z.string().min(1);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const governancePlanIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/);

export const governanceAliasSchema = z.object({
  harness: harnessIdSchema,
  scope: skillScopeSchema,
  rootPath: pathSchema
}).strict();

export const governanceSkillOwnershipSchema = z.discriminatedUnion("ownership", [
  z.object({ ownership: z.literal("direct") }).strict(),
  z.object({
    ownership: z.literal("native-plugin"),
    harness: harnessIdSchema
  }).strict()
]);

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

const governancePlanShape = {
  id: governancePlanIdSchema,
  kind: z.enum(["quarantine", "restore"]),
  sourceTransactionId: governancePlanIdSchema.optional(),
  skillId: z.string().min(1).max(256),
  skillName: z.string().min(1).optional(),
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
};

export const governancePlanV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...governancePlanShape
}).strict();

export const governancePlanV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...governancePlanShape,
  skillOwnership: governanceSkillOwnershipSchema
}).strict();

export const governancePlanSchema = z.discriminatedUnion("schemaVersion", [
  governancePlanV1Schema,
  governancePlanV2Schema
]);

const quarantinedSkillShape = {
  transactionId: governancePlanIdSchema,
  skillId: z.string().min(1).max(256),
  skillName: z.string().min(1).optional(),
  originalPath: pathSchema,
  vaultPath: pathSchema,
  fingerprint: fingerprintSchema,
  visibleAliases: z.array(governanceAliasSchema)
};

export const quarantinedSkillV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...quarantinedSkillShape
}).strict();

export const quarantinedSkillV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...quarantinedSkillShape,
  skillOwnership: governanceSkillOwnershipSchema
}).strict();

export const quarantinedSkillSchema = z.discriminatedUnion("schemaVersion", [
  quarantinedSkillV1Schema,
  quarantinedSkillV2Schema
]);

export type GovernanceAlias = z.infer<typeof governanceAliasSchema>;
export type GovernanceSkillOwnership = z.infer<typeof governanceSkillOwnershipSchema>;
export type GovernanceOperation = z.infer<typeof governanceOperationSchema>;
export type GovernancePlanV1 = z.infer<typeof governancePlanV1Schema>;
export type GovernancePlanV2 = z.infer<typeof governancePlanV2Schema>;
export type GovernancePlan = z.infer<typeof governancePlanSchema>;
export type QuarantinedSkillV1 = z.infer<typeof quarantinedSkillV1Schema>;
export type QuarantinedSkillV2 = z.infer<typeof quarantinedSkillV2Schema>;
export type QuarantinedSkill = z.infer<typeof quarantinedSkillSchema>;

export type GovernanceErrorCode =
  | "PLAN_INVALID"
  | "PLAN_EXPIRED"
  | "PLAN_ALREADY_USED"
  | "PLAN_REVIEW_REQUIRED"
  | "JOURNAL_UNSAFE"
  | "NATIVE_PLUGIN_MANAGED"
  | "SOURCE_UNSAFE"
  | "SOURCE_OUTSIDE_ACTIVE_ROOT"
  | "SOURCE_DRIFT"
  | "VAULT_DRIFT"
  | "DESTINATION_CONFLICT"
  | "UNSAFE_DESTINATION"
  | "UNSUPPORTED_FILESYSTEM"
  | "COPY_VERIFICATION_FAILED"
  | "TRANSACTION_RECOVERY_FAILED";

export type NativePluginLifecycleSurface =
  | "codex-plugin-manager"
  | "claude-code-plugin-manager"
  | "github-copilot-cli-plugin-manager"
  | "native-harness-plugin-manager";

export interface NativePluginManagedErrorData {
  harness: HarnessId;
  lifecycleSurface: NativePluginLifecycleSurface;
}

export type GovernanceErrorData = NativePluginManagedErrorData;

function nativePluginManager(harness: HarnessId): {
  label: string;
  lifecycleSurface: NativePluginLifecycleSurface;
} {
  switch (harness) {
    case "codex":
      return { label: "Codex plugin manager", lifecycleSurface: "codex-plugin-manager" };
    case "claude":
      return {
        label: "Claude Code plugin manager",
        lifecycleSurface: "claude-code-plugin-manager"
      };
    case "github-copilot":
      return {
        label: "GitHub Copilot CLI plugin manager",
        lifecycleSurface: "github-copilot-cli-plugin-manager"
      };
    default:
      return {
        label: "owning Harness plugin manager",
        lifecycleSurface: "native-harness-plugin-manager"
      };
  }
}

export class GovernanceError extends Error {
  constructor(
    public readonly code: GovernanceErrorCode,
    message: string,
    public readonly data?: GovernanceErrorData
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

export function nativePluginManagedError(harness: HarnessId): GovernanceError {
  const manager = nativePluginManager(harness);
  return new GovernanceError(
    "NATIVE_PLUGIN_MANAGED",
    `This Skill is managed by the ${manager.label}. Use that lifecycle surface to update, disable, or remove it.`,
    { harness, lifecycleSurface: manager.lifecycleSurface }
  );
}

export function assertMutableSkillOwnership(
  ownership: GovernanceSkillOwnership | undefined
): void {
  if (ownership?.ownership === "native-plugin") {
    throw nativePluginManagedError(ownership.harness);
  }
}
