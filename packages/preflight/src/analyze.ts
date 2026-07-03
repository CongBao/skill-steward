import type {
  Finding,
  PortfolioReport,
  Severity,
  SkillRecord
} from "@skill-steward/engine";
import { sha256 } from "@skill-steward/engine";
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

export interface AnalyzePreflightInput {
  task: string;
  report: PortfolioReport;
  maxSkills?: number;
  id: string;
  now: Date;
}

interface ScoredCandidate {
  skill: SkillRecord;
  routeTerms: Set<string>;
  matchedTaskTerms: Set<string>;
  relevance: number;
  adjustedRelevance: number;
  riskPenalty: number;
  nameMatch: boolean;
  plausible: boolean;
  initialReasons: PreflightReason[];
}

interface SelectedCandidate {
  candidate: ScoredCandidate;
  uniqueCoverage: number;
  redundancyPenalty: number;
}

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
  const shared = intersection(left, right).size;
  return shared / new Set([...left, ...right]).size;
}

function stableNumber(value: number): number {
  return Number(value.toFixed(6));
}

function riskPenalty(
  skillId: string,
  findings: Finding[]
): number {
  return clamp(
    findings
      .filter(({ skillIds }) => skillIds.includes(skillId))
      .reduce(
        (total, { severity }) =>
          total + PREFLIGHT_CONFIG.riskWeights[severity as Severity],
        0
      )
  );
}

function matchesName(
  task: string,
  taskTerms: Set<string>,
  skill: SkillRecord
): boolean {
  const normalizedTask = normalizeTask(task).toLowerCase();
  const normalizedName = normalizeTask(skill.name)
    .toLowerCase()
    .replace(/[-_]+/g, " ");
  if (
    normalizedTask.includes(normalizedName) ||
    normalizedTask.includes(normalizedName.replaceAll(" ", "-"))
  ) {
    return true;
  }
  const nameTerms = tokenize(skill.name.replace(/[-_]+/g, " ")).terms;
  return nameTerms.length > 0 && nameTerms.every((term) => taskTerms.has(term));
}

function scoreCandidates(
  task: string,
  report: PortfolioReport
): { candidates: ScoredCandidate[]; taskTerms: Set<string> } {
  const taskTerms = new Set(tokenize(task).terms);
  const candidates = report.skills.map((skill): ScoredCandidate => {
    const routeTerms = new Set(
      tokenize(`${skill.name.replace(/[-_]+/g, " ")} ${skill.description}`)
        .terms
    );
    const matchedTaskTerms = intersection(taskTerms, routeTerms);
    const taskCoverage = ratio(matchedTaskTerms.size, taskTerms.size);
    const skillPrecision = ratio(matchedTaskTerms.size, routeTerms.size);
    const nameMatch = matchesName(task, taskTerms, skill);
    const projectFit = skill.scope === "project" ? 1 : 0;
    const relevance = clamp(
      taskCoverage * PREFLIGHT_CONFIG.taskCoverageWeight +
        skillPrecision * PREFLIGHT_CONFIG.skillPrecisionWeight +
        (nameMatch ? PREFLIGHT_CONFIG.nameMatchWeight : 0) +
        projectFit * PREFLIGHT_CONFIG.projectScopeWeight
    );
    const risk = riskPenalty(skill.id, report.findings);
    const adjustedRelevance = clamp(relevance - risk);
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
        detail: `Task matches '${skill.name}' routing metadata.`
      });
    }
    if (projectFit) {
      initialReasons.push({
        code: "PROJECT_SCOPE_FIT",
        detail: "Project-scoped Skill is available in the current workspace."
      });
    }
    if (risk > 0) {
      initialReasons.push({
        code: "PORTFOLIO_RISK",
        detail: `Existing findings apply a ${Math.round(risk * 100)}% risk penalty.`
      });
    }

    return {
      skill,
      routeTerms,
      matchedTaskTerms,
      relevance,
      adjustedRelevance,
      riskPenalty: risk,
      nameMatch,
      plausible:
        nameMatch || adjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold,
      initialReasons
    };
  });

  return { candidates, taskTerms };
}

function compareCandidates(
  left: ScoredCandidate,
  right: ScoredCandidate
): number {
  return (
    right.adjustedRelevance - left.adjustedRelevance ||
    left.skill.estimatedTokens - right.skill.estimatedTokens ||
    left.skill.id.localeCompare(right.skill.id)
  );
}

function selectMinimalSet(
  candidates: ScoredCandidate[],
  taskTerms: Set<string>,
  maxSkills: number
): SelectedCandidate[] {
  const plausible = candidates.filter(({ plausible }) => plausible);
  if (plausible.length === 0 || maxSkills === 0) return [];

  const plausibleCoverage = new Set(
    plausible.flatMap(({ matchedTaskTerms }) => [...matchedTaskTerms])
  );
  const remaining = [...plausible].sort(compareCandidates);
  const selected: SelectedCandidate[] = [];
  const coveredTerms = new Set<string>();
  const selectedRouteTerms = new Set<string>();

  while (remaining.length > 0 && selected.length < maxSkills) {
    const ranked = remaining
      .map((candidate) => {
        const uncovered = new Set(
          [...candidate.matchedTaskTerms].filter(
            (term) => !coveredTerms.has(term)
          )
        );
        const uniqueCoverage = ratio(uncovered.size, taskTerms.size);
        const redundancy = jaccard(candidate.routeTerms, selectedRouteTerms);
        const redundancyPenalty =
          redundancy * PREFLIGHT_CONFIG.redundancyWeight;
        const marginal = clamp(
          candidate.relevance +
            uniqueCoverage -
            redundancyPenalty -
            candidate.riskPenalty
        );
        return {
          candidate,
          uniqueCoverage,
          redundancyPenalty,
          marginal
        };
      })
      .sort(
        (left, right) =>
          right.marginal - left.marginal ||
          compareCandidates(left.candidate, right.candidate)
      );
    const next = ranked[0];
    if (!next) break;
    if (
      selected.length > 0 &&
      next.marginal < PREFLIGHT_CONFIG.marginalThreshold
    ) {
      break;
    }

    selected.push({
      candidate: next.candidate,
      uniqueCoverage: next.uniqueCoverage,
      redundancyPenalty: next.redundancyPenalty
    });
    next.candidate.matchedTaskTerms.forEach((term) => coveredTerms.add(term));
    next.candidate.routeTerms.forEach((term) => selectedRouteTerms.add(term));
    remaining.splice(remaining.indexOf(next.candidate), 1);

    if (
      ratio(coveredTerms.size, plausibleCoverage.size) >=
      PREFLIGHT_CONFIG.coverageTarget
    ) {
      break;
    }
  }

  return selected;
}

function presentCandidates(
  candidates: ScoredCandidate[],
  selected: SelectedCandidate[]
): PreflightCandidate[] {
  const selectedById = new Map(
    selected.map((entry, index) => [entry.candidate.skill.id, { ...entry, index }])
  );
  const selectedRouteTerms = new Set(
    selected.flatMap(({ candidate }) => [...candidate.routeTerms])
  );

  const result = candidates.map((candidate): PreflightCandidate => {
    const selectedEntry = selectedById.get(candidate.skill.id);
    const redundancyPenalty = selectedEntry
      ? selectedEntry.redundancyPenalty
      : jaccard(candidate.routeTerms, selectedRouteTerms) *
        PREFLIGHT_CONFIG.redundancyWeight;
    const uniqueCoverage = selectedEntry?.uniqueCoverage ?? 0;
    const reasons = [...candidate.initialReasons];

    if (selectedEntry) {
      reasons.push({
        code: "UNIQUE_COVERAGE",
        detail: `${Math.round(uniqueCoverage * 100)}% unique task-term coverage.`
      });
    } else if (!candidate.plausible) {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Task relevance is below the deterministic threshold."
      });
    } else if (redundancyPenalty > 0) {
      reasons.push({
        code: "REDUNDANT_WITH_SELECTED",
        detail: `${Math.round(redundancyPenalty * 100)}% weighted overlap with the selected set.`
      });
    } else {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Candidate adds less marginal value than the selected set."
      });
    }

    return {
      skillId: candidate.skill.id,
      name: candidate.skill.name,
      description: candidate.skill.description,
      scope: candidate.skill.scope,
      visibleTo: candidate.skill.visibleTo,
      relevance: stableNumber(candidate.relevance),
      uniqueCoverage: stableNumber(uniqueCoverage),
      riskPenalty: stableNumber(candidate.riskPenalty),
      redundancyPenalty: stableNumber(redundancyPenalty),
      contextTokens: candidate.skill.estimatedTokens,
      decision: selectedEntry ? "selected" : "excluded",
      reasons
    };
  });

  return result.sort((left, right) => {
    const leftSelected = selectedById.get(left.skillId);
    const rightSelected = selectedById.get(right.skillId);
    if (leftSelected && rightSelected) {
      return leftSelected.index - rightSelected.index;
    }
    if (leftSelected) return -1;
    if (rightSelected) return 1;
    return right.relevance - left.relevance || left.skillId.localeCompare(right.skillId);
  });
}

export function analyzePreflight(
  input: AnalyzePreflightInput
): PreflightResult {
  const request = preflightRequestSchema.parse({
    task: input.task,
    maxSkills: input.maxSkills ?? 5
  });
  const normalizedTask = normalizeTask(request.task);
  const { candidates, taskTerms } = scoreCandidates(
    normalizedTask,
    input.report
  );
  const selected = selectMinimalSet(candidates, taskTerms, request.maxSkills);
  const selectedSkillIds = selected.map(({ candidate }) => candidate.skill.id);
  const presented = presentCandidates(candidates, selected);
  const plausibleContextTokens = candidates
    .filter(({ plausible }) => plausible)
    .reduce((total, { skill }) => total + skill.estimatedTokens, 0);
  const selectedContextTokens = selected.reduce(
    (total, { candidate }) => total + candidate.skill.estimatedTokens,
    0
  );
  const selectedIds = new Set(selectedSkillIds);
  const conflicts = input.report.findings.filter(({ skillIds }) =>
    skillIds.some((id) => selectedIds.has(id))
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
    selectedSkillIds,
    candidates: presented,
    conflicts,
    selectedContextTokens,
    plausibleContextTokens,
    estimatedContextSaved: Math.max(
      0,
      plausibleContextTokens - selectedContextTokens
    )
  });
}
