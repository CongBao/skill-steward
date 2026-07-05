import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix } from "node:path";
import { z } from "zod";

export const COMPANION_MANIFEST_MAX_ENTRIES = 512;
export const COMPANION_MANIFEST_MAX_FILE_BYTES = 512 * 1024;
export const COMPANION_MANIFEST_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const COMPANION_MANIFEST_MAX_DEPTH = 16;

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const stableReasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
export const COMPANION_SOURCE_UNPROVABLE_REASON = "COMPANION_SOURCE_UNPROVABLE";
const securityModeSchema = z.string().regex(/^(posix:[0-7]{4}|win32:(readonly|writable))$/);
const normalizedAbsolutePathSchema = z.string().min(1).refine(
  (path) => isAbsolute(path) && normalize(path) === path,
  "Path must be absolute and normalized"
);
const relativePathSchema = z.string().min(1).refine((path) => {
  if (path === ".") return true;
  return !path.startsWith("/")
    && !path.includes("\\")
    && posix.normalize(path) === path
    && !path.split("/").includes("..");
}, "Manifest path must be normalized and relative");

const companionDirectoryEntrySchema = z.object({
  relativePath: relativePathSchema,
  kind: z.literal("directory"),
  bytes: z.literal(0),
  securityMode: securityModeSchema
}).strict();

const companionFileEntrySchema = z.object({
  relativePath: relativePathSchema,
  kind: z.literal("file"),
  bytes: z.number().int().nonnegative().max(COMPANION_MANIFEST_MAX_FILE_BYTES),
  sha256: fingerprintSchema,
  securityMode: securityModeSchema
}).strict();

export const companionTreeEntrySchema = z.discriminatedUnion("kind", [
  companionDirectoryEntrySchema,
  companionFileEntrySchema
]);

const companionTreeManifestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["posix", "win32"]),
  entries: z.array(companionTreeEntrySchema)
    .min(1)
    .max(COMPANION_MANIFEST_MAX_ENTRIES),
  fingerprint: fingerprintSchema
}).strict();

type CompanionTreeManifestShape = z.infer<typeof companionTreeManifestBaseSchema>;

function hash(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function compareCompanionPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFingerprint(input: Omit<CompanionTreeManifestShape, "fingerprint">): string {
  return hash(JSON.stringify(input));
}

export const companionTreeManifestSchema = companionTreeManifestBaseSchema.superRefine(
  (manifest, context) => {
    if (manifest.entries[0]?.relativePath !== "." || manifest.entries[0]?.kind !== "directory") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", 0],
        message: "Manifest must start with the root directory"
      });
    }
    const paths = manifest.entries.map(({ relativePath }) => relativePath);
    const sorted = [...paths].sort(compareCompanionPaths);
    if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Manifest entries must use stable lexical order"
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Manifest entry paths must be unique"
      });
    }
    const canonicalPaths = paths.map((path) => path.normalize("NFC").toLowerCase());
    if (new Set(canonicalPaths).size !== canonicalPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Manifest entry paths must not collide by case or Unicode normalization"
      });
    }
    const entriesByPath = new Map(
      manifest.entries.map((entry) => [entry.relativePath, entry] as const)
    );
    for (const [index, entry] of manifest.entries.entries()) {
      if (entry.relativePath !== ".") {
        const components = entry.relativePath.split("/");
        if (components.length > COMPANION_MANIFEST_MAX_DEPTH) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["entries", index, "relativePath"],
            message: "Manifest entry path exceeds the companion depth bound"
          });
        }
        const parentPath = components.length === 1
          ? "."
          : components.slice(0, -1).join("/");
        if (entriesByPath.get(parentPath)?.kind !== "directory") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["entries", index, "relativePath"],
            message: "Manifest entry parent must be a declared directory"
          });
        }
      }
      const expectedPrefix = manifest.platform === "win32" ? "win32:" : "posix:";
      if (!entry.securityMode.startsWith(expectedPrefix)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "securityMode"],
          message: "Manifest security mode must match its platform"
        });
      }
    }
    const totalBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (totalBytes > COMPANION_MANIFEST_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "Manifest total bytes exceed the companion bound"
      });
    }
    const expected = manifestFingerprint({
      schemaVersion: manifest.schemaVersion,
      platform: manifest.platform,
      entries: manifest.entries
    });
    if (manifest.fingerprint !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fingerprint"],
        message: "Manifest fingerprint does not match its entries"
      });
    }
  }
);

export type CompanionTreeEntry = z.infer<typeof companionTreeEntrySchema>;
export type CompanionTreeManifest = z.infer<typeof companionTreeManifestSchema>;

export function createCompanionTreeManifest(
  platform: CompanionTreeManifest["platform"],
  entries: CompanionTreeEntry[]
): CompanionTreeManifest {
  return companionTreeManifestSchema.parse({
    schemaVersion: 1,
    platform,
    entries,
    fingerprint: manifestFingerprint({ schemaVersion: 1, platform, entries })
  });
}

const expectedBeforeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("exact"), fingerprint: fingerprintSchema }).strict(),
  z.object({ state: z.literal("unknown"), reason: stableReasonSchema }).strict()
]);

const proofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    lifecycleRecordId: z.string().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal("recorded"),
    recordId: z.string().min(1),
    installedFingerprint: fingerprintSchema
  }).strict(),
  z.object({
    kind: z.literal("legacy-alpha"),
    allowlistId: z.string().min(1),
    installedHookRecordId: z.string().min(1),
    canonicalConfigFingerprint: fingerprintSchema,
    installedFingerprint: fingerprintSchema
  }).strict(),
  z.object({ kind: z.literal("conflict"), reason: stableReasonSchema }).strict(),
  z.object({ kind: z.literal("unknown"), reason: stableReasonSchema }).strict()
]);

const companionExactSubplanBaseSchema = z.object({
  path: normalizedAbsolutePathSchema,
  expectedBefore: expectedBeforeSchema,
  after: companionTreeManifestSchema,
  source: z.object({
    path: normalizedAbsolutePathSchema,
    fingerprint: fingerprintSchema
  }).strict(),
  proof: proofSchema
}).strict();

const companionExactSubplanSchema = z.discriminatedUnion("action", [
  companionExactSubplanBaseSchema.extend({ action: z.literal("none") }).strict(),
  companionExactSubplanBaseSchema.extend({ action: z.literal("create") }).strict(),
  companionExactSubplanBaseSchema.extend({ action: z.literal("upgrade") }).strict(),
  companionExactSubplanBaseSchema.extend({ action: z.literal("conflict") }).strict()
]).superRefine((plan, context) => {
  if (plan.source.fingerprint !== plan.after.fingerprint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source", "fingerprint"],
      message: "Companion source must match the after manifest"
    });
  }
  if (plan.action === "create") {
    if (plan.expectedBefore.state !== "absent" || plan.proof.kind !== "new") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Create requires absent/new proof" });
    }
    return;
  }
  if (plan.action === "none") {
    const installedFingerprint = plan.proof.kind === "recorded"
      || plan.proof.kind === "legacy-alpha"
      ? plan.proof.installedFingerprint
      : undefined;
    if (
      plan.expectedBefore.state !== "exact"
      || installedFingerprint === undefined
      || plan.expectedBefore.fingerprint !== plan.after.fingerprint
      || installedFingerprint !== plan.after.fingerprint
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "None requires exact managed proof" });
    }
    return;
  }
  if (plan.action === "upgrade") {
    const installedFingerprint = plan.proof.kind === "recorded"
      || plan.proof.kind === "legacy-alpha"
      ? plan.proof.installedFingerprint
      : undefined;
    if (
      plan.expectedBefore.state !== "exact"
      || installedFingerprint === undefined
      || installedFingerprint !== plan.expectedBefore.fingerprint
      || installedFingerprint === plan.after.fingerprint
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Upgrade requires different exact managed proof" });
    }
    return;
  }
  const consistentConflict = plan.proof.kind === "conflict"
    && (plan.expectedBefore.state === "exact" || (
      plan.expectedBefore.state === "unknown"
      && plan.expectedBefore.reason === plan.proof.reason
    ));
  const consistentUnknown = plan.expectedBefore.state === "unknown"
    && plan.proof.kind === "unknown"
    && plan.expectedBefore.reason === plan.proof.reason;
  if (!consistentConflict && !consistentUnknown) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Conflict requires matching conflict or unknown proof" });
  }
});

const unavailableAfterSchema = z.object({
  state: z.literal("unavailable"),
  reason: stableReasonSchema
}).strict();

const unavailableSourceSchema = unavailableAfterSchema.extend({
  path: normalizedAbsolutePathSchema
}).strict();

const companionSourceUnavailableSchema = z.object({
  action: z.literal("conflict"),
  path: normalizedAbsolutePathSchema,
  expectedBefore: z.object({
    state: z.literal("unknown"),
    reason: stableReasonSchema
  }).strict(),
  after: unavailableAfterSchema,
  source: unavailableSourceSchema,
  proof: z.object({
    kind: z.literal("unknown"),
    reason: stableReasonSchema
  }).strict()
}).strict().superRefine((plan, context) => {
  const reasons = [
    plan.expectedBefore.reason,
    plan.after.reason,
    plan.source.reason,
    plan.proof.reason
  ];
  if (
    new Set(reasons).size !== 1
    || reasons[0] !== COMPANION_SOURCE_UNPROVABLE_REASON
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Unavailable companion source evidence requires one source-unprovable reason"
    });
  }
});

export const companionSubplanSchema = z.union([
  companionExactSubplanSchema,
  companionSourceUnavailableSchema
]);

export type CompanionSubplan = z.infer<typeof companionSubplanSchema>;

type CompanionTransactionAction = Exclude<CompanionSubplan["action"], "conflict">;
const companionBlockedReasons = [
  "COMPANION_CANONICAL_CONFIG_DRIFT",
  "COMPANION_CANONICAL_CONFIG_UNAVAILABLE",
  "COMPANION_CONFLICT",
  "COMPANION_INSPECTION_CHANGED",
  "COMPANION_INSPECTION_TRUNCATED",
  "COMPANION_INSPECTION_UNAVAILABLE",
  "COMPANION_INSPECTION_UNPROVABLE",
  "COMPANION_LEGACY_HOOK_RECORD_MISSING",
  "COMPANION_LEGACY_TREE_NOT_ALLOWLISTED",
  "COMPANION_LIFECYCLE_EVIDENCE_WITH_MISSING_TREE",
  "COMPANION_LIFECYCLE_RECORD_UNAVAILABLE",
  "COMPANION_LIFECYCLE_RECORD_UNPROVABLE",
  "COMPANION_RECORDED_EVIDENCE_CONTRADICTORY",
  "COMPANION_RECORDED_TREE_DRIFT",
  "COMPANION_RECOVERY_REQUIRED",
  "COMPANION_RECOVERY_UNAVAILABLE",
  "COMPANION_SOURCE_UNPROVABLE",
  "COMPANION_TREE_COLLISION",
  "COMPANION_TREE_ESCAPE",
  "COMPANION_TREE_UNREADABLE",
  "COMPANION_TREE_UNSAFE",
  "COMPANION_UNMANAGED_TREE"
] as const;
type CompanionBlockedReason =
  | "INTEGRATION_PLATFORM_UNSUPPORTED"
  | typeof companionBlockedReasons[number];
const companionBlockedReasonSet = new Set<string>(companionBlockedReasons);

export type CompanionTransactionAvailability =
  | {
      state: "blocked";
      action: CompanionSubplan["action"];
      actionLabel: string;
      transactionEligible: false;
      applyAvailable: false;
      unavailableReason: CompanionBlockedReason;
    }
  | {
      state: "transaction-disabled";
      action: CompanionTransactionAction;
      actionLabel: string;
      transactionEligible: true;
      applyAvailable: false;
      unavailableReason: "COMPANION_TRANSACTION_NOT_ENABLED";
    }
  | {
      state: "available";
      action: CompanionTransactionAction;
      actionLabel: string;
      transactionEligible: true;
      applyAvailable: true;
      unavailableReason: null;
    };

const companionActionLabels: Record<CompanionSubplan["action"], string> = {
  create: "Create companion Skill",
  upgrade: "Upgrade companion Skill",
  none: "Connect Harness to companion Skill",
  conflict: "Resolve companion conflict"
};

export function deriveCompanionTransactionAvailability(
  companion: CompanionSubplan,
  platform: NodeJS.Platform
): CompanionTransactionAvailability {
  const actionLabel = companionActionLabels[companion.action];
  if (companion.action === "conflict") {
    const evidenceReason = companion.proof.kind === "conflict"
      || companion.proof.kind === "unknown"
      ? companion.proof.reason
      : "COMPANION_CONFLICT";
    const unavailableReason: CompanionBlockedReason = companionBlockedReasonSet.has(evidenceReason)
      ? evidenceReason as typeof companionBlockedReasons[number]
      : "COMPANION_CONFLICT";
    return {
      state: "blocked",
      action: companion.action,
      actionLabel,
      transactionEligible: false,
      applyAvailable: false,
      unavailableReason
    };
  }
  if (platform === "win32" || companion.after.platform !== "posix") {
    return {
      state: "blocked",
      action: companion.action,
      actionLabel,
      transactionEligible: false,
      applyAvailable: false,
      unavailableReason: "INTEGRATION_PLATFORM_UNSUPPORTED"
    };
  }
  return {
    state: "available",
    action: companion.action,
    actionLabel,
    transactionEligible: true,
    applyAvailable: true,
    unavailableReason: null
  };
}
