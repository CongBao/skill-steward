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
  type InventoryWarning,
  type PreflightReason,
  type PreflightResult
} from "./domain.js";
import {
  gapDisplayTerms,
  positiveGapConcepts
} from "./gap-display-internal.js";
import { normalizeTask, tokenize } from "./tokenize.js";

export type AnalyzePreflightInput = AnalyzePreflightInputV2;

interface ScoredCandidate {
  candidate: NormalizedPreflightCandidate;
  routeTerms: Set<string>;
  matchedTaskTerms: Set<string>;
  negativeTaskTerms: Set<string>;
  relevance: number;
  adjustedRelevance: number;
  taskCoverage: number;
  skillPrecision: number;
  riskPenalty: number;
  installPenalty: number;
  nameMatch: boolean;
  projectScopeFit: boolean;
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

function boundedCandidateIdentifier(value: string): string {
  return /^[a-z0-9][a-z0-9._:@+-]{0,95}$/iu.test(value)
    ? value
    : sha256(value);
}

function boundedReasonDetail(value: string): string {
  let detail = "";
  for (const character of value) {
    if (detail.length + character.length > 200) break;
    detail += character;
  }
  return detail;
}

const FINDING_REFERENCE_DOMAIN = "skill-steward:preflight-finding-reference:v1";

class FindingReferenceAllocationError extends Error {
  readonly code = "FINDING_REFERENCE_NAMESPACE_EXHAUSTED";

  constructor() {
    super("FINDING_REFERENCE_NAMESPACE_EXHAUSTED");
    this.name = "FindingReferenceAllocationError";
  }
}

function baseFindingReferenceReplacement(candidateIds: string[]): string {
  const normalized = [...new Set(candidateIds)].sort();
  if (normalized.length === 1) return boundedCandidateIdentifier(normalized[0]!);
  return sha256([FINDING_REFERENCE_DOMAIN, ...normalized].join("\0"));
}

function allocateFindingReferences(
  candidateIdsByRaw: ReadonlyMap<string, string[]>,
  referencedRawIds: string[],
  additionalReservedCandidateIds: string[]
): Map<string, string> {
  const rawIds = [...new Set(referencedRawIds)]
    .filter((rawId) => candidateIdsByRaw.has(rawId))
    .sort();
  if (rawIds.length === 0) return new Map();

  const namespaceOwners = new Map<string, Set<string>>();
  const reserve = (identifier: string, rawId: string) => {
    const owners = namespaceOwners.get(identifier) ?? new Set<string>();
    owners.add(rawId);
    namespaceOwners.set(identifier, owners);
  };
  for (const [rawId, candidateIds] of candidateIdsByRaw) {
    reserve(rawId, rawId);
    for (const candidateId of candidateIds) reserve(candidateId, rawId);
  }

  const reserved = new Set(namespaceOwners.keys());
  const externalReserved = new Set(additionalReservedCandidateIds.filter((candidateId) =>
    !namespaceOwners.has(candidateId)
  ));
  for (const candidateId of additionalReservedCandidateIds) reserved.add(candidateId);
  const allocated = new Set<string>();
  const replacements = new Map<string, string>();
  const maxCollisionAttempts = candidateIdsByRaw.size + 1;
  for (const rawId of rawIds) {
    const candidateIds = [...new Set(candidateIdsByRaw.get(rawId)!)].sort();
    const base = baseFindingReferenceReplacement(candidateIds);
    const owners = namespaceOwners.get(base);
    const uniqueSelfAlias = candidateIds.length === 1 &&
      base === candidateIds[0] &&
      owners?.size === 1 &&
      owners.has(rawId) &&
      !externalReserved.has(base) &&
      !allocated.has(base);
    if (!reserved.has(base) || uniqueSelfAlias) {
      replacements.set(rawId, base);
      reserved.add(base);
      allocated.add(base);
      continue;
    }

    let replacement: string | undefined;
    for (let attempt = 1; attempt <= maxCollisionAttempts; attempt += 1) {
      const candidate = sha256([
        FINDING_REFERENCE_DOMAIN,
        "collision",
        rawId,
        ...candidateIds,
        String(attempt)
      ].join("\0"));
      if (!reserved.has(candidate)) {
        replacement = candidate;
        break;
      }
    }
    if (!replacement) throw new FindingReferenceAllocationError();
    replacements.set(rawId, replacement);
    reserved.add(replacement);
    allocated.add(replacement);
  }
  return replacements;
}

function replaceFindingReferences(
  value: string,
  replacements: ReadonlyMap<string, string>
): string {
  const ordered = [...replacements].sort(([left], [right]) =>
    right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
  );
  if (ordered.length === 0 || !ordered.some(([rawId]) => value.includes(rawId))) {
    return value;
  }

  let sanitized = "";
  let offset = 0;
  while (offset < value.length) {
    const match = ordered.find(([rawId]) => value.startsWith(rawId, offset));
    if (match) {
      sanitized += match[1];
      offset += match[0].length;
    } else {
      sanitized += value[offset];
      offset += 1;
    }
  }
  return sanitized;
}

function sanitizeFinding(
  finding: Finding,
  candidateIdsByRaw: ReadonlyMap<string, string[]>,
  allocatedReferences: ReadonlyMap<string, string>
): Finding {
  const references = new Map(finding.skillIds.flatMap((rawId) => {
    const replacement = allocatedReferences.get(rawId);
    return replacement ? [[rawId, replacement] as const] : [];
  }));
  const sanitize = (value: string) => replaceFindingReferences(value, references);
  return {
    ...finding,
    skillIds: [...new Set(finding.skillIds.flatMap((rawId) =>
      candidateIdsByRaw.get(rawId) ?? []
    ))].sort(),
    summary: sanitize(finding.summary),
    evidence: finding.evidence.map(sanitize),
    recommendation: sanitize(finding.recommendation)
  };
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
  taskTerms: Set<string>,
  candidate: NormalizedPreflightCandidate
): boolean {
  const nameTerms = tokenize(candidate.name.replace(/[-_]+/g, " ")).terms;
  return nameTerms.length > 0 && nameTerms.every((term) => taskTerms.has(term));
}

const GENERIC_NEGATIVE_ROUTE_TERMS = new Set([
  "change",
  "code",
  "document",
  "file",
  "general",
  "generation",
  "task",
  "work"
]);

const BROAD_CJK_ROUTE_TERMS = new Set([
  "分析",
  "评估",
  "評估",
  "质量",
  "品質"
]);

const GENERIC_CAPABILITY_GAP_TERMS = new Set([
  ...GENERIC_NEGATIVE_ROUTE_TERMS,
  "create",
  "product",
  "project",
  "review",
  "source",
  "test"
]);

function isSpecificGapConcept(term: string): boolean {
  return !GENERIC_CAPABILITY_GAP_TERMS.has(term) &&
    !BROAD_CJK_ROUTE_TERMS.has(term);
}

function canonicalMatchedGapConcepts(candidate: ScoredCandidate): Set<string> {
  return new Set([...candidate.matchedTaskTerms].flatMap((term) =>
    [...positiveGapConcepts(term, "")]
  ).filter(isSpecificGapConcept));
}

function hasSpecificNameGapEvidence(candidate: ScoredCandidate): boolean {
  return candidate.nameMatch && [...positiveGapConcepts(
    candidate.candidate.name,
    ""
  )].some(isSpecificGapConcept);
}

function displayCapabilityGaps(
  task: string,
  candidates: ScoredCandidate[],
  selectedCandidates: ScoredCandidate[]
): string[] {
  const gaps: string[] = [];
  const seenConcepts = new Set<string>();
  const corroboratingCandidates = candidates.filter((candidate) =>
    hasSpecificNameGapEvidence(candidate) || (
      canonicalMatchedGapConcepts(candidate).size >=
        PREFLIGHT_CONFIG.minimumMatchedTerms &&
      candidate.adjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold
    )
  );
  const corroboratedTerms = new Set(corroboratingCandidates.flatMap(
    ({ candidate }) => [...positiveGapConcepts(candidate.name, candidate.description)]
  ));
  const coveredTerms = new Set(selectedCandidates.flatMap(({ candidate }) =>
    [...positiveGapConcepts(candidate.name, candidate.description)]
  ));
  const displayTerms = gapDisplayTerms(task);
  const standaloneTerms = new Set(displayTerms.flatMap(({ concepts }) =>
    concepts
  ).filter((term) =>
    !coveredTerms.has(term) && isSpecificGapConcept(term)
  ));
  const allowStandaloneTerms = corroboratingCandidates.length === 0 &&
    standaloneTerms.size > 0 &&
    standaloneTerms.size <= PREFLIGHT_CONFIG.maxStandaloneCapabilityTerms;
  const isSearchable = (term: string) =>
    isSpecificGapConcept(term) &&
    (corroboratedTerms.has(term) || (
      allowStandaloneTerms && standaloneTerms.has(term)
    ));
  for (const { display, concepts } of displayTerms) {
    const uncovered = concepts.filter((term) =>
      !coveredTerms.has(term) &&
      !seenConcepts.has(term) &&
      isSearchable(term)
    );
    if (uncovered.length === 0) continue;
    gaps.push(display);
    uncovered.forEach((term) => seenConcepts.add(term));
    if (gaps.length >= PREFLIGHT_CONFIG.maxCapabilityGaps) break;
  }
  return gaps;
}

function negativeTaskMatch(
  taskTerms: Set<string>,
  description: string
): Set<string> {
  const matched = new Set<string>();
  const positiveDescriptionTerms = new Set(tokenize(description.replace(
    /(?:do\s+not|don't)\s+use(?:\s+this\s+skill)?\s+(?:for|when)\s+[^.!?\n]+/giu,
    " "
  )).terms);
  for (const clause of description.matchAll(
    /(?:do\s+not|don't)\s+use(?:\s+this\s+skill)?\s+(?:for|when)\s+([^.!?\n]+)/giu
  )) {
    const clauseMatches = tokenize(clause[1] ?? "").terms
      .filter((term) => taskTerms.has(term) && !positiveDescriptionTerms.has(term));
    const hasSpecificMatch = clauseMatches.some(
      (term) => !GENERIC_NEGATIVE_ROUTE_TERMS.has(term)
    );
    if (hasSpecificMatch || clauseMatches.length >= 2) {
      clauseMatches.forEach((term) => matched.add(term));
    }
  }
  return matched;
}

function scoreCandidates(
  task: string,
  normalizedCandidates: NormalizedPreflightCandidate[]
): { candidates: ScoredCandidate[]; taskTerms: Set<string> } {
  const tokenizedTask = tokenize(task);
  const taskTerms = new Set(tokenizedTask.terms);
  const candidates = normalizedCandidates.map((candidate): ScoredCandidate => {
    const routeTerms = new Set(
      tokenize(`${candidate.name.replace(/[-_]+/g, " ")} ${candidate.description}`).terms
    );
    const matchedTaskTerms = intersection(taskTerms, routeTerms);
    const negativeTaskTerms = negativeTaskMatch(taskTerms, candidate.description);
    const taskCoverage = ratio(matchedTaskTerms.size, taskTerms.size);
    const skillPrecision = ratio(matchedTaskTerms.size, routeTerms.size);
    const nameMatch = matchesName(taskTerms, candidate);
    const projectScopeFit = candidate.scope === "project";
    const relevance = clamp(
      taskCoverage * PREFLIGHT_CONFIG.taskCoverageWeight +
      skillPrecision * PREFLIGHT_CONFIG.skillPrecisionWeight +
      (nameMatch ? PREFLIGHT_CONFIG.nameMatchWeight : 0) +
      (projectScopeFit ? PREFLIGHT_CONFIG.projectScopeWeight : 0)
    );
    const riskPenalty = candidateRisk(candidate.findings);
    const installPenalty = candidate.availability === "available"
      ? PREFLIGHT_CONFIG.installPenalty
      : 0;
    const critical = candidate.findings.some(({ severity }) => severity === "critical");
    const adjustedRelevance = clamp(relevance - riskPenalty - installPenalty);
    const hasSpecificTaskMatch = [...matchedTaskTerms].some(
      (term) => !BROAD_CJK_ROUTE_TERMS.has(term)
    );
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
    if (projectScopeFit) {
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
    if (!candidate.harnessCompatible && candidate.harnessVisibility === undefined) {
      initialReasons.push({
        code: "HARNESS_INCOMPATIBLE",
        detail: "The candidate does not declare compatibility with the target Harness."
      });
    }
    if (candidate.harnessVisibility === "shadowed") {
      initialReasons.push({
        code: "HARNESS_SHADOWED",
        detail: candidate.shadowedByCandidateId
          ? `Shadowed by installed candidate '${boundedCandidateIdentifier(candidate.shadowedByCandidateId)}'.`
          : "Another installed candidate shadows this instance for the target Harness."
      });
    }
    if (candidate.harnessVisibility === "inactive") {
      initialReasons.push({
        code: "HARNESS_INACTIVE",
        detail: "The installed instance is inactive for the target Harness."
      });
    }
    if (candidate.harnessVisibility === "ambiguous") {
      initialReasons.push({
        code: "HARNESS_AMBIGUOUS",
        detail: "Harness visibility for this installed instance is ambiguous."
      });
    }
    if (negativeTaskTerms.size > 0) {
      initialReasons.push({
        code: "NEGATIVE_TRIGGER",
        detail: `The Skill routing description explicitly excludes: ${[...negativeTaskTerms].slice(0, 6).join(", ")}.`
      });
    }

    return {
      candidate,
      routeTerms,
      matchedTaskTerms,
      negativeTaskTerms,
      relevance,
      adjustedRelevance,
      taskCoverage,
      skillPrecision,
      riskPenalty,
      installPenalty,
      nameMatch,
      projectScopeFit,
      plausible: candidate.harnessEligible && !critical && negativeTaskTerms.size === 0 &&
        (nameMatch || (
          hasSpecificTaskMatch &&
          matchedTaskTerms.size >= PREFLIGHT_CONFIG.minimumMatchedTerms &&
          adjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold
        )),
      critical,
      initialReasons
    };
  });

  return { candidates, taskTerms };
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
    } else if (!candidate.candidate.harnessEligible) {
      // The Harness visibility or compatibility reason is the primary exclusion.
    } else if (!candidate.plausible && !candidate.critical && candidate.candidate.harnessEligible) {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Task relevance is below the deterministic threshold."
      });
    } else if (redundancyPenalty > 0) {
      reasons.push({
        code: "REDUNDANT_WITH_SELECTED",
        detail: `${Math.round(redundancyPenalty * 100)}% weighted overlap with the selected set.`
      });
    } else if (!candidate.critical && candidate.candidate.harnessEligible) {
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
      features: {
        taskCoverage: stableNumber(candidate.taskCoverage),
        skillPrecision: stableNumber(candidate.skillPrecision),
        nameMatch: candidate.nameMatch,
        projectScopeFit: candidate.projectScopeFit
      },
      decision,
      ...(candidate.candidate.source ? { source: candidate.candidate.source } : {}),
      reasons: reasons.map(({ code, detail }) => ({
        code,
        detail: boundedReasonDetail(detail)
      }))
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

function inventoryWarnings(
  candidates: ScoredCandidate[],
  harness: AnalyzePreflightInput["harness"]
): InventoryWarning[] {
  if (!harness || harness === "unknown") return [];
  const matchingInstalled = candidates.filter(({ candidate, matchedTaskTerms, nameMatch }) =>
    candidate.availability === "installed" &&
    candidate.harnessVisibility !== undefined &&
    (nameMatch || matchedTaskTerms.size >= PREFLIGHT_CONFIG.minimumMatchedTerms)
  );
  if (
    matchingInstalled.length === 0 ||
    matchingInstalled.some(({ candidate }) => candidate.harnessVisibility !== "ambiguous")
  ) {
    return [];
  }
  return [{
    code: "HARNESS_AMBIGUOUS",
    harness,
    detail: "Visibility is ambiguous for every matching installed candidate."
  }];
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
  const { candidates, taskTerms } = scoreCandidates(
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
  const selectedRawInstalledIds = new Set(installed.flatMap(({ candidate }) =>
    candidate.candidate.rawInstalledSkillId
      ? [candidate.candidate.rawInstalledSkillId]
      : []
  ));
  const installedCandidateIdsByRaw = new Map<string, string[]>();
  for (const { candidate } of candidates) {
    if (!candidate.rawInstalledSkillId) continue;
    const ids = installedCandidateIdsByRaw.get(candidate.rawInstalledSkillId) ?? [];
    ids.push(candidate.candidateId);
    installedCandidateIdsByRaw.set(candidate.rawInstalledSkillId, ids);
  }
  const conflictFindings = input.report.findings.filter(({ skillIds }) =>
    skillIds.some((id) => selectedRawInstalledIds.has(id))
  );
  const findingReferences = allocateFindingReferences(
    installedCandidateIdsByRaw,
    conflictFindings.flatMap(({ skillIds }) => skillIds),
    presented.map(({ candidateId }) => candidateId)
  );
  const conflicts = conflictFindings.map((finding) =>
    sanitizeFinding(finding, installedCandidateIdsByRaw, findingReferences)
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
    inventoryWarnings: inventoryWarnings(candidates, request.harness),
    capabilityGaps: displayCapabilityGaps(
      normalizedTask,
      candidates,
      [...installed, ...available].map(({ candidate }) => candidate)
    ),
    installedCoverage: stableNumber(ratio(installedTerms.size, taskTerms.size)),
    projectedCoverage: stableNumber(ratio(projectedTerms.size, taskTerms.size)),
    selectedContextTokens,
    plausibleContextTokens,
    estimatedContextSaved: Math.max(0, plausibleContextTokens - selectedContextTokens)
  });
}
