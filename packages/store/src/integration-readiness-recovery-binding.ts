import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { IntegrationReadinessRecoveryArtifact } from "./integration-readiness-domain.js";

const transactionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z.object({
  device: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
  inode: z.string().regex(/^[1-9][0-9]{0,39}$/)
}).strict();
const pathSchema = z.string().min(1).max(4_096).refine(
  (path) => isAbsolute(path)
    && normalize(path) === path
    && Buffer.byteLength(path, "utf8") <= 4_096,
  "Readiness recovery path must be absolute and normalized"
);
const observedSchema = z.union([
  z.object({ state: z.literal("absent") }).strict(),
  z.object({
    state: z.literal("file"),
    fingerprint: fingerprintSchema,
    mode: z.number().int().min(0).max(0o777),
    identity: identitySchema
  }).strict()
]);

export const integrationReadinessRecoveryBindingSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryTransactionId: transactionIdSchema,
  readinessTransactionId: z.string().min(1).max(256),
  stateDirectory: pathSchema,
  stateDirectoryIdentity: identitySchema,
  reportFingerprint: fingerprintSchema,
  trigger: z.object({
    planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    harness: z.enum(["codex", "claude-code", "github-copilot"]),
    createdAt: z.string().max(64).datetime()
  }).strict(),
  backup: z.object({ fingerprint: fingerprintSchema, identity: identitySchema }).strict(),
  latest: z.object({ observed: observedSchema }).strict(),
  previous: z.object({ observed: observedSchema }).strict()
}).strict().superRefine((binding, context) => {
  if (Buffer.byteLength(JSON.stringify(binding), "utf8") > 32 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Readiness recovery binding exceeds its serialized bound"
    });
  }
});

export type IntegrationReadinessRecoveryBinding = z.infer<
  typeof integrationReadinessRecoveryBindingSchema
>;

export function bindIntegrationReadinessRecoveryArtifact(
  recoveryTransactionId: string,
  artifact: IntegrationReadinessRecoveryArtifact
): IntegrationReadinessRecoveryBinding {
  const compact = (observed: IntegrationReadinessRecoveryArtifact["latest"]["observed"]) =>
    observed.state === "absent"
      ? { state: "absent" as const }
      : {
          state: "file" as const,
          fingerprint: observed.fingerprint,
          mode: observed.mode,
          identity: observed.identity
        };
  const binding = integrationReadinessRecoveryBindingSchema.parse({
    schemaVersion: 1,
    recoveryTransactionId,
    readinessTransactionId: artifact.transactionId,
    stateDirectory: artifact.stateDirectory,
    stateDirectoryIdentity: artifact.stateDirectoryIdentity,
    reportFingerprint: artifact.reportFingerprint,
    trigger: artifact.trigger,
    backup: artifact.backup,
    latest: { observed: compact(artifact.latest.observed) },
    previous: { observed: compact(artifact.previous.observed) }
  });
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(binding);
  return binding;
}
