import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DiscoveredSkill,
  Finding,
  PortfolioReportV2,
  SkillRoot
} from "./domain.js";
import { portfolioReportV2Schema } from "./domain.js";
import { sha256 } from "./fingerprint.js";
import {
  INVENTORY_SCAN_HARD_MAXIMA,
  InventoryError,
  type InventoryPlan,
  type InventoryPlanSource
} from "./inventory/domain.js";
import {
  buildInventoryPlan,
  type BuildInventoryPlanInput
} from "./inventory/plan.js";
import {
  resolveInventory,
  type ParsedInventoryCandidate
} from "./inventory/resolve.js";
import { compareCodeUnits } from "./inventory/selection.js";
import { walkInventory, walkLegacyInventory } from "./inventory/walk.js";
import { findRepositoryRoot } from "./inventory/workspace.js";
import { analyzeOverlap } from "./overlap.js";
import { parseSkill } from "./parse-skill.js";
import { analyzeSingleSkill } from "./rules/single-skill.js";

function stableFinding(input: Omit<Finding, "id">): Finding {
  return { ...input, id: sha256(JSON.stringify(input)) };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 1_999)}…`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

async function inventoryWorkspace(cwd: string): Promise<string> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  return canonicalPath(repositoryRoot ?? cwd);
}

function customPlan(roots: SkillRoot[]): InventoryPlan {
  const sources: InventoryPlanSource[] = [];
  const seen = new Set<string>();
  let rank = 0;
  for (const root of roots) {
    const harnesses = root.visibleTo.length > 0
      ? [...new Set(root.visibleTo)].sort(compareCodeUnits)
      : ["unknown" as const];
    for (const harness of harnesses) {
      const path = resolve(root.path);
      const id = `custom:${sha256([
        harness,
        root.scope,
        path
      ].join("\0")).slice("sha256:".length)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      sources.push({
        id,
        harness,
        scope: root.scope,
        kind: "convention-root",
        path,
        layout: "children",
        ownership: "direct",
        precedenceRank: rank,
        status: "scanned"
      });
      rank += 1;
    }
  }
  return {
    sources,
    bounds: { ...INVENTORY_SCAN_HARD_MAXIMA }
  };
}

function remapSingleSkillFindings(
  findings: Finding[],
  parsed: ParsedInventoryCandidate,
  resolvedSkillIds: string[]
): Finding[] {
  if (resolvedSkillIds.length === 0) return findings;
  return findings.flatMap((finding) => resolvedSkillIds.map((skillId) => {
    const input = {
      ...finding,
      skillIds: finding.skillIds.map((id) =>
        id === parsed.skill.id ? skillId : id
      )
    };
    const { id: _id, ...withoutId } = input;
    return stableFinding(withoutId);
  }));
}

function portfolioFingerprint(input: {
  workspace: PortfolioReportV2["workspace"];
  skills: PortfolioReportV2["skills"];
  sources: PortfolioReportV2["inventory"]["sources"];
  coverage: PortfolioReportV2["inventory"]["harnesses"];
}): string {
  return sha256(JSON.stringify({
    workspace: input.workspace,
    skills: input.skills,
    sources: input.sources,
    coverage: input.coverage
  }));
}

interface InventoryPlanScanResult {
  report: PortfolioReportV2;
  discoveries: DiscoveredSkill[];
}

async function scanPlanWithDiscovery(
  plan: InventoryPlan,
  workspacePath: string,
  now: Date,
  legacySymlinkCompatibility: boolean
): Promise<InventoryPlanScanResult> {
  const walked = legacySymlinkCompatibility
    ? await walkLegacyInventory(plan)
    : await walkInventory(plan);
  const parsedCandidates: ParsedInventoryCandidate[] = [];
  const singleFindings = new Map<string, Finding[]>();
  const findings: Finding[] = [];

  for (const candidate of walked.candidates) {
    try {
      const skill = await parseSkill(candidate);
      const parsed = { candidate, skill };
      parsedCandidates.push(parsed);
      singleFindings.set(candidate.path, await analyzeSingleSkill(skill));
    } catch (error) {
      findings.push(stableFinding({
        code: "SKILL_PARSE_FAILED",
        severity: "error",
        skillIds: [],
        summary: `Could not parse skill at ${candidate.path}.`,
        evidence: [boundedMessage(error)],
        recommendation: "Repair the SKILL.md frontmatter before relying on this skill.",
        confidence: 1
      }));
    }
  }

  const resolved = resolveInventory(plan, walked.sources, parsedCandidates);
  for (const parsed of parsedCandidates) {
    const ids = resolved.skills
      .filter(({ path }) => path === parsed.candidate.path)
      .map(({ id }) => id);
    findings.push(...remapSingleSkillFindings(
      singleFindings.get(parsed.candidate.path) ?? [],
      parsed,
      ids
    ));
  }
  findings.push(...analyzeOverlap(resolved.skills));
  findings.sort((left, right) =>
    compareCodeUnits(left.code, right.code) || compareCodeUnits(left.id, right.id)
  );

  const workspace = {
    path: workspacePath,
    identity: sha256(workspacePath)
  };
  const report: PortfolioReportV2 = {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    portfolioFingerprint: portfolioFingerprint({
      workspace,
      skills: resolved.skills,
      sources: resolved.sources,
      coverage: resolved.coverage
    }),
    workspace,
    skills: resolved.skills,
    findings,
    inventory: {
      sources: resolved.sources,
      harnesses: resolved.coverage
    }
  };
  return {
    report: portfolioReportV2Schema.parse(report),
    discoveries: walked.candidates.map(({ path, roots }) => ({ path, roots }))
  };
}

async function scanPlan(
  plan: InventoryPlan,
  workspacePath: string,
  now: Date,
  legacySymlinkCompatibility: boolean
): Promise<PortfolioReportV2> {
  return (await scanPlanWithDiscovery(
    plan,
    workspacePath,
    now,
    legacySymlinkCompatibility
  )).report;
}

export async function scanInventory(
  input: BuildInventoryPlanInput,
  now = new Date()
): Promise<PortfolioReportV2> {
  return (await scanInventoryWithDiscovery(input, now)).report;
}

export interface InventoryScanWithDiscoveryResult {
  report: PortfolioReportV2;
  discoveries: DiscoveredSkill[];
}

export async function scanInventoryWithDiscovery(
  input: BuildInventoryPlanInput,
  now = new Date()
): Promise<InventoryScanWithDiscoveryResult> {
  const plan = await buildInventoryPlan(input);
  return scanInventoryPlanWithDiscovery({
    home: input.home,
    cwd: input.cwd,
    plan
  }, now);
}

export interface ScanInventoryPlanInput {
  home: string;
  cwd: string;
  plan: InventoryPlan;
}

/**
 * Scan a plan without rebuilding native adapters. The canonical top-level
 * home and cwd must match the authority captured when the plan was composed.
 */
export async function scanInventoryPlan(
  input: ScanInventoryPlanInput,
  now = new Date()
): Promise<PortfolioReportV2> {
  return (await scanInventoryPlanWithDiscovery(input, now)).report;
}

export async function scanInventoryPlanWithDiscovery(
  input: ScanInventoryPlanInput,
  now = new Date()
): Promise<InventoryScanWithDiscoveryResult> {
  const authority = input.plan.runtime?.authority;
  const [home, cwd] = await Promise.all([
    canonicalPath(input.home),
    canonicalPath(input.cwd)
  ]);
  if (
    authority === undefined ||
    authority.home !== home ||
    authority.cwd !== cwd
  ) {
    throw new InventoryError(
      "INVENTORY_PLAN_AUTHORITY_MISMATCH",
      "Prebuilt inventory plan does not belong to the requested home and workspace"
    );
  }
  return scanPlanWithDiscovery(
    input.plan,
    await inventoryWorkspace(cwd),
    now,
    false
  );
}

export async function scanPortfolio(
  roots: SkillRoot[],
  now = new Date()
): Promise<PortfolioReportV2> {
  const plan = customPlan(roots);
  const workspacePath = await canonicalPath(
    roots[0]?.path ?? process.cwd()
  );
  return scanPlan(plan, workspacePath, now, true);
}
