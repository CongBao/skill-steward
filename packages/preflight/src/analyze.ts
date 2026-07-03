import { sha256, type Finding, type Severity } from "@skill-steward/engine";
import {
  normalizePreflightCandidates,
  type AnalyzePreflightInputV2,
  type NormalizedPreflightCandidate
} from "./candidates.js";
import { PREFLIGHT_CONFIG } from "./config.js";
import {
  PREFLIGHT_ALGORITHM_VERSION,
  PREFLIGHT_SCHEMA_VERSION,
  preflightRequestSchema,
  preflightResultSchema,
  type PreflightCandidate,
  type PreflightReason,
  type PreflightResult
} from "./domain.js";
import { normalizeTask, tokenize } from "./tokenize.js";

export type AnalyzePreflightInput = AnalyzePreflightInputV2;

interface ScoredCandidate {
  candidate: NormalizedPreflightCandidate;
  routeTerms: Set<string>;
  matchedTaskTerms: Set<string>;
  relevance: number;
  adjustedRelevance: number;
  riskPenalty: number;
  installPenalty: number;
  nameMatch: boolean;
  plausible: boolean;
  critical: boolean;
  initialReasons: PreflightReason[];
}

interface SelectedCandidate {
  candidate: ScoredCandidate;
  uniqueCoverage: number;
  redundancyPenalty: number;
}

const severityRank: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3
};

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((term) => right.has(term)));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  return intersection(left, right).size / new Set([...left, ...right]).size;
}

function stableNumber(value: number): number {
  return Number(value.toFixed(6));
}

function candidateRisk(findings: Finding[]): number {
  return clamp(findings.reduce(
    (total, { severity }) => total + PREFLIGHT_CONFIG.riskWeights[severity],
    0
  ));
}

function highestSeverity(findings: Finding[]): Severity | null {
  return findings.reduce<Severity | null>((highest, finding) => {
    if (!highest || severityRank[finding.severity] > severityRank[highest]) {
      return finding.severity;
    }
    return highest;
  }, null);
}

function matchesName(
  normalizedTask: string,
  taskTerms: Set<string>,
  candidate: NormalizedPreflightCandidate
): boolean {
  const normalizedName = normalizeTask(candidate.name)
    .toLowerCase()
    .replace(/[-_]+/g, " ");
  if (
    normalizedTask.includes(normalizedName) ||
    normalizedTask.includes(normalizedName.replaceAll(" ", "-"))
  ) {
    return true;
  }
  const nameTerms = tokenize(candidate.name.replace(/[-_]+/g, " ")).terms;
  return nameTerms.length > 0 && nameTerms.every((term) => taskTerms.has(term));
}

function scoreCandidates(
  task: string,
  normalizedCandidates: NormalizedPreflightCandidate[]
): { candidates: ScoredCandidate[]; taskTerms: Set<string>; taskTermOrder: string[] } {
  const tokenizedTask = tokenize(task);
  const taskTerms = new Set(tokenizedTask.terms);
  const normalizedTask = normalizeTask(task).toLowerCase();
  const candidates = normalizedCandidates.map((candidate): ScoredCandidate => {
    const routeTerms = new Set(
      tokenize(`${candidate.name.replace(/[-_]+/g, " ")} ${candidate.description}`).terms
    );
    const matchedTaskTerms = intersection(taskTerms, routeTerms);
    const taskCoverage = ratio(matchedTaskTerms.size, taskTerms.size);
    const skillPrecision = ratio(matchedTaskTerms.size, routeTerms.size);
    const nameMatch = matchesName(normalizedTask, taskTerms, candidate);
    const projectFit = candidate.scope === "project" ? 1 : 0;
    const relevance = clamp(
      taskCoverage * PREFLIGHT_CONFIG.taskCoverageWeight +
      skillPrecision * PREFLIGHT_CONFIG.skillPrecisionWeight +
      (nameMatch ? PREFLIGHT_CONFIG.nameMatchWeight : 0) +
      projectFit * PREFLIGHT_CONFIG.projectScopeWeight
    );
    const riskPenalty = candidateRisk(candidate.findings);
    const installPenalty = candidate.availability === "available"
      ? PREFLIGHT_CONFIG.installPenalty
      : 0;
    const critical = candidate.findings.some(({ severity }) => severity === "critical");
    const adjustedRelevance = clamp(relevance - riskPenalty - installPenalty);
    const initialReasons: PreflightReason[] = [];

    if (matchedTaskTerms.size > 0) {
      initialReasons.push({
        code: "TASK_TERM_MATCH",
        detail: [...matchedTaskTerms].slice(0, 6).join(", ")
      });
    }
    if (nameMatch) {
      initialReasons.push({
        code: "NAME_MATCH",
        detail: `Task matches '${candidate.name}' routing metadata.`
      });
    }
    if (projectFit) {
      initialReasons.push({
        code: "PROJECT_SCOPE_FIT",
        detail: "Project-scoped Skill is available in the current workspace."
      });
    }
    if (riskPenalty > 0) {
      initialReasons.push({
        code: "PORTFOLIO_RISK",
        detail: `Existing findings apply a ${Math.round(riskPenalty * 100)}% risk penalty.`
      });
    }
    if (candidate.availability === "available") {
      initialReasons.push({
        code: "INSTALL_REQUIRED",
        detail: "This candidate is not installed and requires explicit approval."
      });
    }
    if (critical) {
      initialReasons.push({
        code: "CRITICAL_RISK",
        detail: "A critical finding makes this catalog candidate non-installable."
      });
    }
    if (!candidate.harnessCompatible) {
      initialReasons.push({
        code: "HARNESS_INCOMPATIBLE",
        detail: "The candidate does not declare compatibility with the target Harness."
      });
    }

    return {
      candidate,
      routeTerms,
      matchedTaskTerms,
      relevance,
      adjustedRelevance,
      riskPenalty,
      installPenalty,
      nameMatch,
      plausible: candidate.harnessCompatible && !critical &&
        (nameMatch || adjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold),
      critical,
      initialReasons
    };
  });

  return { candidates, taskTerms, taskTermOrder: tokenizedTask.terms };
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.adjustedRelevance - left.adjustedRelevance ||
    left.candidate.contextTokens - right.candidate.contextTokens ||
    left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

function selectInstalled(
  candidates: ScoredCandidate[],
  taskTerms: Set<string>,
  maxSkills: number
): SelectedCandidate[] {
  const plausible = candidates.filter(
    ({ candidate, plausible }) => candidate.availability === "installed" && plausible
  );
  if (plausible.length === 0) return [];

  const plausibleCoverage = new Set(
    plausible.flatMap(({ matchedTaskTerms }) => [...matchedTaskTerms])
  );
  const remaining = [...plausible].sort(compareCandidates);
  const selected: SelectedCandidate[] = [];
  const coveredTerms = new Set<string>();
  const selectedRouteTerms = new Set<string>();

  while (remaining.length > 0 && selected.length < maxSkills) {
    const ranked = remaining.map((candidate) => {
      const uncovered = new Set(
        [...candidate.matchedTaskTerms].filter((term) => !coveredTerms.has(term))
      );
      const uniqueCoverage = ratio(uncovered.size, taskTerms.size);
      const redundancyPenalty = jaccard(candidate.routeTerms, selectedRouteTerms) *
        PREFLIGHT_CONFIG.redundancyWeight;
      const marginal = clamp(
        candidate.relevance + uniqueCoverage - redundancyPenalty - candidate.riskPenalty
      );
      return { candidate, uniqueCoverage, redundancyPenalty, marginal };
    }).sort((left, right) =>
      right.marginal - left.marginal || compareCandidates(left.candidate, right.candidate)
    );
    const next = ranked[0];
    if (!next || (selected.length > 0 && next.marginal < PREFLIGHT_CONFIG.marginalThreshold)) {
      break;
    }
    selected.push(next);
    next.candidate.matchedTaskTerms.forEach((term) => coveredTerms.add(term));
    next.candidate.routeTerms.forEach((term) => selectedRouteTerms.add(term));
    remaining.splice(remaining.indexOf(next.candidate), 1);
    if (ratio(coveredTerms.size, plausibleCoverage.size) >= PREFLIGHT_CONFIG.coverageTarget) {
      break;
    }
  }

  return selected;
}

function selectedTerms(selected: SelectedCandidate[]): Set<string> {
  return new Set(selected.flatMap(({ candidate }) => [...candidate.matchedTaskTerms]));
}

function selectAvailable(
  candidates: ScoredCandidate[],
  taskTerms: Set<string>,
  installed: SelectedCandidate[]
): SelectedCandidate[] {
  const remaining = candidates.filter(
    ({ candidate, plausible }) => candidate.availability === "available" && plausible
  );
  const selected: SelectedCandidate[] = [];
  const coveredTerms = selectedTerms(installed);
  const selectedRouteTerms = new Set(
    installed.flatMap(({ candidate }) => [...candidate.routeTerms])
  );

  while (
    remaining.length > 0 &&
    selected.length < PREFLIGHT_CONFIG.maxAvailableSkills &&
    ratio(coveredTerms.size, taskTerms.size) < PREFLIGHT_CONFIG.projectedCoverageTarget
  ) {
    const ranked = remaining.flatMap((candidate) => {
      const uncovered = new Set(
        [...candidate.matchedTaskTerms].filter((term) => !coveredTerms.has(term))
      );
      if (uncovered.size === 0) return [];
      const uniqueCoverage = ratio(uncovered.size, taskTerms.size);
      const redundancyPenalty = jaccard(candidate.routeTerms, selectedRouteTerms) *
        PREFLIGHT_CONFIG.redundancyWeight;
      const marginal = clamp(
        candidate.relevance + uniqueCoverage - redundancyPenalty -
        candidate.riskPenalty - candidate.installPenalty
      );
      return [{ candidate, uniqueCoverage, redundancyPenalty, marginal }];
    }).sort((left, right) =>
      right.marginal - left.marginal || compareCandidates(left.candidate, right.candidate)
    );
    const next = ranked[0];
    if (!next || next.marginal < PREFLIGHT_CONFIG.availableMarginalThreshold) break;
    selected.push(next);
    next.candidate.matchedTaskTerms.forEach((term) => coveredTerms.add(term));
    next.candidate.routeTerms.forEach((term) => selectedRouteTerms.add(term));
    remaining.splice(remaining.indexOf(next.candidate), 1);
  }

  return selected;
}

function presentCandidates(
  candidates: ScoredCandidate[],
  installed: SelectedCandidate[],
  available: SelectedCandidate[]
): PreflightCandidate[] {
  const selected = [...installed, ...available];
  const selectedById = new Map(
    selected.map((entry, index) => [
      entry.candidate.candidate.candidateId,
      { ...entry, index }
    ])
  );
  const selectedRouteTerms = new Set(
    selected.flatMap(({ candidate }) => [...candidate.routeTerms])
  );

  return candidates.map((candidate): PreflightCandidate => {
    const id = candidate.candidate.candidateId;
    const selectedEntry = selectedById.get(id);
    const redundancyPenalty = selectedEntry
      ? selectedEntry.redundancyPenalty
      : jaccard(candidate.routeTerms, selectedRouteTerms) * PREFLIGHT_CONFIG.redundancyWeight;
    const uniqueCoverage = selectedEntry?.uniqueCoverage ?? 0;
    const reasons = [...candidate.initialReasons];

    if (selectedEntry) {
      reasons.push({
        code: "UNIQUE_COVERAGE",
        detail: `${Math.round(uniqueCoverage * 100)}% unique task-term coverage.`
      });
    } else if (!candidate.plausible && !candidate.critical && candidate.candidate.harnessCompatible) {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Task relevance is below the deterministic threshold."
      });
    } else if (redundancyPenalty > 0) {
      reasons.push({
        code: "REDUNDANT_WITH_SELECTED",
        detail: `${Math.round(redundancyPenalty * 100)}% weighted overlap with the selected set.`
      });
    } else if (!candidate.critical && candidate.candidate.harnessCompatible) {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Candidate adds less marginal value than the selected set."
      });
    }

    const decision = selectedEntry
      ? candidate.candidate.availability === "installed" ? "use" : "install"
      : "excluded";
    return {
      candidateId: id,
      availability: candidate.candidate.availability,
      ...(candidate.candidate.installedSkillId
        ? { installedSkillId: candidate.candidate.installedSkillId }
        : {}),
      ...(candidate.candidate.catalogSkillId
        ? { catalogSkillId: candidate.candidate.catalogSkillId }
        : {}),
      name: candidate.candidate.name,
      description: candidate.candidate.description,
      scope: candidate.candidate.scope,
      compatibleHarnesses: candidate.candidate.compatibleHarnesses,
      compatibility: candidate.candidate.compatibility,
      scripts: candidate.candidate.scripts,
      executables: candidate.candidate.executables,
      highestSeverity: highestSeverity(candidate.candidate.findings),
      relevance: stableNumber(candidate.relevance),
      uniqueCoverage: stableNumber(uniqueCoverage),
      riskPenalty: stableNumber(candidate.riskPenalty),
      redundancyPenalty: stableNumber(redundancyPenalty),
      installPenalty: stableNumber(candidate.installPenalty),
      contextTokens: candidate.candidate.contextTokens,
      decision,
      ...(candidate.candidate.source ? { source: candidate.candidate.source } : {}),
      reasons
    };
  }).sort((left, right) => {
    const leftSelected = selectedById.get(left.candidateId);
    const rightSelected = selectedById.get(right.candidateId);
    if (leftSelected && rightSelected) return leftSelected.index - rightSelected.index;
    if (leftSelected) return -1;
    if (rightSelected) return 1;
    return right.relevance - left.relevance || left.candidateId.localeCompare(right.candidateId);
  });
}

export function analyzePreflight(input: AnalyzePreflightInput): PreflightResult {
  const request = preflightRequestSchema.parse({
    task: input.task,
    maxSkills: input.maxSkills ?? 5,
    ...(input.harness ? { harness: input.harness } : {}),
    includeAvailable: input.includeAvailable ?? true
  });
  const normalizedTask = normalizeTask(request.task);
  const normalizedCandidates = normalizePreflightCandidates({
    ...input,
    task: normalizedTask,
    ...(request.harness ? { harness: request.harness } : {}),
    includeAvailable: request.includeAvailable,
    maxSkills: request.maxSkills
  });
  const { candidates, taskTerms, taskTermOrder } = scoreCandidates(
    normalizedTask,
    normalizedCandidates
  );
  const installed = selectInstalled(candidates, taskTerms, request.maxSkills);
  const available = request.includeAvailable
    ? selectAvailable(candidates, taskTerms, installed)
    : [];
  const useCandidateIds = installed.map(({ candidate }) => candidate.candidate.candidateId);
  const installCandidateIds = available.map(({ candidate }) => candidate.candidate.candidateId);
  const presented = presentCandidates(candidates, installed, available);
  const installedTerms = selectedTerms(installed);
  const projectedTerms = selectedTerms([...installed, ...available]);
  const selectedIds = new Set(useCandidateIds);
  const conflicts = input.report.findings.filter(({ skillIds }) =>
    skillIds.some((id) => selectedIds.has(id))
  );
  const selectedContextTokens = [...installed, ...available].reduce(
    (total, { candidate }) => total + candidate.candidate.contextTokens,
    0
  );
  const plausibleContextTokens = candidates.filter(({ plausible }) => plausible).reduce(
    (total, { candidate }) => total + candidate.contextTokens,
    0
  );

  return preflightResultSchema.parse({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id: input.id,
    generatedAt: input.now.toISOString(),
    portfolioFingerprint: input.report.portfolioFingerprint,
    taskHash: sha256(normalizedTask),
    taskCharacterCount: [...normalizedTask].length,
    taskTermCount: taskTerms.size,
    useCandidateIds,
    installCandidateIds,
    candidates: presented,
    conflicts,
    capabilityGaps: taskTermOrder
      .filter((term) => !projectedTerms.has(term))
      .slice(0, PREFLIGHT_CONFIG.maxCapabilityGaps),
    installedCoverage: stableNumber(ratio(installedTerms.size, taskTerms.size)),
    projectedCoverage: stableNumber(ratio(projectedTerms.size, taskTerms.size)),
    selectedContextTokens,
    plausibleContextTokens,
    estimatedContextSaved: Math.max(0, plausibleContextTokens - selectedContextTokens)
  });
}
