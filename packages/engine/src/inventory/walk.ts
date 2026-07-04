import { open, lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { InventorySource, SkillRoot } from "../domain.js";
import {
  createInventoryDiagnostic as diagnostic,
  defaultInventoryScanBounds,
  sanitizeInventoryDiagnostic,
  validateInventoryScanBounds,
  type InventoryCandidate,
  type InventoryCandidateProof,
  type InventoryDiagnostic,
  type InventoryPathIdentity,
  type InventoryPlan,
  type InventoryPlanSource,
  type InventoryScanBounds,
  type InventoryWalkResult
} from "./domain.js";
import {
  BoundedSmallestStrings,
  compareCodeUnits
} from "./selection.js";

interface CandidateMapEntry extends InventoryCandidate {
  sourceIds: string[];
  roots: SkillRoot[];
}

interface SourceWalkResult {
  candidates: SourceCandidate[];
  directoriesVisited: number;
  newSkillCount: number;
  status: InventorySource["status"];
  diagnostic?: InventoryDiagnostic;
}

interface SkillInspection {
  path?: string;
  identity?: InventoryPathIdentity;
  containmentChanged: boolean;
}

interface SourceCandidate {
  path: string;
  trustedProof?: InventoryCandidateProof;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function readablePhysicalSkill(
  path: string,
  allowSymlinkRoot = false,
  allowSymlinkMarker = false,
  trustedContainment?: InventoryPlanSource["trustedContainment"],
  candidateContainment: "source" | "root" | "external" = "source"
): Promise<SkillInspection> {
  let candidateMetadata;
  try {
    candidateMetadata = await lstat(path);
    if (candidateMetadata.isSymbolicLink()) {
      if (!allowSymlinkRoot) {
        return { containmentChanged: trustedContainment !== undefined };
      }
    } else if (!candidateMetadata.isDirectory()) {
      return { containmentChanged: false };
    }
  } catch {
    return { containmentChanged: false };
  }

  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch {
    return { containmentChanged: false };
  }
  let physicalMetadata;
  try {
    physicalMetadata = await lstat(physicalPath);
    if (physicalMetadata.isSymbolicLink() || !physicalMetadata.isDirectory()) {
      return { containmentChanged: trustedContainment !== undefined };
    }
  } catch {
    return { containmentChanged: trustedContainment !== undefined };
  }
  if (
    trustedContainment &&
    (
      (
        candidateContainment !== "external" &&
        !isContainedPath(trustedContainment.rootPath, physicalPath)
      ) ||
      (
        candidateContainment === "source" &&
        !isContainedPath(trustedContainment.sourcePath, physicalPath)
      )
    )
  ) {
    return { containmentChanged: true };
  }

  let skillFile;
  const markerPath = join(physicalPath, "SKILL.md");
  try {
    skillFile = await lstat(markerPath);
  } catch {
    return { containmentChanged: false };
  }
  if (skillFile.isSymbolicLink()) {
    if (!allowSymlinkMarker) {
      return { containmentChanged: trustedContainment !== undefined };
    }
    try {
      if (!(await stat(markerPath)).isFile()) {
        return { containmentChanged: false };
      }
    } catch {
      return { containmentChanged: false };
    }
  } else if (!skillFile.isFile()) {
    return { containmentChanged: false };
  }

  let handle;
  try {
    handle = await open(markerPath, "r");
    return {
      path: physicalPath,
      identity: {
        device: physicalMetadata.dev,
        inode: physicalMetadata.ino,
        birthtimeMs: physicalMetadata.birthtimeMs
      },
      containmentChanged: false
    };
  } catch {
    return { containmentChanged: false };
  } finally {
    await handle?.close();
  }
}

function candidateProof(
  containment: NonNullable<InventoryPlanSource["trustedContainment"]>,
  candidatePath: string,
  candidateIdentity: InventoryPathIdentity,
  candidateContainment: "source" | "root" | "external"
): InventoryCandidateProof {
  return {
    ...containment,
    candidatePath,
    candidateIdentity,
    candidateContainment
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

function matchesIdentity(
  metadata: { dev: number; ino: number; birthtimeMs: number },
  expected: { device: number; inode: number; birthtimeMs: number }
): boolean {
  return metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.birthtimeMs === expected.birthtimeMs;
}

function containmentChanged(path: string): SourceWalkResult {
  return {
    candidates: [],
    directoriesVisited: 0,
    newSkillCount: 0,
    status: "invalid",
    diagnostic: diagnostic(
      "INVENTORY_SOURCE_CONTAINMENT_CHANGED",
      `Inventory source containment changed after planning: ${path}`
    )
  };
}

async function validateSourceRoot(source: InventoryPlanSource): Promise<
  { path: string } | SourceWalkResult
> {
  const path = resolve(source.path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      try {
        const parent = await lstat(dirname(path));
        if (!parent.isDirectory()) {
          return {
            candidates: [],
            directoriesVisited: 0,
            newSkillCount: 0,
            status: "unreadable",
            diagnostic: diagnostic(
              "INVENTORY_SOURCE_UNREADABLE",
              `Inventory source has an unreadable parent: ${path}`
            )
          };
        }
      } catch (parentError) {
        if (errorCode(parentError) !== "ENOENT") {
          return {
            candidates: [],
            directoriesVisited: 0,
            newSkillCount: 0,
            status: "unreadable",
            diagnostic: diagnostic(
              "INVENTORY_SOURCE_UNREADABLE",
              `Inventory source parent is unreadable: ${path}`
            )
          };
        }
      }
      return {
        candidates: [],
        directoriesVisited: 0,
        newSkillCount: 0,
        status: "missing",
        diagnostic: diagnostic(
          "INVENTORY_SOURCE_MISSING",
          `Inventory source is missing: ${path}`
        )
      };
    }
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: "unreadable",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_UNREADABLE",
        `Inventory source is unreadable: ${path}`
      )
    };
  }

  if (metadata.isSymbolicLink() && source.symlinkPolicy === "none") {
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: "invalid",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_SYMLINK",
        `Inventory source symlink is disallowed by policy: ${path}`
      )
    };
  }

  if (source.trustedContainment) {
    const trusted = source.trustedContainment;
    const trustedExternalAlias = metadata.isSymbolicLink() &&
      source.symlinkPolicy === "external";
    if (!metadata.isDirectory() && !trustedExternalAlias) {
      return containmentChanged(path);
    }
    try {
      const physicalPath = await realpath(path);
      const rootMetadata = await lstat(trusted.rootPath);
      const physicalMetadata = await lstat(physicalPath);
      const physicalRoot = await realpath(trusted.rootPath);
      if (
        rootMetadata.isSymbolicLink() ||
        !rootMetadata.isDirectory() ||
        physicalMetadata.isSymbolicLink() ||
        !physicalMetadata.isDirectory() ||
        physicalRoot !== trusted.rootPath ||
        physicalPath !== trusted.sourcePath ||
        !isContainedPath(physicalRoot, physicalPath) ||
        !matchesIdentity(rootMetadata, trusted.rootIdentity) ||
        !matchesIdentity(physicalMetadata, trusted.sourceIdentity)
      ) {
        return containmentChanged(path);
      }
      return { path: physicalPath };
    } catch {
      return containmentChanged(path);
    }
  }

  if (metadata.isSymbolicLink()) {
    let physicalPath: string;
    try {
      physicalPath = await realpath(path);
    } catch {
      return {
        candidates: [],
        directoriesVisited: 0,
        newSkillCount: 0,
        status: "unreadable",
        diagnostic: diagnostic(
          "INVENTORY_SOURCE_UNREADABLE",
          `Inventory source cannot be resolved: ${path}`
        )
      };
    }
    try {
      const physicalMetadata = await lstat(physicalPath);
      if (!physicalMetadata.isDirectory()) {
        return {
          candidates: [],
          directoriesVisited: 0,
          newSkillCount: 0,
          status: "invalid",
          diagnostic: diagnostic(
            "INVENTORY_SOURCE_NOT_DIRECTORY",
            `Inventory source is not a directory: ${path}`
          )
        };
      }
    } catch {
      return {
        candidates: [],
        directoriesVisited: 0,
        newSkillCount: 0,
        status: "unreadable",
        diagnostic: diagnostic(
          "INVENTORY_SOURCE_UNREADABLE",
          `Inventory source cannot be inspected: ${path}`
        )
      };
    }
    return { path: physicalPath };
  }
  if (!metadata.isDirectory()) {
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: "invalid",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_NOT_DIRECTORY",
        `Inventory source is not a directory: ${path}`
      )
    };
  }

  try {
    return { path: await realpath(path) };
  } catch {
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: "unreadable",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_UNREADABLE",
        `Inventory source cannot be resolved: ${path}`
      )
    };
  }
}

function isWalkResult(
  value: { path: string } | SourceWalkResult
): value is SourceWalkResult {
  return "candidates" in value;
}

async function walkSource(
  source: InventoryPlanSource,
  allowSymlinkCandidates: boolean,
  bounds: InventoryScanBounds,
  knownPhysicalPaths: ReadonlySet<string>
): Promise<SourceWalkResult> {
  const candidateContainment = source.symlinkPolicy === "external"
    ? "external"
    : source.symlinkPolicy === "contained"
      ? "root"
      : "source";
  const allowSourceSymlinkCandidates = allowSymlinkCandidates || (
    source.trustedContainment !== undefined && (
      source.symlinkPolicy === "external" || source.symlinkPolicy === "contained"
    )
  );
  if (source.status !== "scanned" && source.inspectSkills !== true) {
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: source.status,
      ...(source.diagnostic ? { diagnostic: source.diagnostic } : {})
    };
  }

  if (bounds.maxDirectories < 1) {
    return {
      candidates: [],
      directoriesVisited: 0,
      newSkillCount: 0,
      status: "truncated",
      diagnostic: diagnostic(
        "INVENTORY_DIRECTORY_LIMIT",
        "Inventory directory limit reached"
      )
    };
  }
  const validated = await validateSourceRoot(source);
  if (isWalkResult(validated)) return validated;

  if (source.layout === "self") {
    const inspection = await readablePhysicalSkill(
      validated.path,
      allowSourceSymlinkCandidates,
      allowSymlinkCandidates,
      source.trustedContainment,
      candidateContainment
    );
    if (inspection.containmentChanged) {
      return containmentChanged(validated.path);
    }
    if (!inspection.path) {
      return {
        candidates: [],
        directoriesVisited: 1,
        newSkillCount: 0,
        status: "invalid",
        diagnostic: diagnostic(
          "INVENTORY_SOURCE_NOT_SKILL",
          `Inventory source is not a Skill: ${validated.path}`
        )
      };
    }
    const physical = inspection.path;
    const candidate: SourceCandidate = source.trustedContainment && inspection.identity
      ? {
          path: physical,
          trustedProof: candidateProof(
            source.trustedContainment,
            physical,
            inspection.identity,
            candidateContainment
          )
        }
      : { path: physical };
    const alreadyKnown = knownPhysicalPaths.has(physical);
    if (bounds.maxSkills < 1 && !alreadyKnown) {
      return {
        candidates: [],
        directoriesVisited: 1,
        newSkillCount: 0,
        status: "truncated",
        diagnostic: diagnostic(
          "INVENTORY_SKILL_LIMIT",
          "Inventory Skill limit reached"
        )
      };
    }
    return {
      candidates: [candidate],
      directoriesVisited: 1,
      newSkillCount: alreadyKnown ? 0 : 1,
      status: "scanned"
    };
  }

  if (bounds.maxDepth < 1) {
    return {
      candidates: [],
      directoriesVisited: 1,
      newSkillCount: 0,
      status: "truncated",
      diagnostic: diagnostic(
        "INVENTORY_DEPTH_LIMIT",
        "Inventory depth limit prevents child discovery"
      )
    };
  }

  const selected = new BoundedSmallestStrings(
    Math.max(0, bounds.maxDirectories - 1)
  );
  const excludedChildPaths = new Set(
    (source.excludedChildPaths ?? []).map((path) => resolve(path))
  );
  try {
    const directory = await opendir(validated.path);
    for await (const entry of directory) {
      if (
        !excludedChildPaths.has(resolve(validated.path, entry.name)) &&
        (
          entry.isDirectory() ||
          (
            (source.trustedContainment !== undefined || allowSourceSymlinkCandidates) &&
            entry.isSymbolicLink()
          )
        )
      ) {
        selected.add(entry.name);
      }
    }
  } catch {
    return {
      candidates: [],
      directoriesVisited: 1,
      newSkillCount: 0,
      status: "unreadable",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_UNREADABLE",
        `Inventory source cannot be listed: ${validated.path}`
      )
    };
  }

  const candidates: SourceCandidate[] = [];
  const candidateSet = new Set<string>();
  let directoriesVisited = 1;
  let newSkillCount = 0;
  let skillLimitReached = false;
  let candidateContainmentChanged = false;
  for (const entryName of selected.values()) {
    directoriesVisited += 1;
    const inspection = await readablePhysicalSkill(
      join(validated.path, entryName),
      allowSourceSymlinkCandidates,
      allowSymlinkCandidates,
      source.trustedContainment,
      candidateContainment
    );
    if (inspection.containmentChanged) {
      candidateContainmentChanged = true;
      continue;
    }
    const candidate = inspection.path;
    if (!candidate || candidateSet.has(candidate)) continue;
    const alreadyKnown = knownPhysicalPaths.has(candidate);
    if (!alreadyKnown && newSkillCount >= bounds.maxSkills) {
      skillLimitReached = true;
      continue;
    }
    candidateSet.add(candidate);
    candidates.push(source.trustedContainment && inspection.identity
      ? {
          path: candidate,
          trustedProof: candidateProof(
            source.trustedContainment,
            candidate,
            inspection.identity,
            candidateContainment
          )
        }
      : { path: candidate });
    if (!alreadyKnown) newSkillCount += 1;
  }

  if (candidateContainmentChanged) {
    return {
      candidates,
      directoriesVisited,
      newSkillCount,
      status: "invalid",
      diagnostic: diagnostic(
        "INVENTORY_SOURCE_CONTAINMENT_CHANGED",
        `Inventory candidate containment changed after planning: ${validated.path}`
      )
    };
  }

  if (selected.truncated) {
    return {
      candidates,
      directoriesVisited,
      newSkillCount,
      status: "truncated",
      diagnostic: diagnostic(
        "INVENTORY_DIRECTORY_LIMIT",
        "Inventory directory limit reached"
      )
    };
  }

  return {
    candidates,
    directoriesVisited,
    newSkillCount,
    status: skillLimitReached ? "truncated" : "scanned",
    ...(skillLimitReached
      ? {
          diagnostic: diagnostic(
            "INVENTORY_SKILL_LIMIT",
            "Inventory Skill limit reached"
          )
        }
      : {})
  };
}

function persistedSource(
  source: InventoryPlanSource,
  result: SourceWalkResult
): InventorySource {
  return {
    id: source.id,
    harness: source.harness,
    scope: source.scope,
    kind: source.kind,
    path: resolve(source.path),
    ...(source.manifestPath ? { manifestPath: source.manifestPath } : {}),
    ...(source.plugin ? { plugin: source.plugin } : {}),
    status: result.status,
    skillCount: result.candidates.length,
    effectiveSkillCount: 0,
    ...(result.diagnostic
      ? { diagnostic: sanitizeInventoryDiagnostic(result.diagnostic) }
      : {})
  };
}

async function walk(
  plan: InventoryPlan,
  allowSymlinkCandidates: boolean
): Promise<InventoryWalkResult> {
  const byPhysicalPath = new Map<string, CandidateMapEntry>();
  const sources: InventorySource[] = [];
  const globalBounds = plan.bounds ?? defaultInventoryScanBounds;
  validateInventoryScanBounds(globalBounds, "plan.bounds");
  plan.sources.forEach((source, index) => {
    if (source.bounds) {
      validateInventoryScanBounds(source.bounds, `sources[${index}].bounds`);
    }
  });
  let directoriesVisited = 0;
  let skillsVisited = 0;

  for (const source of plan.sources) {
    const sourceBounds = source.bounds ?? defaultInventoryScanBounds;
    const bounds: InventoryScanBounds = {
      maxDepth: Math.min(globalBounds.maxDepth, sourceBounds.maxDepth),
      maxDirectories: Math.max(
        0,
        Math.min(
          sourceBounds.maxDirectories,
          globalBounds.maxDirectories - directoriesVisited
        )
      ),
      maxSkills: Math.max(
        0,
        Math.min(sourceBounds.maxSkills, globalBounds.maxSkills - skillsVisited)
      )
    };
    const result = await walkSource(
      source,
      allowSymlinkCandidates,
      bounds,
      new Set(byPhysicalPath.keys())
    );
    const persistedResult: SourceWalkResult = (
      source.inspectSkills === true &&
      source.status !== "scanned" &&
      result.status === "scanned"
    )
      ? {
          ...result,
          status: source.status,
          ...(source.diagnostic ? { diagnostic: source.diagnostic } : {})
        }
      : result;
    directoriesVisited += persistedResult.directoriesVisited;
    skillsVisited += persistedResult.newSkillCount;
    sources.push(persistedSource(source, persistedResult));
    for (const candidate of persistedResult.candidates) {
      const physicalPath = candidate.path;
      const visibleTo = source.visibleTo ?? [source.harness];
      const root: SkillRoot = {
        path: source.path,
        scope: source.scope,
        visibleTo: [...visibleTo]
      };
      const existing = byPhysicalPath.get(physicalPath);
      if (existing) {
        existing.sourceIds.push(source.id);
        existing.roots.push(root);
        if (!existing.trustedProof && candidate.trustedProof) {
          existing.trustedProof = candidate.trustedProof;
        }
      } else {
        byPhysicalPath.set(physicalPath, {
          path: physicalPath,
          sourceIds: [source.id],
          roots: [root],
          ...(candidate.trustedProof
            ? { trustedProof: candidate.trustedProof }
            : {})
        });
      }
    }
  }

  return {
    candidates: [...byPhysicalPath.values()].sort((left, right) =>
      compareCodeUnits(left.path, right.path)
    ),
    sources
  };
}

export async function walkInventory(
  plan: InventoryPlan
): Promise<InventoryWalkResult> {
  return walk(plan, false);
}

export async function walkLegacyInventory(
  plan: InventoryPlan
): Promise<InventoryWalkResult> {
  return walk(plan, true);
}
