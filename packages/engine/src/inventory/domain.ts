import type {
  HarnessId,
  InventorySource,
  SkillRoot,
  SkillScope
} from "../domain.js";

export type InventorySourceKind = InventorySource["kind"];
export type InventorySourceStatus = InventorySource["status"];

export type InventoryDiagnosticCode =
  | "COMPONENT_PATH_ABSOLUTE"
  | "COMPONENT_PATH_DEPTH_LIMIT"
  | "COMPONENT_PATH_EMPTY"
  | "COMPONENT_PATH_ESCAPE"
  | "COMPONENT_PATH_MISSING"
  | "COMPONENT_REALPATH_ESCAPE"
  | "INVENTORY_DIRECTORY_LIMIT"
  | "INVENTORY_DIAGNOSTIC_INVALID"
  | "INVENTORY_DEPTH_LIMIT"
  | "INVENTORY_INVALID_BOUNDS"
  | "INVENTORY_PLAN_AUTHORITY_MISMATCH"
  | "INVENTORY_SKILL_LIMIT"
  | "INVENTORY_SOURCE_MISSING"
  | "INVENTORY_SOURCE_NOT_DIRECTORY"
  | "INVENTORY_SOURCE_NOT_SKILL"
  | "INVENTORY_CANDIDATE_CONTAINMENT_CHANGED"
  | "INVENTORY_SOURCE_CONTAINMENT_CHANGED"
  | "INVENTORY_SOURCE_SYMLINK"
  | "INVENTORY_SOURCE_UNREADABLE"
  | "METADATA_INVALID_JSON"
  | "METADATA_INVALID_JSONC"
  | "METADATA_INVALID_TOML"
  | "METADATA_IDENTITY_CHANGED"
  | "METADATA_NOT_FILE"
  | "METADATA_NOT_OBJECT"
  | "METADATA_SYMLINK_REFUSED"
  | "METADATA_TOO_LARGE"
  | "METADATA_UNREADABLE";

export interface InventoryDiagnostic {
  code: string;
  message: string;
}

export class InventoryError extends Error {
  readonly code: InventoryDiagnosticCode;
  readonly diagnostics: readonly unknown[];

  constructor(
    code: InventoryDiagnosticCode,
    message: string,
    diagnostics: readonly unknown[] = []
  ) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface InventoryScanBounds {
  maxDepth: number;
  maxDirectories: number;
  maxSkills: number;
}

export const INVENTORY_SCAN_HARD_MAXIMA: Readonly<InventoryScanBounds> =
  Object.freeze({
    maxDepth: 24,
    maxDirectories: 20_000,
    maxSkills: 1_000
  });

export const MAX_INVENTORY_DIAGNOSTIC_MESSAGE = 2_000;

const stableDiagnosticCode = /^[A-Z][A-Z0-9_]+$/;

export function createInventoryDiagnostic(
  code: InventoryDiagnosticCode,
  message: string
): InventoryDiagnostic {
  return sanitizeInventoryDiagnostic({ code, message });
}

export function sanitizeInventoryDiagnostic(
  input: InventoryDiagnostic
): InventoryDiagnostic {
  const inputCode: unknown = input.code;
  const inputMessage: unknown = input.message;
  const code = (
    typeof inputCode === "string" && stableDiagnosticCode.test(inputCode)
  )
    ? inputCode
    : "INVENTORY_DIAGNOSTIC_INVALID";
  const message = (
    typeof inputMessage === "string" && inputMessage.length > 0
  )
    ? inputMessage
    : "Inventory diagnostic message unavailable";
  if (message.length <= MAX_INVENTORY_DIAGNOSTIC_MESSAGE) {
    return { code, message };
  }
  return {
    code,
    message: `${message.slice(0, MAX_INVENTORY_DIAGNOSTIC_MESSAGE - 1)}…`
  };
}

export function validateInventoryBound(
  value: number,
  label: string,
  hardMaximum: number
): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > hardMaximum
  ) {
    throw new InventoryError(
      "INVENTORY_INVALID_BOUNDS",
      `${label} must be an integer between 0 and ${hardMaximum}`
    );
  }
}

export function validateInventoryScanBounds(
  bounds: InventoryScanBounds,
  label = "inventory bounds"
): void {
  validateInventoryBound(
    bounds.maxDepth,
    `${label}.maxDepth`,
    INVENTORY_SCAN_HARD_MAXIMA.maxDepth
  );
  validateInventoryBound(
    bounds.maxDirectories,
    `${label}.maxDirectories`,
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );
  validateInventoryBound(
    bounds.maxSkills,
    `${label}.maxSkills`,
    INVENTORY_SCAN_HARD_MAXIMA.maxSkills
  );
}

export const defaultInventoryScanBounds: InventoryScanBounds = {
  ...INVENTORY_SCAN_HARD_MAXIMA
};

export interface InventoryPlanSource {
  id: string;
  harness: HarnessId;
  scope: SkillScope;
  kind: InventorySourceKind;
  path: string;
  layout: "self" | "children";
  ownership: "direct" | "native-plugin";
  plugin?: { id: string; version?: string };
  manifestPath?: string;
  visibleTo?: HarnessId[];
  inspectSkills?: boolean;
  /** Runtime-only exclusions used when a direct root contains native bundles. */
  excludedChildPaths?: string[];
  /** Runtime-only namespace input; persisted exposure names are resolved later. */
  pluginNamespace?: string;
  /** Runtime-only qualifier for nested/on-demand direct Skill identities. */
  pathQualification?: string;
  /** Runtime-only candidate symlink policy; omitted sources keep strict legacy behavior. */
  symlinkPolicy?: "none" | "external" | "contained";
  trustedContainment?: InventoryTrustedContainment;
  precedenceRank: number;
  status: InventorySourceStatus;
  diagnostic?: InventoryDiagnostic;
  bounds?: InventoryScanBounds;
}

export interface InventoryPathIdentity {
  device: number;
  inode: number;
  birthtimeMs: number;
}

export interface InventoryTrustedContainment {
  rootPath: string;
  rootIdentity: InventoryPathIdentity;
  sourcePath: string;
  sourceIdentity: InventoryPathIdentity;
}

export interface InventoryCandidateProof extends InventoryTrustedContainment {
  candidatePath: string;
  candidateIdentity: InventoryPathIdentity;
  candidateContainment?: "source" | "root" | "external";
}

export interface InventoryPlan {
  sources: InventoryPlanSource[];
  bounds?: InventoryScanBounds;
  /** Adapter-only inputs consumed by exposure resolution; never persisted. */
  runtime?: {
    /** Canonical top-level authority that binds a composed plan to one scan. */
    authority?: {
      home: string;
      cwd: string;
    };
    copilot?: {
      disabledSkills:
        | { status: "known"; names: string[] }
        | { status: "ambiguous" };
      extensions: Array<
        | {
            status: "declared";
            pluginId: string;
            paths: string[];
            exclusive: boolean;
            sourceForm: "string" | "array" | "object";
          }
        | {
            status: "invalid";
            pluginId: string;
            paths: [];
            diagnostic: InventoryDiagnostic;
          }
      >;
      customRoots: Array<{
        origin: "user-settings" | "environment";
        path: string;
      }>;
      pluginOrder: "unverified";
      coverageLimitations: string[];
    };
  };
}

export interface InventoryCandidate {
  path: string;
  roots: SkillRoot[];
  sourceIds: string[];
  trustedProof?: InventoryCandidateProof;
}

export interface InventoryWalkResult {
  candidates: InventoryCandidate[];
  sources: InventorySource[];
}
