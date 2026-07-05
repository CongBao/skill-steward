import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const MAX_PATH_BYTES = 4_096;
const MAX_SERIALIZED_BYTES = 96 * 1024;
const transactionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pathSchema = z.string().min(1).max(MAX_PATH_BYTES).refine(
  (path) => isAbsolute(path)
    && normalize(path) === path
    && !path.includes("\0")
    && Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES,
  "Integration file recovery path must be absolute and normalized"
);
const identitySchema = z.object({
  device: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
  inode: z.string().regex(/^[1-9][0-9]{0,39}$/)
}).strict();
const ownedFileSchema = z.object({
  path: pathSchema,
  identity: identitySchema,
  fingerprint: fingerprintSchema,
  bytes: z.number().int().nonnegative().max(24 * 1024 * 1024),
  mode: z.number().int().min(0).max(0o777)
}).strict();
const directorySchema = z.object({
  path: pathSchema,
  physicalPath: pathSchema,
  identity: identitySchema
}).strict();
const absentSchema = z.object({ state: z.literal("absent") }).strict();
const fileStateSchema = z.object({
  state: z.literal("file"),
  fingerprint: fingerprintSchema,
  bytes: z.number().int().nonnegative().max(24 * 1024 * 1024),
  mode: z.number().int().min(0).max(0o777)
}).strict();

export const integrationFileRecoveryArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryTransactionId: transactionIdSchema,
  publicationTransactionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/),
  stateDirectory: pathSchema,
  targetPath: pathSchema,
  allowedBoundaryPath: pathSchema,
  maxBytes: z.number().int().min(1).max(24 * 1024 * 1024),
  before: z.union([absentSchema, fileStateSchema]),
  after: fileStateSchema.omit({ state: true }),
  directoryProofs: z.array(directorySchema).min(1).max(64),
  temporary: ownedFileSchema,
  backup: ownedFileSchema.optional()
}).strict().superRefine((artifact, context) => {
  if (
    artifact.temporary.fingerprint !== artifact.after.fingerprint
    || artifact.temporary.bytes !== artifact.after.bytes
    || artifact.temporary.mode !== artifact.after.mode
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery temporary must exactly bind the intended after state"
    });
  }
  if (artifact.before.state === "absent" && artifact.backup !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Absent recovery state cannot carry a backup"
    });
  }
  if (artifact.before.state === "file" && (
    artifact.backup === undefined
    || artifact.backup.fingerprint !== artifact.before.fingerprint
    || artifact.backup.bytes !== artifact.before.bytes
    || artifact.backup.mode !== 0o600
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "File recovery state requires its exact backup"
    });
  }
  if (Buffer.byteLength(JSON.stringify(artifact), "utf8") > MAX_SERIALIZED_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Integration file recovery artifact exceeds its serialized bound"
    });
  }
});

export type IntegrationFileRecoveryArtifact = z.infer<
  typeof integrationFileRecoveryArtifactSchema
>;

export function immutableIntegrationFileRecoveryArtifact(
  value: unknown
): IntegrationFileRecoveryArtifact {
  const artifact = integrationFileRecoveryArtifactSchema.parse(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(artifact);
  return artifact;
}
