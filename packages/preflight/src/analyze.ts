import { sha256, type Finding, type Severity } from "@skill-steward/engine";
import {
  normalizePreflightCandidates,
  type AnalyzePreflightInputV2,
  type NormalizedPreflightCandidate
} from "./candidates.js";
import { extractCapabilities, type CapabilitySet } from "./capabilities.js";
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
import {
  negativeRoutingClauses,
  negativeTaskClauses,
  positiveRoutingText,
  positiveTaskText
} from "./polarity.js";
import { normalizeTask, tokenize, tokenizeSequence } from "./tokenize.js";

export type AnalyzePreflightInput = AnalyzePreflightInputV2;

interface ScoredCandidate {
  candidate: NormalizedPreflightCandidate;
  routeTerms: Set<string>;
  matchedTaskTerms: Set<string>;
  negativeTaskTerms: Set<string>;
  capabilities: CapabilitySet;
  matchedCapabilities: Set<string>;
  capabilityCoverage: number;
  capabilityPrecision: number;
  triggerConfidence: "none" | "partial" | "exact";
  relevance: number;
  adjustedRelevance: number;
  gapAdjustedRelevance: number;
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
  uniqueCapabilities: Set<string>;
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

function intersection(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): Set<string> {
  return new Set([...left].filter((term) => right.has(term)));
}

const BROAD_ROUTE_TERMS = new Set([
  "agent",
  "are",
  "as",
  "background",
  "code",
  "context",
  "document",
  "mention",
  "project",
  "review",
  "skill"
]);

function capabilityWeight(value: string): number {
  return value.startsWith("pair:") ? 2 : value.startsWith("action:") ? 1 : 0.25;
}

function weightedCapabilityRatio(
  numerator: ReadonlySet<string>,
  denominator: ReadonlySet<string>
): number {
  const total = [...denominator].reduce((sum, value) => sum + capabilityWeight(value), 0);
  if (total === 0) return 0;
  return [...numerator].reduce((sum, value) => sum + capabilityWeight(value), 0) / total;
}

function boundedCapabilityDetail(values: ReadonlySet<string>): string {
  return [...new Set(
    [...values]
      .sort()
      .map((value) => value.replace(/^(?:action|object|pair):/u, ""))
  )].slice(0, 6).join(", ");
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function jaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): number {
  if (left.size === 0 && right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) overlap += 1;
  }
  return overlap / (left.size + right.size - overlap);
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
  nameTerms: readonly string[]
): boolean {
  return nameTerms.length > 0 && nameTerms.every((term) => taskTerms.has(term));
}

const HIGH_CONFIDENCE_TRIGGER_ANCHORS = new Set([
  "after",
  "before",
  "during"
]);

interface HighConfidenceTriggerRule {
  key: string;
  display: string;
  requiredNameTerms: readonly string[];
  taskIntentTerms: readonly string[];
  objectTerms: readonly string[];
}

const HIGH_CONFIDENCE_TRIGGER_RULES: readonly HighConfidenceTriggerRule[] = [{
  key: "before\0merge",
  display: "before merge",
  requiredNameTerms: ["request", "code", "review"],
  taskIntentTerms: ["review"],
  objectTerms: ["code"]
}];

const PHRASE_BOUNDARIES = /[\p{P}\p{S}\n]+/u;

function anchoredTriggerPhrases(value: string): Map<string, string> {
  const phrases = new Map<string, string>();
  for (const segment of value.split(PHRASE_BOUNDARIES)) {
    const terms = tokenizeSequence(segment);
    for (let index = 0; index < terms.length - 1; index += 1) {
      const anchor = terms[index]!;
      const concept = terms[index + 1]!;
      if (!HIGH_CONFIDENCE_TRIGGER_ANCHORS.has(anchor)) continue;
      phrases.set(`${anchor}\0${concept}`, `${anchor} ${concept}`);
    }
  }
  return phrases;
}

function highConfidenceTrigger(
  taskTerms: Set<string>,
  taskPhrases: ReadonlyMap<string, string>,
  nameTerms: readonly string[],
  positiveDescription: string
): string | undefined {
  if (taskPhrases.size === 0) return undefined;
  const nameTermSet = new Set(nameTerms);
  const descriptionPhrases = anchoredTriggerPhrases(
    positiveDescription
  );
  for (const rule of HIGH_CONFIDENCE_TRIGGER_RULES) {
    if (
      taskPhrases.has(rule.key) &&
      descriptionPhrases.has(rule.key) &&
      rule.requiredNameTerms.every((term) => nameTermSet.has(term)) &&
      rule.taskIntentTerms.every((term) => taskTerms.has(term))
    ) {
      return rule.display;
    }
  }
  return undefined;
}

function negativeTaskIntentMatch(
  clauses: readonly string[],
  nameTerms: readonly string[],
  positiveTaskTerms: Set<string>,
  positiveTaskPhrases: ReadonlyMap<string, string>
): Set<string> {
  const matched = new Set<string>();
  if (clauses.length === 0) return matched;
  for (const rule of HIGH_CONFIDENCE_TRIGGER_RULES) {
    if (!rule.requiredNameTerms.every((term) => nameTerms.includes(term))) continue;
    for (const clause of clauses) {
      const clauseTerms = new Set(tokenize(clause).terms);
      if (
        anchoredTriggerPhrases(clause).has(rule.key) &&
        rule.taskIntentTerms.every((term) => clauseTerms.has(term))
      ) {
        const positiveCounterpart = positiveTaskPhrases.has(rule.key) &&
          rule.taskIntentTerms.every((term) => positiveTaskTerms.has(term)) &&
          rule.objectTerms.some((term) => positiveTaskTerms.has(term));
        const negativeTargetsObject = rule.objectTerms.some(
          (term) => clauseTerms.has(term)
        );
        if (positiveCounterpart && !negativeTargetsObject) continue;
        rule.taskIntentTerms.forEach((term) => matched.add(term));
        rule.key.split("\0").forEach((term) => matched.add(term));
      }
    }
  }
  if (!matchesName(positiveTaskTerms, nameTerms)) {
    const positiveNameOverlap = nameTerms.filter(
      (term) => positiveTaskTerms.has(term)
    ).length;
    for (const clause of clauses) {
      const clauseTerms = new Set(tokenize(clause).terms);
      const negativeNameTerms = nameTerms.filter((term) => clauseTerms.has(term));
      const fullNameMatch = nameTerms.length > 0 &&
        negativeNameTerms.length === nameTerms.length;
      const strongerCoreMatch = negativeNameTerms.length >= 2 &&
        negativeNameTerms.length > positiveNameOverlap;
      if (fullNameMatch || strongerCoreMatch) {
        negativeNameTerms.forEach((term) => matched.add(term));
      }
    }
  }
  return matched;
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
  if (candidate.matchedTaskTerms.size < PREFLIGHT_CONFIG.minimumMatchedTerms) {
    return new Set();
  }
  const positiveCandidateConcepts = positiveGapConcepts(
    candidate.candidate.name,
    candidate.candidate.description
  );
  return new Set([...candidate.matchedTaskTerms].flatMap((term) =>
    [...positiveGapConcepts(term, "")]
  ).filter((term) =>
    positiveCandidateConcepts.has(term) && isSpecificGapConcept(term)
  ));
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
      candidate.gapAdjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold &&
      canonicalMatchedGapConcepts(candidate).size >=
        PREFLIGHT_CONFIG.minimumMatchedTerms
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
  taskPhrases: ReadonlyMap<string, string>,
  clauses: readonly string[],
  positiveDescription: string
): Set<string> {
  const matched = new Set<string>();
  if (clauses.length === 0) return matched;
  const positiveDescriptionTerms = new Set(tokenize(positiveDescription).terms);
  const positiveDescriptionPhrases = anchoredTriggerPhrases(
    positiveDescription
  );
  for (const clause of clauses) {
    const clauseTerms = tokenize(clause).terms;
    const clauseTermSet = new Set(clauseTerms);
    const clauseMatches = clauseTerms
      .filter((term) => taskTerms.has(term) && !positiveDescriptionTerms.has(term));
    const clausePhrases = anchoredTriggerPhrases(clause);
    for (const [key] of clausePhrases) {
      if (!taskPhrases.has(key)) continue;
      const rule = HIGH_CONFIDENCE_TRIGGER_RULES.find((entry) => entry.key === key);
      if (positiveDescriptionPhrases.has(key)) {
        const positiveCounterpart = rule !== undefined &&
          rule.objectTerms.some((term) => taskTerms.has(term)) &&
          rule.objectTerms.some((term) => positiveDescriptionTerms.has(term));
        const negativeTargetsObject = rule?.objectTerms.some(
          (term) => clauseTermSet.has(term)
        ) ?? false;
        if (rule === undefined || (positiveCounterpart && !negativeTargetsObject)) {
          continue;
        }
      }
      key.split("\0").forEach((term) => matched.add(term));
    }
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
): {
  candidates: ScoredCandidate[];
  taskTerms: Set<string>;
  taskCapabilities: CapabilitySet;
} {
  const taskNegativeClauses = negativeTaskClauses(task);
  const positiveTask = taskNegativeClauses.length === 0
    ? task
    : positiveTaskText(task);
  const taskTerms = new Set(tokenize(positiveTask).terms);
  const taskCapabilities = extractCapabilities(task);
  const taskPhrases = anchoredTriggerPhrases(positiveTask);
  const capabilityCache = new Map<string, CapabilitySet>();
  const candidates = normalizedCandidates.map((candidate): ScoredCandidate => {
    const normalizedName = candidate.name.replace(/[-_]+/g, " ");
    const nameTerms = tokenize(normalizedName).terms;
    const routingNegativeClauses = negativeRoutingClauses(candidate.description);
    const positiveDescription = routingNegativeClauses.length === 0
      ? candidate.description
      : positiveRoutingText(candidate.description);
    const capabilityInput = normalizeTask(
      `${normalizedName}. ${positiveDescription}`
    ).toLowerCase().replace(/[0-9]+/gu, "0");
    let capabilities = capabilityCache.get(capabilityInput);
    if (!capabilities) {
      capabilities = extractCapabilities(capabilityInput);
      capabilityCache.set(capabilityInput, capabilities);
    }
    const matchedCapabilities = intersection(
      taskCapabilities.all,
      capabilities.all
    );
    const matchedCapabilityPairs = intersection(
      taskCapabilities.pairs,
      capabilities.pairs
    );
    const capabilityCoverage = weightedCapabilityRatio(
      matchedCapabilities,
      taskCapabilities.all
    );
    const capabilityPrecision = weightedCapabilityRatio(
      matchedCapabilities,
      capabilities.all
    );
    const exactCapability = matchedCapabilityPairs.size > 0;
    const triggerConfidence = exactCapability
      ? "exact" as const
      : matchedCapabilities.size > 0
        ? "partial" as const
        : "none" as const;
    const routeTerms = new Set(
      tokenize(`${normalizedName} ${candidate.description}`).terms
    );
    const matchedTaskTerms = intersection(taskTerms, routeTerms);
    const positiveRouteTerms = positiveDescription === candidate.description
      ? routeTerms
      : new Set(tokenize(`${normalizedName} ${positiveDescription}`).terms);
    const positiveMatchedTaskTerms = intersection(taskTerms, positiveRouteTerms);
    const negativeRouteTerms = negativeTaskMatch(
      taskTerms,
      taskPhrases,
      routingNegativeClauses,
      positiveDescription
    );
    const negativeIntentTerms = negativeTaskIntentMatch(
      taskNegativeClauses,
      nameTerms,
      taskTerms,
      taskPhrases
    );
    const negativeTaskTerms = new Set([
      ...negativeRouteTerms,
      ...negativeIntentTerms
    ]);
    const taskCoverage = ratio(matchedTaskTerms.size, taskTerms.size);
    const skillPrecision = ratio(matchedTaskTerms.size, routeTerms.size);
    const nameMatch = matchesName(taskTerms, nameTerms);
    const matchedHighConfidenceTrigger = highConfidenceTrigger(
      taskTerms,
      taskPhrases,
      nameTerms,
      positiveDescription
    );
    const projectScopeFit = candidate.scope === "project";
    const lexicalRelevance = clamp(
      taskCoverage * PREFLIGHT_CONFIG.taskCoverageWeight +
      skillPrecision * PREFLIGHT_CONFIG.skillPrecisionWeight +
      (nameMatch ? PREFLIGHT_CONFIG.nameMatchWeight : 0) +
      (matchedHighConfidenceTrigger
        ? PREFLIGHT_CONFIG.highConfidenceTriggerWeight
        : 0) +
      (projectScopeFit ? PREFLIGHT_CONFIG.projectScopeWeight : 0)
    );
    const capabilityRelevance = clamp(
      capabilityCoverage * 0.45 +
      capabilityPrecision * 0.2 +
      (exactCapability ? 0.2 : 0)
    );
    const relevance = clamp(lexicalRelevance + capabilityRelevance);
    const riskPenalty = candidateRisk(candidate.findings);
    const installPenalty = candidate.availability === "available"
      ? PREFLIGHT_CONFIG.installPenalty
      : 0;
    const critical = candidate.findings.some(({ severity }) => severity === "critical");
    const lexicalAdjustedRelevance = clamp(
      lexicalRelevance - riskPenalty - installPenalty
    );
    const adjustedRelevance = clamp(relevance - riskPenalty - installPenalty);
    const gapRelevance = clamp(
      ratio(positiveMatchedTaskTerms.size, taskTerms.size) *
        PREFLIGHT_CONFIG.taskCoverageWeight +
      ratio(positiveMatchedTaskTerms.size, routeTerms.size) *
        PREFLIGHT_CONFIG.skillPrecisionWeight +
      (nameMatch ? PREFLIGHT_CONFIG.nameMatchWeight : 0) +
      (projectScopeFit ? PREFLIGHT_CONFIG.projectScopeWeight : 0)
    );
    const gapAdjustedRelevance = clamp(
      gapRelevance - riskPenalty - installPenalty
    );
    const hasSpecificTaskMatch = [...matchedTaskTerms].some(
      (term) => !BROAD_CJK_ROUTE_TERMS.has(term) && !BROAD_ROUTE_TERMS.has(term)
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
    if (matchedCapabilities.size > 0) {
      initialReasons.push({
        code: "CAPABILITY_MATCH",
        detail: boundedCapabilityDetail(matchedCapabilities)
      });
    }
    if (exactCapability) {
      initialReasons.push({
        code: "EXACT_TRIGGER_MATCH",
        detail: boundedCapabilityDetail(new Set(
          [...matchedCapabilityPairs].map((value) => `pair:${value}`)
        ))
      });
    }
    if (matchedHighConfidenceTrigger) {
      initialReasons.push({
        code: "HIGH_CONFIDENCE_TRIGGER",
        detail: `Task and routing metadata share the '${matchedHighConfidenceTrigger}' lifecycle trigger.`
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
        detail: negativeIntentTerms.size > 0
          ? `The task explicitly excludes: ${[...negativeIntentTerms].slice(0, 6).join(", ")}.`
          : `The Skill routing description explicitly excludes: ${[...negativeRouteTerms].slice(0, 6).join(", ")}.`
      });
    }

    return {
      candidate,
      routeTerms,
      matchedTaskTerms,
      negativeTaskTerms,
      capabilities,
      matchedCapabilities,
      capabilityCoverage,
      capabilityPrecision,
      triggerConfidence,
      relevance,
      adjustedRelevance,
      gapAdjustedRelevance,
      taskCoverage,
      skillPrecision,
      riskPenalty,
      installPenalty,
      nameMatch,
      projectScopeFit,
      plausible: candidate.harnessEligible && !critical && negativeTaskTerms.size === 0 &&
        ((exactCapability && capabilityRelevance >= 0.18) || nameMatch || (
          hasSpecificTaskMatch &&
          matchedTaskTerms.size >= PREFLIGHT_CONFIG.minimumMatchedTerms &&
          lexicalAdjustedRelevance >= PREFLIGHT_CONFIG.plausibleThreshold
        )),
      critical,
      initialReasons
    };
  });

  return { candidates, taskTerms, taskCapabilities };
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.adjustedRelevance - left.adjustedRelevance ||
    left.candidate.contextTokens - right.candidate.contextTokens ||
    left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

function selectInstalled(
  candidates: ScoredCandidate[],
  taskTerms: Set<string>,
  taskCapabilities: CapabilitySet,
  maxSkills: number
): SelectedCandidate[] {
  const plausible = candidates.filter(
    ({ candidate, plausible }) => candidate.availability === "installed" && plausible
  );
  if (plausible.length === 0) return [];

  const remaining = [...plausible].sort(compareCandidates);
  const selected: SelectedCandidate[] = [];
  const coveredTerms = new Set<string>();
  const coveredCapabilities = new Set<string>();
  const selectedRouteTerms = new Set<string>();
  const selectedCapabilityTerms = new Set<string>();

  while (remaining.length > 0 && selected.length < maxSkills) {
    const ranked = remaining.flatMap((candidate) => {
      const uncovered = new Set(
        [...candidate.matchedTaskTerms].filter((term) => !coveredTerms.has(term))
      );
      const uniqueCoverage = ratio(uncovered.size, taskTerms.size);
      const uniqueCapabilities = new Set(
        [...candidate.matchedCapabilities].filter(
          (capability) => !coveredCapabilities.has(capability)
        )
      );
      const capabilityGain = weightedCapabilityRatio(
        uniqueCapabilities,
        taskCapabilities.all
      );
      if (
        selected.length > 0 &&
        uncovered.size === 0 &&
        uniqueCapabilities.size === 0
      ) return [];
      const redundancyPenalty = Math.max(
        jaccard(candidate.routeTerms, selectedRouteTerms) *
          PREFLIGHT_CONFIG.redundancyWeight,
        jaccard(candidate.capabilities.all, selectedCapabilityTerms) * 0.45
      );
      const marginal = clamp(
        candidate.relevance + uniqueCoverage + capabilityGain * 0.8 -
        redundancyPenalty - candidate.riskPenalty
      );
      return [{
        candidate,
        uniqueCoverage,
        redundancyPenalty,
        uniqueCapabilities,
        capabilityGain,
        marginal
      }];
    }).sort((left, right) =>
      right.marginal - left.marginal || compareCandidates(left.candidate, right.candidate)
    );
    const next = ranked[0];
    if (!next || (selected.length > 0 && next.marginal < PREFLIGHT_CONFIG.marginalThreshold)) {
      break;
    }
    selected.push(next);
    next.candidate.matchedTaskTerms.forEach((term) => coveredTerms.add(term));
    next.candidate.matchedCapabilities.forEach((term) => coveredCapabilities.add(term));
    next.candidate.routeTerms.forEach((term) => selectedRouteTerms.add(term));
    next.candidate.capabilities.all.forEach((term) => selectedCapabilityTerms.add(term));
    remaining.splice(remaining.indexOf(next.candidate), 1);
  }

  return selected;
}

function selectedTerms(selected: SelectedCandidate[]): Set<string> {
  return new Set(selected.flatMap(({ candidate }) => [...candidate.matchedTaskTerms]));
}

function selectAvailable(
  candidates: ScoredCandidate[],
  taskTerms: Set<string>,
  taskCapabilities: CapabilitySet,
  installed: SelectedCandidate[]
): SelectedCandidate[] {
  const remaining = candidates.filter(
    ({ candidate, plausible }) => candidate.availability === "available" && plausible
  );
  const selected: SelectedCandidate[] = [];
  const coveredTerms = selectedTerms(installed);
  const coveredCapabilities = new Set(
    installed.flatMap(({ candidate }) => [...candidate.matchedCapabilities])
  );
  const selectedRouteTerms = new Set(
    installed.flatMap(({ candidate }) => [...candidate.routeTerms])
  );
  const selectedCapabilityTerms = new Set(
    installed.flatMap(({ candidate }) => [...candidate.capabilities.all])
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
      const uniqueCoverage = ratio(uncovered.size, taskTerms.size);
      const uniqueCapabilities = new Set(
        [...candidate.matchedCapabilities].filter(
          (capability) => !coveredCapabilities.has(capability)
        )
      );
      const capabilityGain = weightedCapabilityRatio(
        uniqueCapabilities,
        taskCapabilities.all
      );
      if (uncovered.size === 0 && uniqueCapabilities.size === 0) return [];
      const redundancyPenalty = Math.max(
        jaccard(candidate.routeTerms, selectedRouteTerms) *
          PREFLIGHT_CONFIG.redundancyWeight,
        jaccard(candidate.capabilities.all, selectedCapabilityTerms) * 0.45
      );
      const marginal = clamp(
        candidate.relevance + uniqueCoverage + capabilityGain * 0.8 - redundancyPenalty -
        candidate.riskPenalty - candidate.installPenalty
      );
      return [{
        candidate,
        uniqueCoverage,
        redundancyPenalty,
        uniqueCapabilities,
        capabilityGain,
        marginal
      }];
    }).sort((left, right) =>
      right.marginal - left.marginal || compareCandidates(left.candidate, right.candidate)
    );
    const next = ranked[0];
    if (!next || next.marginal < PREFLIGHT_CONFIG.availableMarginalThreshold) break;
    selected.push(next);
    next.candidate.matchedTaskTerms.forEach((term) => coveredTerms.add(term));
    next.candidate.matchedCapabilities.forEach((term) => coveredCapabilities.add(term));
    next.candidate.routeTerms.forEach((term) => selectedRouteTerms.add(term));
    next.candidate.capabilities.all.forEach((term) => selectedCapabilityTerms.add(term));
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
  const selectedCapabilities = new Set(
    selected.flatMap(({ candidate }) => [...candidate.capabilities.all])
  );

  return candidates.map((candidate): PreflightCandidate => {
    const id = candidate.candidate.candidateId;
    const selectedEntry = selectedById.get(id);
    const capabilityRedundancy = jaccard(
      candidate.capabilities.all,
      selectedCapabilities
    );
    const redundancyPenalty = selectedEntry
      ? selectedEntry.redundancyPenalty
      : Math.max(
        jaccard(candidate.routeTerms, selectedRouteTerms) * PREFLIGHT_CONFIG.redundancyWeight,
        capabilityRedundancy * 0.45
      );
    const uniqueCoverage = selectedEntry?.uniqueCoverage ?? 0;
    const reasons = [...candidate.initialReasons];

    if (selectedEntry) {
      reasons.push({
        code: "UNIQUE_COVERAGE",
        detail: `${Math.round(uniqueCoverage * 100)}% unique task-term coverage.`
      });
      if (selectedEntry.uniqueCapabilities.size > 0) {
        reasons.push({
          code: "MARGINAL_CAPABILITY",
          detail: boundedCapabilityDetail(selectedEntry.uniqueCapabilities)
        });
      }
    } else if (!candidate.candidate.harnessEligible) {
      // The Harness visibility or compatibility reason is the primary exclusion.
    } else if (!candidate.plausible && !candidate.critical && candidate.candidate.harnessEligible) {
      reasons.push({
        code: "LOW_RELEVANCE",
        detail: "Task relevance is below the deterministic threshold."
      });
    } else if (candidate.plausible && capabilityRedundancy > 0) {
      reasons.push({
        code: "REDUNDANT_CAPABILITY",
        detail: `${Math.round(capabilityRedundancy * 100)}% capability overlap with the selected set.`
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
        projectScopeFit: candidate.projectScopeFit,
        capabilityCoverage: stableNumber(candidate.capabilityCoverage),
        capabilityPrecision: stableNumber(candidate.capabilityPrecision),
        triggerConfidence: candidate.triggerConfidence
      },
      decision,
      ...(candidate.candidate.source ? { source: candidate.candidate.source } : {}),
      reasons: reasons.slice(0, 12).map(({ code, detail }) => ({
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
  const { candidates, taskTerms, taskCapabilities } = scoreCandidates(
    normalizedTask,
    normalizedCandidates
  );
  const installed = selectInstalled(
    candidates,
    taskTerms,
    taskCapabilities,
    request.maxSkills
  );
  const available = request.includeAvailable
    ? selectAvailable(candidates, taskTerms, taskCapabilities, installed)
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
      positiveTaskText(normalizedTask),
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
