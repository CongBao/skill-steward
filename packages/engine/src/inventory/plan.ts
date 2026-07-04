import { realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import type { HarnessId, SkillRoot } from "../domain.js";
import { sha256 } from "../fingerprint.js";
import { standardRootCatalog } from "../root-catalog.js";
import {
  planClaudeCodeInventory,
  type ClaudeCodeInventoryInput
} from "./adapters/claude-code.js";
import {
  planCodexInventory,
  type CodexInventoryInput
} from "./adapters/codex.js";
import {
  planGitHubCopilotInventory,
  type GitHubCopilotInventoryInput
} from "./adapters/github-copilot.js";
import {
  INVENTORY_SCAN_HARD_MAXIMA,
  validateInventoryBound,
  type InventoryPlan,
  type InventoryPlanSource,
  type InventoryScanBounds
} from "./domain.js";
import { compareCodeUnits } from "./selection.js";

const NATIVE_PLUGIN_HARD_MAX = 100;
const coreHarnesses = new Set<HarnessId>([
  "codex",
  "claude",
  "github-copilot"
]);

type AdapterOptions<T extends { home: string; cwd: string }> = Omit<
  T,
  "home" | "cwd"
>;

type CodexPlanner = (input: CodexInventoryInput) => Promise<InventoryPlan>;
type ClaudePlanner = (input: ClaudeCodeInventoryInput) => Promise<InventoryPlan>;
type CopilotPlanner = (
  input: GitHubCopilotInventoryInput
) => Promise<InventoryPlan>;

export interface BuildInventoryPlanInput {
  home: string;
  cwd: string;
  codex?: AdapterOptions<CodexInventoryInput>;
  claude?: AdapterOptions<ClaudeCodeInventoryInput>;
  copilot?: AdapterOptions<GitHubCopilotInventoryInput>;
  limits?: Partial<InventoryScanBounds> & { maxPlugins?: number };
  /** Deterministic adapter seams for fixture tests; never persisted. */
  plannerOverrides?: {
    codex?: CodexPlanner;
    claude?: ClaudePlanner;
    copilot?: CopilotPlanner;
  };
}

function conventionSource(
  root: SkillRoot,
  harness: HarnessId,
  precedenceRank: number
): InventoryPlanSource {
  const path = resolve(root.path);
  return {
    id: `convention:${sha256([
      harness,
      root.scope,
      path
    ].join("\0")).slice("sha256:".length)}`,
    harness,
    scope: root.scope,
    kind: "convention-root",
    path,
    layout: "children",
    ownership: "direct",
    precedenceRank,
    status: "scanned"
  };
}

function countPluginIdentities(plan: InventoryPlan): number {
  return new Set(plan.sources.flatMap((source) =>
    source.ownership === "native-plugin" && source.plugin
      ? [`${source.harness}\0${source.plugin.id}`]
      : []
  )).size;
}

function adapterLimit(
  requested: number | undefined,
  remaining: number
): number {
  return Math.min(requested ?? remaining, remaining);
}

function residualDirectories(
  plan: InventoryPlan,
  previous: number
): number {
  return Math.min(previous, plan.bounds?.maxDirectories ?? previous);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

export async function buildInventoryPlan(
  input: BuildInventoryPlanInput
): Promise<InventoryPlan> {
  const authority = {
    home: await canonicalPath(input.home),
    cwd: await canonicalPath(input.cwd)
  };
  const bounds = {
    maxDepth: input.limits?.maxDepth ?? INVENTORY_SCAN_HARD_MAXIMA.maxDepth,
    maxDirectories: input.limits?.maxDirectories ??
      INVENTORY_SCAN_HARD_MAXIMA.maxDirectories,
    maxSkills: input.limits?.maxSkills ?? INVENTORY_SCAN_HARD_MAXIMA.maxSkills
  };
  const maxPlugins = input.limits?.maxPlugins ?? NATIVE_PLUGIN_HARD_MAX;
  validateInventoryBound(
    bounds.maxDepth,
    "inventory limits.maxDepth",
    INVENTORY_SCAN_HARD_MAXIMA.maxDepth
  );
  validateInventoryBound(
    bounds.maxDirectories,
    "inventory limits.maxDirectories",
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );
  validateInventoryBound(
    bounds.maxSkills,
    "inventory limits.maxSkills",
    INVENTORY_SCAN_HARD_MAXIMA.maxSkills
  );
  validateInventoryBound(
    maxPlugins,
    "inventory limits.maxPlugins",
    NATIVE_PLUGIN_HARD_MAX
  );

  const planners = {
    codex: input.plannerOverrides?.codex ?? planCodexInventory,
    claude: input.plannerOverrides?.claude ?? planClaudeCodeInventory,
    copilot: input.plannerOverrides?.copilot ?? planGitHubCopilotInventory
  };
  const plans: InventoryPlan[] = [];
  let remainingPlugins = maxPlugins;
  let remainingDirectories = bounds.maxDirectories;

  const codex = await planners.codex({
    ...input.codex,
    home: input.home,
    cwd: input.cwd,
    limits: {
      maxPlugins: adapterLimit(
        input.codex?.limits?.maxPlugins,
        remainingPlugins
      ),
      maxDirectories: adapterLimit(
        input.codex?.limits?.maxDirectories,
        remainingDirectories
      )
    }
  });
  plans.push(codex);
  remainingPlugins = Math.max(
    0,
    remainingPlugins - countPluginIdentities(codex)
  );
  remainingDirectories = residualDirectories(codex, remainingDirectories);

  const claude = await planners.claude({
    ...input.claude,
    home: input.home,
    cwd: input.cwd,
    limits: {
      maxPlugins: adapterLimit(
        input.claude?.limits?.maxPlugins,
        remainingPlugins
      ),
      maxDirectories: adapterLimit(
        input.claude?.limits?.maxDirectories,
        remainingDirectories
      )
    }
  });
  plans.push(claude);
  remainingPlugins = Math.max(
    0,
    remainingPlugins - countPluginIdentities(claude)
  );
  remainingDirectories = residualDirectories(claude, remainingDirectories);

  const copilot = await planners.copilot({
    ...input.copilot,
    home: input.home,
    cwd: input.cwd,
    limits: {
      maxPlugins: adapterLimit(
        input.copilot?.limits?.maxPlugins,
        remainingPlugins
      ),
      maxDirectories: adapterLimit(
        input.copilot?.limits?.maxDirectories,
        remainingDirectories
      )
    }
  });
  plans.push(copilot);
  remainingDirectories = residualDirectories(copilot, remainingDirectories);

  const sources = plans.flatMap(({ sources: adapterSources }) => adapterSources);
  let conventionRank = sources.length;
  for (const root of standardRootCatalog({ home: input.home, cwd: input.cwd })) {
    for (const harness of [...root.visibleTo].sort(compareCodeUnits)) {
      if (coreHarnesses.has(harness)) continue;
      sources.push(conventionSource(root, harness, conventionRank));
      conventionRank += 1;
    }
  }

  const uniqueSources = new Map<string, InventoryPlanSource>();
  for (const source of sources) {
    if (!uniqueSources.has(source.id)) uniqueSources.set(source.id, source);
  }
  return {
    sources: [...uniqueSources.values()],
    bounds: {
      maxDepth: bounds.maxDepth,
      maxDirectories: remainingDirectories,
      maxSkills: bounds.maxSkills
    },
    runtime: {
      authority,
      ...copilot.runtime
    }
  };
}

export interface MutableSkillRoot extends SkillRoot {
  excludedPaths: string[];
}

export type AuthorityPathPlatform = "posix" | "win32";
export type AuthorityPathRelation =
  | "equal"
  | "candidate-descendant"
  | "candidate-ancestor"
  | "disjoint";

function authorityPlatform(): AuthorityPathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

export function normalizeAuthorityPath(
  path: string,
  platform: AuthorityPathPlatform = authorityPlatform()
): string {
  const toolkit = platform === "win32" ? win32 : posix;
  const normalized = toolkit.resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function classifyPathRelation(
  root: string,
  candidate: string,
  platform: AuthorityPathPlatform = authorityPlatform()
): AuthorityPathRelation {
  const toolkit = platform === "win32" ? win32 : posix;
  const normalizedRoot = normalizeAuthorityPath(root, platform);
  const normalizedCandidate = normalizeAuthorityPath(candidate, platform);
  if (normalizedCandidate === normalizedRoot) return "equal";
  if (normalizedCandidate.startsWith(`${normalizedRoot}${toolkit.sep}`)) {
    return "candidate-descendant";
  }
  if (normalizedRoot.startsWith(`${normalizedCandidate}${toolkit.sep}`)) {
    return "candidate-ancestor";
  }
  return "disjoint";
}

export function mutableRootAuthorizes(
  root: SkillRoot & { excludedPaths?: string[] },
  candidate: string,
  platform: AuthorityPathPlatform = authorityPlatform()
): boolean {
  if (classifyPathRelation(root.path, candidate, platform) !== "candidate-descendant") {
    return false;
  }
  return (root.excludedPaths ?? []).every((excludedPath) =>
    classifyPathRelation(excludedPath, candidate, platform) === "disjoint"
  );
}

export function activeMutableRoots(plan: InventoryPlan): MutableSkillRoot[] {
  const byRoot = new Map<string, MutableSkillRoot>();
  for (const source of plan.sources) {
    const directRootKind = source.kind === "direct-root" ||
      source.kind === "inherited-root" ||
      source.kind === "convention-root";
    if (
      source.status !== "scanned" ||
      source.ownership !== "direct" ||
      !directRootKind
    ) {
      continue;
    }
    const path = normalizeAuthorityPath(source.path);
    const key = `${source.scope}\0${path}`;
    const visibleTo = source.visibleTo ?? [source.harness];
    const existing = byRoot.get(key);
    if (existing) {
      existing.visibleTo = uniqueHarnesses([
        ...existing.visibleTo,
        ...visibleTo
      ]);
      existing.excludedPaths = uniquePaths([
        ...existing.excludedPaths,
        ...(source.excludedChildPaths ?? [])
      ]);
    } else {
      byRoot.set(key, {
        path,
        scope: source.scope,
        visibleTo: uniqueHarnesses(visibleTo),
        excludedPaths: uniquePaths(source.excludedChildPaths ?? [])
      });
    }
  }
  const authorityExclusions = plan.sources
    .filter(({ ownership }) => ownership === "native-plugin")
    .map(({ path }) => normalizeAuthorityPath(path))
    .sort(compareCodeUnits);
  for (const [key, root] of byRoot) {
    const overlaps = uniquePaths([...root.excludedPaths, ...authorityExclusions]);
    const strictChildren: string[] = [];
    let rootDenied = false;
    for (const excludedPath of overlaps) {
      const relation = classifyPathRelation(root.path, excludedPath);
      if (relation === "equal" || relation === "candidate-ancestor") {
        rootDenied = true;
        break;
      }
      if (relation === "candidate-descendant") {
        strictChildren.push(excludedPath);
      }
    }
    if (rootDenied) {
      byRoot.delete(key);
      continue;
    }
    root.excludedPaths = minimalExcludedPaths(strictChildren);
  }
  return [...byRoot.values()].sort((left, right) =>
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.scope, right.scope)
  );
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((path) => normalizeAuthorityPath(path)))]
    .sort(compareCodeUnits);
}

function minimalExcludedPaths(values: string[]): string[] {
  const minimal: string[] = [];
  for (const value of uniquePaths(values)) {
    if (minimal.some((parent) =>
      classifyPathRelation(parent, value) === "candidate-descendant"
    )) {
      continue;
    }
    minimal.push(value);
  }
  return minimal;
}

function uniqueHarnesses(values: HarnessId[]): HarnessId[] {
  return [...new Set(values)].sort(compareCodeUnits);
}
