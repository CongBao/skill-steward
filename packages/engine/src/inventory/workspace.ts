import { lstat, opendir, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve
} from "node:path";
import { ignoredBundleDirectories } from "../parse-skill.js";
import {
  INVENTORY_SCAN_HARD_MAXIMA,
  validateInventoryBound
} from "./domain.js";
import {
  BoundedSmallestStrings,
  compareCodeUnits
} from "./selection.js";

export interface WorkspaceSearchBounds {
  maxDepth: number;
  maxDirectories: number;
}

export interface NestedClaudeRootsResult {
  paths: string[];
  truncated: boolean;
  directoriesVisited: number;
}

export const defaultWorkspaceSearchBounds: WorkspaceSearchBounds = {
  maxDepth: INVENTORY_SCAN_HARD_MAXIMA.maxDepth,
  maxDirectories: INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
};

const ignoredDirectories = new Set<string>(ignoredBundleDirectories);

async function isRepositoryMarker(path: string): Promise<boolean> {
  try {
    const marker = await lstat(path);
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

export async function findRepositoryRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;

  while (true) {
    if (await isRepositoryMarker(join(current, ".git"))) return current;
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

export async function workspaceAncestors(cwd: string): Promise<string[]> {
  const normalizedCwd = resolve(cwd);
  const repositoryRoot = await findRepositoryRoot(normalizedCwd);
  if (!repositoryRoot) return [normalizedCwd];

  const ancestors: string[] = [];
  let current = normalizedCwd;
  while (true) {
    ancestors.push(current);
    if (current === repositoryRoot) return ancestors;
    current = dirname(current);
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`
      ) &&
      !isAbsolute(pathFromRoot)
    );
}

async function canonicalWorkspaceRoot(path: string): Promise<string | undefined> {
  try {
    const physicalPath = await realpath(resolve(path));
    const metadata = await lstat(physicalPath);
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      ? physicalPath
      : undefined;
  } catch {
    return undefined;
  }
}

async function verifyQueuedDirectory(
  root: string,
  path: string
): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    const physicalPath = await realpath(path);
    if (physicalPath !== path || !isContained(root, physicalPath)) {
      return undefined;
    }
    return physicalPath;
  } catch {
    return undefined;
  }
}

async function containedClaudeSkills(
  root: string,
  current: string
): Promise<{ path?: string; refused: boolean }> {
  const claudeRoot = join(current, ".claude");
  const skillsRoot = join(claudeRoot, "skills");
  try {
    const claudeMetadata = await lstat(claudeRoot);
    if (
      !claudeMetadata.isDirectory() ||
      claudeMetadata.isSymbolicLink()
    ) {
      return { refused: true };
    }
    const physicalClaudeRoot = await realpath(claudeRoot);
    if (
      physicalClaudeRoot !== claudeRoot ||
      !isContained(root, physicalClaudeRoot)
    ) {
      return { refused: true };
    }
    const skillsMetadata = await lstat(skillsRoot);
    if (!skillsMetadata.isDirectory() || skillsMetadata.isSymbolicLink()) {
      return { refused: true };
    }
    const physicalPath = await realpath(skillsRoot);
    if (!isContained(root, physicalPath)) return { refused: true };
    return { path: physicalPath, refused: false };
  } catch {
    return { refused: false };
  }
}

async function hasRegularSkillMarker(path: string): Promise<boolean> {
  try {
    const marker = await lstat(join(path, "SKILL.md"));
    return marker.isFile() && !marker.isSymbolicLink();
  } catch {
    return false;
  }
}

interface WorkspaceDiscoveryHooks {
  onDirectoryQueued?(path: string): Promise<void> | void;
}

async function discoverNestedClaudeSkillRootsInternal(
  workspaceRoot: string,
  bounds: WorkspaceSearchBounds,
  hooks?: WorkspaceDiscoveryHooks
): Promise<NestedClaudeRootsResult> {
  validateInventoryBound(
    bounds.maxDepth,
    "workspace bounds.maxDepth",
    INVENTORY_SCAN_HARD_MAXIMA.maxDepth
  );
  validateInventoryBound(
    bounds.maxDirectories,
    "workspace bounds.maxDirectories",
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );
  if (bounds.maxDirectories === 0) {
    return { paths: [], truncated: true, directoriesVisited: 0 };
  }

  const root = await canonicalWorkspaceRoot(workspaceRoot);
  if (!root) return { paths: [], truncated: false, directoriesVisited: 0 };

  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const queuedPaths = new Set([root]);
  const paths = new Set<string>();
  let nextIndex = 0;
  let directoriesVisited = 0;
  let truncated = false;

  while (nextIndex < queue.length) {
    const current = queue[nextIndex];
    nextIndex += 1;
    if (!current) continue;
    directoriesVisited += 1;

    const verifiedPath = await verifyQueuedDirectory(root, current.path);
    if (!verifiedPath) {
      truncated = true;
      continue;
    }
    if (await hasRegularSkillMarker(verifiedPath)) continue;

    const claudeSkills = await containedClaudeSkills(root, verifiedPath);
    if (claudeSkills.path) paths.add(claudeSkills.path);
    if (claudeSkills.refused) truncated = true;

    const pendingDirectories = queue.length - nextIndex;
    const remainingCapacity = current.depth < bounds.maxDepth
      ? Math.max(
          0,
          bounds.maxDirectories - directoriesVisited - pendingDirectories
        )
      : 0;
    const selected = new BoundedSmallestStrings(remainingCapacity);
    try {
      const directory = await opendir(verifiedPath);
      for await (const entry of directory) {
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          entry.name !== ".claude" &&
          !ignoredDirectories.has(entry.name)
        ) {
          selected.add(entry.name);
        }
      }
    } catch {
      truncated = true;
      continue;
    }
    if (selected.truncated) truncated = true;
    if (current.depth >= bounds.maxDepth) continue;

    for (const entryName of selected.values()) {
      const childPath = join(verifiedPath, entryName);
      const physicalChild = await verifyQueuedDirectory(root, childPath);
      if (!physicalChild) {
        truncated = true;
        continue;
      }
      if (queuedPaths.has(physicalChild)) continue;
      queuedPaths.add(physicalChild);
      queue.push({ path: physicalChild, depth: current.depth + 1 });
      await hooks?.onDirectoryQueued?.(physicalChild);
    }
  }

  return {
    paths: [...paths].sort(compareCodeUnits),
    truncated,
    directoriesVisited
  };
}

export async function discoverNestedClaudeSkillRoots(
  workspaceRoot: string,
  bounds: WorkspaceSearchBounds = defaultWorkspaceSearchBounds
): Promise<NestedClaudeRootsResult> {
  return discoverNestedClaudeSkillRootsInternal(workspaceRoot, bounds);
}

export async function discoverNestedClaudeSkillRootsWithHooks(
  workspaceRoot: string,
  bounds: WorkspaceSearchBounds,
  hooks: WorkspaceDiscoveryHooks
): Promise<NestedClaudeRootsResult> {
  return discoverNestedClaudeSkillRootsInternal(workspaceRoot, bounds, hooks);
}
