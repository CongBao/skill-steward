import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
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
