import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import {
  installationProvenanceSchema,
  InstallerError,
  type InstallationProvenance
} from "./domain.js";
import { fingerprintDirectory } from "./manifest.js";

export type ConflictAction = "cancel" | "rename" | "replace";
export type PlanStatus = "ready" | "conflict" | "noop";
export type PlanAction = "create" | "replace" | "cancel" | "none";

export interface InstallationChange {
  operation: "backup" | "create";
  path: string;
}

export interface InstallationPlan {
  id: string;
  status: PlanStatus;
  action: PlanAction;
  source: string;
  sourceFingerprint: string;
  destination: string;
  expectedDestinationFingerprint: string | null;
  allowedActions: ConflictAction[];
  changes: InstallationChange[];
  createdAt: number;
  expiresAt: number;
  provenance?: InstallationProvenance;
}

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absolutePathSchema = z.string().min(1).max(4_096).refine(
  (value) => isAbsolute(value) && normalize(value) === value,
  "Installation path must be absolute and normalized"
);
const installationChangeSchema = z.object({
  operation: z.enum(["backup", "create"]),
  path: absolutePathSchema
}).strict();

export const installationPlanSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["ready", "conflict", "noop"]),
  action: z.enum(["create", "replace", "cancel", "none"]),
  source: absolutePathSchema,
  sourceFingerprint: fingerprintSchema,
  destination: absolutePathSchema,
  expectedDestinationFingerprint: fingerprintSchema.nullable(),
  allowedActions: z.array(z.enum(["cancel", "rename", "replace"])).length(3),
  changes: z.array(installationChangeSchema).max(2),
  createdAt: z.number().int().safe().nonnegative(),
  expiresAt: z.number().int().safe().positive(),
  provenance: installationProvenanceSchema.optional()
}).strict().superRefine((plan, context) => {
  if (plan.expiresAt <= plan.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Installation plan expiry must be after creation"
    });
  }
  if (new Set(plan.allowedActions).size !== 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedActions"],
      message: "Installation plan actions must be unique"
    });
  }

  const operations = plan.changes.map(({ operation, path }) => ({ operation, path }));
  const expectedChanges = plan.status === "ready" && plan.action === "create"
    ? [{ operation: "create", path: plan.destination }]
    : plan.status === "ready" && plan.action === "replace"
      ? [
          { operation: "backup", path: plan.destination },
          { operation: "create", path: plan.destination }
        ]
      : [];
  if (JSON.stringify(operations) !== JSON.stringify(expectedChanges)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["changes"],
      message: "Installation changes do not match the reviewed action"
    });
  }

  const consistentStatus =
    (plan.status === "ready" && plan.action === "create"
      && plan.expectedDestinationFingerprint === null)
    || (plan.status === "ready" && plan.action === "replace"
      && plan.expectedDestinationFingerprint !== null)
    || (plan.status === "conflict" && plan.action === "cancel"
      && plan.expectedDestinationFingerprint !== null)
    || (plan.status === "noop" && plan.action === "none"
      && plan.expectedDestinationFingerprint === plan.sourceFingerprint);
  if (!consistentStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Installation status, action, and fingerprints are inconsistent"
    });
  }
  if (plan.source === plan.destination) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destination"],
      message: "Installation source and destination must differ"
    });
  }
});

export interface PlanInstallationInput {
  source: string;
  sourceFingerprint: string;
  destination: string;
  conflictAction?: ConflictAction;
  now?: number;
  ttlMs?: number;
  provenance?: InstallationProvenance;
}

async function existingFingerprint(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
      throw new InstallerError("DESTINATION_NOT_DIRECTORY", "Skill destination is not a directory");
    }
    return fingerprintDirectory(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function planInstallation(
  input: PlanInstallationInput
): Promise<InstallationPlan> {
  const actualSourceFingerprint = await fingerprintDirectory(input.source);
  if (actualSourceFingerprint !== input.sourceFingerprint) {
    throw new InstallerError("SOURCE_DRIFT", "Installation source changed after inspection");
  }

  const expectedDestinationFingerprint = await existingFingerprint(input.destination);
  const createdAt = input.now ?? Date.now();
  const base = {
    id: randomUUID(),
    source: input.source,
    sourceFingerprint: input.sourceFingerprint,
    destination: input.destination,
    expectedDestinationFingerprint,
    allowedActions: ["cancel", "rename", "replace"] as ConflictAction[],
    createdAt,
    expiresAt: createdAt + (input.ttlMs ?? 5 * 60_000),
    ...(input.provenance ? {
      provenance: installationProvenanceSchema.parse(input.provenance)
    } : {})
  };

  if (expectedDestinationFingerprint === null) {
    return {
      ...base,
      status: "ready",
      action: "create",
      changes: [{ operation: "create", path: input.destination }]
    };
  }
  if (expectedDestinationFingerprint === input.sourceFingerprint) {
    return { ...base, status: "noop", action: "none", changes: [] };
  }
  if (input.conflictAction === "replace") {
    return {
      ...base,
      status: "ready",
      action: "replace",
      changes: [
        { operation: "backup", path: input.destination },
        { operation: "create", path: input.destination }
      ]
    };
  }
  return { ...base, status: "conflict", action: "cancel", changes: [] };
}
