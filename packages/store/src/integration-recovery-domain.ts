import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix } from "node:path";
import { z } from "zod";
import {
  integrationFileRecoveryArtifactSchema,
  type IntegrationFileRecoveryArtifact
} from "./integration-file-recovery-artifact.js";
import {
  integrationReadinessRecoveryBindingSchema,
  type IntegrationReadinessRecoveryBinding
} from "./integration-readiness-recovery-binding.js";
import {
  integrationRecordV2BindingSchema,
  type IntegrationRecordV2Binding
} from "./integration-store.js";

export const MAX_RECOVERY_DIRECTORY_ENTRIES = 256;
export const MAX_RECOVERY_FRAGMENTS = 128;
export const MAX_RECOVERY_FRAGMENT_BYTES = 128 * 1024;
export const MAX_RECOVERY_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;

export const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const recoveryFragmentNamePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9]{6})\.json$/;

const harnessSchema = z.enum(["codex", "claude-code", "github-copilot"]);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decimalIdentitySchema = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const positiveDecimalIdentitySchema = z.string().regex(/^[1-9][0-9]{0,39}$/);
const transactionIdSchema = z.string().regex(transactionIdPattern);
const planIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const absolutePathSchema = z.string().min(1).max(MAX_PATH_BYTES).refine(
  (path) => isAbsolute(path)
    && normalize(path) === path
    && !path.includes("\0")
    && Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES,
  "Recovery path must be absolute and normalized"
);
const artifactRoleSchema = z.enum([
  "stage",
  "backup",
  "cleanup",
  "installed",
  "config-backup",
  "readiness-backup"
]);
const recoveryActionSchema = z.enum(["none", "create", "upgrade", "disconnect"]);
export const recoveryStateNameSchema = z.enum([
  "prepared",
  "mutating",
  "recovery-required",
  "rolled-back",
  "committed",
  "cleanup-pending",
  "closed"
]);

const artifactHintSchema = z.object({
  role: artifactRoleSchema,
  path: absolutePathSchema
}).strict();

const physicalIdentitySchema = z.object({
  device: decimalIdentitySchema,
  inode: decimalIdentitySchema
}).strict();

const recoveryManifestRelativePathSchema = z.string().min(1).max(4_096).refine((path) => {
  if (path === ".") return true;
  return !path.startsWith("/")
    && !path.includes("\\")
    && posix.normalize(path) === path
    && !path.split("/").includes("..");
}, "Recovery manifest path must be normalized and relative");
const recoverySecurityModeSchema = z.string().regex(
  /^(posix:[0-7]{4}|win32:(readonly|writable))$/
);
const recoveryDirectoryEntrySchema = z.object({
  relativePath: recoveryManifestRelativePathSchema,
  kind: z.literal("directory"),
  bytes: z.literal(0),
  securityMode: recoverySecurityModeSchema
}).strict();
const recoveryFileEntrySchema = z.object({
  relativePath: recoveryManifestRelativePathSchema,
  kind: z.literal("file"),
  bytes: z.number().int().nonnegative().max(512 * 1024),
  sha256: fingerprintSchema,
  securityMode: recoverySecurityModeSchema
}).strict();
const recoveryManifestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["posix", "win32"]),
  entries: z.array(z.discriminatedUnion("kind", [
    recoveryDirectoryEntrySchema,
    recoveryFileEntrySchema
  ])).min(1).max(512),
  fingerprint: fingerprintSchema
}).strict();
const recoveryTreeManifestSchema = recoveryManifestBaseSchema.superRefine((manifest, context) => {
  const paths = manifest.entries.map(({ relativePath }) => relativePath);
  if (manifest.entries[0]?.relativePath !== "." || manifest.entries[0]?.kind !== "directory") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries", 0],
      message: "Recovery manifest must start with its root directory"
    });
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Recovery manifest entries must be lexically sorted"
    });
  }
  const canonical = paths.map((path) => path.normalize("NFC").toLowerCase());
  if (new Set(paths).size !== paths.length || new Set(canonical).size !== canonical.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Recovery manifest paths must be uniquely normalized"
    });
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.relativePath, entry] as const));
  let totalBytes = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    totalBytes += entry.bytes;
    if (entry.relativePath !== ".") {
      const components = entry.relativePath.split("/");
      if (components.length > 16) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "relativePath"],
          message: "Recovery manifest entry exceeds its depth bound"
        });
      }
      const parent = components.length === 1 ? "." : components.slice(0, -1).join("/");
      if (entries.get(parent)?.kind !== "directory") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index],
          message: "Recovery manifest entry parent must be a directory"
        });
      }
    }
    const modePrefix = manifest.platform === "posix" ? "posix:" : "win32:";
    if (!entry.securityMode.startsWith(modePrefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "securityMode"],
        message: "Recovery manifest mode must match its platform"
      });
    }
  }
  if (totalBytes > 2 * 1024 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Recovery manifest exceeds its total content byte bound"
    });
  }
  const withoutFingerprint = {
    schemaVersion: manifest.schemaVersion,
    platform: manifest.platform,
    entries: manifest.entries
  };
  const expected = `sha256:${createHash("sha256")
    .update(JSON.stringify(withoutFingerprint))
    .digest("hex")}`;
  if (manifest.fingerprint !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fingerprint"],
      message: "Recovery manifest fingerprint does not match its entries"
    });
  }
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > 48 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery manifest exceeds its serialized byte bound"
    });
  }
});

const recoveryPlatformMetadataSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("posix"),
    identity: z.literal("bigint-device-inode"),
    securityMode: z.literal("posix-permission-bits")
  }).strict(),
  z.object({
    platform: z.literal("win32"),
    identity: z.literal("bigint-volume-file-index"),
    securityMode: z.literal("win32-readonly-attribute")
  }).strict()
]);

const recoveryEntryIdentitySchema = z.object({
  relativePath: recoveryManifestRelativePathSchema,
  device: positiveDecimalIdentitySchema,
  inode: positiveDecimalIdentitySchema
}).strict();

const integrationRecoveryArtifactProofBaseSchema = z.object({
  role: artifactRoleSchema,
  path: absolutePathSchema,
  physicalParentPath: absolutePathSchema,
  parentIdentity: physicalIdentitySchema,
  rootIdentity: physicalIdentitySchema,
  fingerprint: fingerprintSchema,
  entryIdentities: z.array(recoveryEntryIdentitySchema).min(1).max(512).optional(),
  manifest: recoveryTreeManifestSchema.optional(),
  platformMetadata: recoveryPlatformMetadataSchema.optional()
}).strict();

export const integrationRecoveryArtifactProofSchema = integrationRecoveryArtifactProofBaseSchema
  .superRefine((proof, context) => {
    const selfContained = [
      proof.manifest,
      proof.platformMetadata,
      proof.entryIdentities
    ].filter((value) => value !== undefined).length;
    if (selfContained !== 0 && selfContained !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recovery manifest, platform metadata, and entry identities must be persisted together"
      });
      return;
    }
    if (
      proof.manifest !== undefined
      && (
        proof.manifest.fingerprint !== proof.fingerprint
        || proof.platformMetadata?.platform !== proof.manifest.platform
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recovery artifact manifest metadata is inconsistent"
      });
    }
    if (proof.manifest !== undefined && proof.entryIdentities !== undefined) {
      const manifestPaths = proof.manifest.entries.map(({ relativePath }) => relativePath);
      const identityPaths = proof.entryIdentities.map(({ relativePath }) => relativePath);
      if (
        JSON.stringify(identityPaths) !== JSON.stringify(manifestPaths)
        || proof.entryIdentities[0]?.device !== proof.rootIdentity.device
        || proof.entryIdentities[0]?.inode !== proof.rootIdentity.inode
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Recovery artifact entry identities must exactly bind the manifest"
        });
      }
    }
  });

function uniqueRolesAndPaths(
  values: ReadonlyArray<{ role: string; path: string }>,
  context: z.RefinementCtx,
  label: string
): void {
  const roles = values.map(({ role }) => role);
  const paths = values.map(({ path }) => path);
  if (new Set(roles).size !== roles.length || new Set(paths).size !== paths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} roles and paths must be unique`
    });
  }
}

const artifactHintsSchema = z.array(artifactHintSchema).max(6)
  .superRefine((values, context) => uniqueRolesAndPaths(values, context, "Artifact hint"));
const artifactProofsSchema = z.array(integrationRecoveryArtifactProofSchema).max(6)
  .superRefine((values, context) => uniqueRolesAndPaths(values, context, "Artifact proof"));

const recoveryBaseObjectSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: transactionIdSchema,
  planId: planIdSchema,
  harness: harnessSchema,
  action: recoveryActionSchema,
  companionPath: absolutePathSchema,
  configPath: absolutePathSchema,
  beforeFingerprint: fingerprintSchema.nullable(),
  afterFingerprint: fingerprintSchema.nullable(),
  createdAt: z.string().datetime(),
  lifecycleRecordBinding: integrationRecordV2BindingSchema.optional(),
  artifactHints: artifactHintsSchema
}).strict();

function validateRecoveryBase(
  value: z.infer<typeof recoveryBaseObjectSchema>,
  context: z.RefinementCtx
): void {
  const validAction = value.action === "create"
    ? value.beforeFingerprint === null && value.afterFingerprint !== null
    : value.action === "disconnect"
      ? value.beforeFingerprint !== null
        && (
          value.afterFingerprint === null
          || value.beforeFingerprint === value.afterFingerprint
        )
      : value.action === "upgrade"
        ? value.beforeFingerprint !== null
          && value.afterFingerprint !== null
          && value.beforeFingerprint !== value.afterFingerprint
        : value.beforeFingerprint !== null
          && value.afterFingerprint !== null
          && value.beforeFingerprint === value.afterFingerprint;
  if (!validAction) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery fingerprints do not match the requested action"
    });
  }
}

export const integrationRecoveryIntentInputSchema = recoveryBaseObjectSchema
  .superRefine(validateRecoveryBase);

export const integrationRecoveryStateSchema = recoveryBaseObjectSchema.extend({
  sequence: z.number().int().min(0).max(999_999),
  state: recoveryStateNameSchema,
  transitionedAt: z.string().datetime(),
  artifactProofs: artifactProofsSchema,
  configurationArtifact: integrationFileRecoveryArtifactSchema.optional(),
  readinessArtifact: integrationReadinessRecoveryBindingSchema.optional(),
  completedSteps: z.array(z.enum([
    "readiness-finalized",
    "configuration-finalized",
    "companion-finalized"
  ])).max(3).default([]).superRefine((steps, context) => {
    if (JSON.stringify(steps) !== JSON.stringify([...new Set(steps)].sort())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed recovery steps must be unique and sorted"
      });
    }
  })
}).strict().superRefine((value, context) => {
  validateRecoveryBase(value, context);
  if (value.state === "mutating" && value.lifecycleRecordBinding === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Mutating recovery requires an exact lifecycle-record binding"
    });
  }
  if (
    value.lifecycleRecordBinding === undefined
    && (
      value.artifactProofs.length > 0
      || value.configurationArtifact !== undefined
      || value.readinessArtifact !== undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery artifacts require an exact lifecycle-record binding"
    });
  }
  if (value.sequence === 0 && value.state !== "prepared") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Recovery sequence zero must be prepared" });
  }
  if (value.sequence === 0 && value.transitionedAt !== value.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Prepared timestamp must match creation" });
  }
  if (value.sequence === 0 && value.artifactProofs.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Prepared recovery cannot claim artifact proofs" });
  }
  if (value.sequence === 0 && value.configurationArtifact !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Prepared recovery cannot claim a configuration artifact"
    });
  }
  if (
    value.configurationArtifact !== undefined
    && value.configurationArtifact.recoveryTransactionId !== value.transactionId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Configuration recovery artifact belongs to another transaction"
    });
  }
  if (
    value.configurationArtifact !== undefined
    && value.configurationArtifact.targetPath !== value.configPath
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Configuration recovery artifact belongs to another target"
    });
  }
  if (value.sequence === 0 && value.readinessArtifact !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Prepared recovery cannot claim a readiness artifact"
    });
  }
  if (
    value.completedSteps.length > 0
    && !["committed", "cleanup-pending", "closed"].includes(value.state)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Completed recovery steps require committed recovery"
    });
  }
  if (
    value.readinessArtifact !== undefined
    && value.readinessArtifact.recoveryTransactionId !== value.transactionId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Readiness recovery artifact belongs to another transaction"
    });
  }
  if (
    value.readinessArtifact !== undefined
    && (
      value.readinessArtifact.trigger.planId !== value.planId
      || value.readinessArtifact.trigger.harness !== value.harness
      || value.readinessArtifact.trigger.createdAt !== value.createdAt
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Readiness recovery artifact trigger does not match its transaction"
    });
  }
});

export const integrationRecoveryTransitionInputSchema = z.object({
  transactionId: transactionIdSchema,
  expectedSequence: z.number().int().min(0).max(999_998),
  expectedState: recoveryStateNameSchema,
  state: recoveryStateNameSchema,
  transitionedAt: z.string().datetime(),
  lifecycleRecordBindingAddition: integrationRecordV2BindingSchema.optional(),
  artifactProofAdditions: artifactProofsSchema.optional(),
  configurationArtifactAddition: integrationFileRecoveryArtifactSchema.optional(),
  readinessArtifactAddition: integrationReadinessRecoveryBindingSchema.optional(),
  completedStepAdditions: z.array(z.enum([
    "readiness-finalized",
    "configuration-finalized",
    "companion-finalized"
  ])).min(1).max(3).optional()
}).strict();

export type IntegrationRecoveryArtifactProof = z.infer<typeof integrationRecoveryArtifactProofSchema>;
export type IntegrationRecoveryIntentInput = z.infer<typeof integrationRecoveryIntentInputSchema>;
export type IntegrationRecoveryState = z.infer<typeof integrationRecoveryStateSchema>;
export type IntegrationRecoveryTransitionInput = z.infer<typeof integrationRecoveryTransitionInputSchema>;
export type { IntegrationFileRecoveryArtifact };
export type { IntegrationReadinessRecoveryBinding };
export type { IntegrationRecordV2Binding };

export const allowedRecoveryTransitions: Readonly<Record<
  IntegrationRecoveryState["state"],
  readonly IntegrationRecoveryState["state"][]
>> = {
  prepared: ["mutating", "rolled-back"],
  mutating: ["mutating", "recovery-required", "rolled-back", "committed"],
  "recovery-required": ["rolled-back", "committed"],
  "rolled-back": ["closed"],
  committed: ["committed", "cleanup-pending", "closed"],
  "cleanup-pending": ["cleanup-pending", "closed"],
  closed: []
};

function stableProof(proof: IntegrationRecoveryArtifactProof): string {
  return JSON.stringify(proof);
}

export function mergeArtifactProofs(
  current: IntegrationRecoveryArtifactProof[],
  additions: IntegrationRecoveryArtifactProof[],
  targetState: IntegrationRecoveryState["state"]
): IntegrationRecoveryArtifactProof[] {
  if (additions.length > 0 && ![
    "mutating",
    "recovery-required",
    "committed"
  ].includes(targetState)) {
    throw new Error("Artifact proofs can only be added during mutation or recovery finalization");
  }
  const merged = new Map(current.map((proof) => [proof.role, proof] as const));
  for (const proof of additions) {
    const existing = merged.get(proof.role);
    if (existing && stableProof(existing) !== stableProof(proof)) {
      throw new Error("An existing artifact role proof cannot change");
    }
    if (!existing) merged.set(proof.role, proof);
  }
  return [...merged.values()].sort((left, right) => left.role.localeCompare(right.role));
}

function immutableBase(state: IntegrationRecoveryState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    transactionId: state.transactionId,
    planId: state.planId,
    harness: state.harness,
    action: state.action,
    companionPath: state.companionPath,
    configPath: state.configPath,
    beforeFingerprint: state.beforeFingerprint,
    afterFingerprint: state.afterFingerprint,
    createdAt: state.createdAt,
    artifactHints: state.artifactHints
  });
}

export function validateRecoveryHistory(states: IntegrationRecoveryState[]): void {
  const transactions = new Map<string, IntegrationRecoveryState[]>();
  for (const state of states) {
    const history = transactions.get(state.transactionId) ?? [];
    history.push(state);
    transactions.set(state.transactionId, history);
  }
  for (const history of transactions.values()) {
    history.sort((left, right) => left.sequence - right.sequence);
    if (history[0]?.sequence !== 0 || history[0].state !== "prepared") {
      throw new Error("Integration recovery history must begin with prepared sequence zero");
    }
    const base = immutableBase(history[0]);
    for (let index = 0; index < history.length; index += 1) {
      const current = history[index]!;
      if (current.sequence !== index || immutableBase(current) !== base) {
        throw new Error("Integration recovery history is contradictory");
      }
      if (index === 0) continue;
      const previous = history[index - 1]!;
      if (!allowedRecoveryTransitions[previous.state].includes(current.state)) {
        throw new Error("Integration recovery history contains an invalid transition");
      }
      if (Date.parse(current.transitionedAt) < Date.parse(previous.transitionedAt)) {
        throw new Error("Integration recovery transition timestamps are not monotonic");
      }
      if (
        previous.lifecycleRecordBinding !== undefined
        && JSON.stringify(current.lifecycleRecordBinding)
          !== JSON.stringify(previous.lifecycleRecordBinding)
      ) {
        throw new Error("Integration lifecycle-record binding history is contradictory");
      }
      if (
        previous.lifecycleRecordBinding === undefined
        && current.lifecycleRecordBinding !== undefined
        && (previous.state !== "prepared" || current.state !== "mutating")
      ) {
        throw new Error("Integration lifecycle-record binding was added in an invalid state");
      }
      const expected = mergeArtifactProofs(
        previous.artifactProofs,
        current.artifactProofs.filter((proof) =>
          !previous.artifactProofs.some(({ role }) => role === proof.role)
        ),
        current.state
      );
      if (JSON.stringify(expected) !== JSON.stringify(current.artifactProofs)) {
        throw new Error("Integration recovery artifact proof history is contradictory");
      }
      if (
        previous.configurationArtifact !== undefined
        && JSON.stringify(current.configurationArtifact)
          !== JSON.stringify(previous.configurationArtifact)
      ) {
        throw new Error("Integration configuration recovery artifact history is contradictory");
      }
      if (
        previous.configurationArtifact === undefined
        && current.configurationArtifact !== undefined
        && !["mutating", "recovery-required", "committed"].includes(current.state)
      ) {
        throw new Error("Integration configuration recovery artifact was added in an invalid state");
      }
      if (
        previous.readinessArtifact !== undefined
        && JSON.stringify(current.readinessArtifact)
          !== JSON.stringify(previous.readinessArtifact)
      ) {
        throw new Error("Integration readiness recovery artifact history is contradictory");
      }
      if (
        previous.readinessArtifact === undefined
        && current.readinessArtifact !== undefined
        && !["mutating", "recovery-required", "committed"].includes(current.state)
      ) {
        throw new Error("Integration readiness recovery artifact was added in an invalid state");
      }
      if (previous.completedSteps.some((step) => !current.completedSteps.includes(step))) {
        throw new Error("Completed integration recovery steps cannot be removed");
      }
      if (
        current.completedSteps.some((step) => !previous.completedSteps.includes(step))
        && !["committed", "cleanup-pending"].includes(current.state)
      ) {
        throw new Error("Completed integration recovery steps were added in an invalid state");
      }
    }
  }
}

export function latestRecoveryState(
  states: IntegrationRecoveryState[],
  transactionId: string
): IntegrationRecoveryState | undefined {
  return states
    .filter((state) => state.transactionId === transactionId)
    .sort((left, right) => right.sequence - left.sequence)[0];
}

export function recoveryFragmentName(state: IntegrationRecoveryState): string {
  return `${state.transactionId}-${String(state.sequence).padStart(6, "0")}.json`;
}
