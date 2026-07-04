import { dirname } from "node:path";
import {
  COMPANION_SOURCE_UNPROVABLE_REASON,
  companionSubplanSchema
} from "./companion-domain.js";
import {
  CompanionManifestError,
  inspectCompanionTree,
  type CompanionManifestOptions
} from "./companion-manifest.js";
import {
  CompanionSkillError,
  companionSkillDirectory,
  type CompanionSkillInspection
} from "./companion-shared.js";

export type InternalCompanionManagedProof =
  | {
      kind: "recorded";
      recordId: string;
      installedFingerprint: string;
    }
  | {
      kind: "legacy-alpha";
      allowlistId: string;
      installedHookRecordId: string;
      canonicalConfigFingerprint: string;
      installedFingerprint: string;
    };

export interface InternalInspectCompanionSkillInput {
  home: string;
  sourceDirectory: string;
  managedProof?: InternalCompanionManagedProof;
}

export interface InternalInspectCompanionSkillOptions {
  source?: CompanionManifestOptions;
  destination?: CompanionManifestOptions;
}

function inspectionReason(error: CompanionManifestError): {
  status: "conflict" | "unknown";
  reason: string;
  proof: "conflict" | "unknown";
} {
  if (
    error.code === "COMPANION_TREE_UNSAFE"
    || error.code === "COMPANION_TREE_COLLISION"
    || error.code === "COMPANION_TREE_ESCAPE"
  ) {
    return { status: "conflict", reason: error.code, proof: "conflict" };
  }
  if (error.code === "COMPANION_TREE_TRUNCATED") {
    return {
      status: "unknown",
      reason: "COMPANION_INSPECTION_TRUNCATED",
      proof: "unknown"
    };
  }
  if (error.code === "COMPANION_TREE_CHANGED") {
    return {
      status: "unknown",
      reason: "COMPANION_INSPECTION_CHANGED",
      proof: "unknown"
    };
  }
  if (error.code === "COMPANION_TREE_UNPROVABLE") {
    return {
      status: "unknown",
      reason: "COMPANION_INSPECTION_UNPROVABLE",
      proof: "unknown"
    };
  }
  return {
    status: "unknown",
    reason: "COMPANION_INSPECTION_UNAVAILABLE",
    proof: "unknown"
  };
}

export async function inspectCompanionSkillWithProof(
  input: InternalInspectCompanionSkillInput,
  options: InternalInspectCompanionSkillOptions = {}
): Promise<CompanionSkillInspection> {
  const path = companionSkillDirectory(input.home);
  let after;
  try {
    after = await inspectCompanionTree(input.sourceDirectory, {
      ...options.source,
      boundary: options.source?.boundary ?? dirname(input.sourceDirectory)
    });
  } catch (error) {
    if (
      error instanceof CompanionManifestError
      && error.code === "COMPANION_TREE_UNPROVABLE"
    ) {
      const unavailable = {
        state: "unavailable" as const,
        reason: COMPANION_SOURCE_UNPROVABLE_REASON
      };
      return {
        status: "unknown",
        reason: COMPANION_SOURCE_UNPROVABLE_REASON,
        path,
        subplan: companionSubplanSchema.parse({
          action: "conflict",
          path,
          expectedBefore: {
            state: "unknown",
            reason: COMPANION_SOURCE_UNPROVABLE_REASON
          },
          after: unavailable,
          source: {
            path: input.sourceDirectory,
            ...unavailable
          },
          proof: {
            kind: "unknown",
            reason: COMPANION_SOURCE_UNPROVABLE_REASON
          }
        })
      };
    }
    throw new CompanionSkillError(
      "Packaged companion Skill cannot be inspected safely",
      "COMPANION_SOURCE_INVALID"
    );
  }
  const source = { path: input.sourceDirectory, fingerprint: after.fingerprint };
  let before;
  try {
    before = await inspectCompanionTree(path, {
      ...options.destination,
      boundary: options.destination?.boundary ?? input.home
    });
  } catch (error) {
    if (error instanceof CompanionManifestError && error.code === "COMPANION_TREE_MISSING") {
      return {
        status: "missing",
        reason: "COMPANION_MISSING",
        path,
        subplan: companionSubplanSchema.parse({
          action: "create",
          path,
          expectedBefore: { state: "absent" },
          after,
          source,
          proof: { kind: "new" }
        })
      };
    }
    const manifestError = error instanceof CompanionManifestError
      ? error
      : new CompanionManifestError("COMPANION_TREE_IO", "Companion inspection failed", {
          cause: error
        });
    const mapped = inspectionReason(manifestError);
    return {
      status: mapped.status,
      reason: mapped.reason,
      path,
      subplan: companionSubplanSchema.parse({
        action: "conflict",
        path,
        expectedBefore: { state: "unknown", reason: mapped.reason },
        after,
        source,
        proof: { kind: mapped.proof, reason: mapped.reason }
      })
    };
  }

  if (
    before.fingerprint === after.fingerprint
    && input.managedProof !== undefined
    && input.managedProof.installedFingerprint === before.fingerprint
  ) {
    return {
      status: "current",
      reason: "COMPANION_CURRENT",
      path,
      subplan: companionSubplanSchema.parse({
        action: "none",
        path,
        expectedBefore: { state: "exact", fingerprint: before.fingerprint },
        after,
        source,
        proof: input.managedProof
      })
    };
  }

  if (
    input.managedProof !== undefined
    && input.managedProof.installedFingerprint === before.fingerprint
  ) {
    return {
      status: "upgrade-available",
      reason: "COMPANION_UPGRADE_AVAILABLE",
      path,
      subplan: companionSubplanSchema.parse({
        action: "upgrade",
        path,
        expectedBefore: { state: "exact", fingerprint: before.fingerprint },
        after,
        source,
        proof: input.managedProof
      })
    };
  }

  const reason = input.managedProof === undefined
    ? "COMPANION_UNMANAGED_TREE"
    : "COMPANION_RECORDED_TREE_DRIFT";
  return {
    status: "conflict",
    reason,
    path,
    subplan: companionSubplanSchema.parse({
      action: "conflict",
      path,
      expectedBefore: { state: "exact", fingerprint: before.fingerprint },
      after,
      source,
      proof: { kind: "conflict", reason }
    })
  };
}
