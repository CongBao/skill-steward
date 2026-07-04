import type {
  Finding,
  HarnessId,
  SkillRecord,
  SkillRecordV2
} from "./domain.js";
import { sha256 } from "./fingerprint.js";
import { compareCodeUnits } from "./inventory/selection.js";

type AnalyzedSkill = SkillRecord | SkillRecordV2;
const MAX_OVERLAP_FINDINGS = 2_000;

const stopWords = new Set([
  "a", "an", "and", "by", "for", "from", "in", "of", "on", "or", "the", "to", "use", "when", "with"
]);

function normalizeTerm(value: string): string {
  let term = value;
  if (term.endsWith("ing") && term.length > 5) {
    term = term.slice(0, -3);
    if (term.length > 2 && term.at(-1) === term.at(-2)) term = term.slice(0, -1);
  } else if (term.endsWith("s") && term.length > 3) {
    term = term.slice(0, -1);
  }
  return term;
}

function terms(skill: AnalyzedSkill): Set<string> {
  const normalized = `${skill.name.replaceAll("-", " ")} ${skill.description}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !stopWords.has(term))
    .map(normalizeTerm);

  return new Set(normalized);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function makeFinding(input: Omit<Finding, "id">): Finding {
  return { ...input, id: sha256(JSON.stringify(input)) };
}

export function analyzeOverlap(skills: AnalyzedSkill[]): Finding[] {
  const findings: Finding[] = [];
  let truncated = false;
  const addFinding = (input: Omit<Finding, "id">): boolean => {
    if (findings.length >= MAX_OVERLAP_FINDINGS - 1) {
      truncated = true;
      return false;
    }
    findings.push(makeFinding(input));
    return true;
  };

  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const emittedShadowFindings = new Set<string>();
  shadowLoop:
  for (const skill of skills) {
    if (!isVisibilitySkill(skill)) continue;
    for (const exposure of skill.exposures) {
      if (exposure.state !== "shadowed" || !exposure.shadowedBy) continue;
      const winner = skillById.get(exposure.shadowedBy);
      if (!winner || winner.id === skill.id || winner.path === skill.path) continue;
      const key = [
        exposure.harness,
        exposure.effectiveName,
        winner.id,
        skill.id
      ].join("\0");
      if (emittedShadowFindings.has(key)) continue;
      emittedShadowFindings.add(key);
      if (!addFinding({
        code: "HARNESS_SKILL_SHADOWED",
        severity: "warning",
        skillIds: [winner.id, skill.id],
        summary: `${exposure.harness} resolves '${exposure.effectiveName}' to another installed Skill.`,
        evidence: [
          `harness=${exposure.harness}`,
          `effectiveName=${exposure.effectiveName}`,
          `winner=${winner.id}`,
          `shadowed=${skill.id}`
        ],
        recommendation: "Use the effective instance or change the owning Harness configuration.",
        confidence: 1
      })) break shadowLoop;
    }
  }

  pairLoop:
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex];
      const right = skills[rightIndex];
      if (!left || !right) continue;
      if (left.path === right.path) continue;

      if (left.fingerprint === right.fingerprint) {
        if (!addFinding({
          code: "DUPLICATE_SKILL_CONTENT",
          severity: "warning",
          skillIds: [left.id, right.id],
          summary: `'${left.name}' and '${right.name}' contain the same Skill bundle content.`,
          evidence: [left.path, right.path, `fingerprint=${left.fingerprint}`],
          recommendation: "Keep both only when their separate locations or Harness ownership are intentional.",
          confidence: 1
        })) break pairLoop;
      }

      const commonDomains = intersectedDomains(left, right);
      if (commonDomains.length === 0) continue;

      if (isVisibilitySkill(left) && isVisibilitySkill(right)) {
        const collisions = intersectedExposureNames(left, right);
        for (const collision of collisions) {
          if (!addFinding({
            code: "DUPLICATE_SKILL_NAME",
            severity: "error",
            skillIds: [left.id, right.id],
            summary: `Two installed Skills expose '${collision.effectiveName}' to ${collision.harness}.`,
            evidence: [
              `harness=${collision.harness}`,
              `effectiveName=${collision.effectiveName}`
            ],
            recommendation: "Keep both only when this Harness intentionally accepts multiple matching instances.",
            confidence: 1
          })) break pairLoop;
        }
        if (collisions.length > 0) continue;
      } else if (left.name === right.name) {
        if (!addFinding({
          code: "DUPLICATE_SKILL_NAME",
          severity: "error",
          skillIds: [left.id, right.id],
          summary: `Two installed skills use the name '${left.name}'.`,
          evidence: [left.path, right.path],
          recommendation: "Keep one canonical copy or rename one skill with a narrower responsibility.",
          confidence: 1
        })) break pairLoop;

        if (left.scope !== right.scope) {
          if (!addFinding({
            code: "SCOPE_SHADOWING",
            severity: "warning",
            skillIds: [left.id, right.id],
            summary: `Skill '${left.name}' is installed in multiple scopes.`,
            evidence: [`${left.scope}: ${left.path}`, `${right.scope}: ${right.path}`],
            recommendation: "Confirm which copy the harness loads and remove unintended shadow copies.",
            confidence: 0.95
          })) break pairLoop;
        }
        continue;
      }

      const score = jaccard(terms(left), terms(right));
      if (score >= 0.55) {
        if (!addFinding({
          code: "HIGH_DESCRIPTION_OVERLAP",
          severity: "warning",
          skillIds: [left.id, right.id],
          summary: `'${left.name}' and '${right.name}' have highly overlapping routing metadata.`,
          evidence: [`jaccard=${score.toFixed(2)}`, left.description, right.description],
          recommendation: "Narrow one description, scope one skill to a project, or evaluate whether both are necessary.",
          confidence: Math.min(0.95, score)
        })) break pairLoop;
      }
    }
  }

  if (truncated) {
    findings.push(makeFinding({
      code: "OVERLAP_FINDINGS_TRUNCATED",
      severity: "info",
      skillIds: [],
      summary: "Overlap analysis reached its deterministic finding limit.",
      evidence: [`limit=${MAX_OVERLAP_FINDINGS}`],
      recommendation: "Review higher-priority findings first, then narrow the scanned roots if more detail is needed.",
      confidence: 1
    }));
  }

  return findings;
}

function isVisibilitySkill(skill: AnalyzedSkill): skill is SkillRecordV2 {
  return "exposures" in skill && Array.isArray(skill.exposures);
}

function exposureDomains(skill: AnalyzedSkill): Set<HarnessId> {
  if (!isVisibilitySkill(skill)) return new Set(skill.visibleTo);
  return new Set<HarnessId>(skill.exposures
    .filter(({ state }) => state === "effective" || state === "ambiguous")
    .map(({ harness }) => harness));
}

function intersectedDomains(
  left: AnalyzedSkill,
  right: AnalyzedSkill
): HarnessId[] {
  const rightDomains = exposureDomains(right);
  return [...exposureDomains(left)]
    .filter((harness) => rightDomains.has(harness))
    .sort() as HarnessId[];
}

function intersectedExposureNames(
  left: SkillRecordV2,
  right: SkillRecordV2
): Array<{ harness: HarnessId; effectiveName: string }> {
  const active = (skill: SkillRecordV2) => skill.exposures.filter(({ state }) =>
    state === "effective" || state === "ambiguous"
  );
  const rightKeys = new Set(active(right).map(({ harness, effectiveName }) =>
    JSON.stringify([harness, effectiveName])
  ));
  const collisions = new Map<
    string,
    { harness: HarnessId; effectiveName: string }
  >();
  for (const { harness, effectiveName } of active(left)) {
    const key = JSON.stringify([harness, effectiveName]);
    if (rightKeys.has(key)) collisions.set(key, { harness, effectiveName });
  }
  return [...collisions.values()].sort((leftName, rightName) =>
    compareCodeUnits(leftName.harness, rightName.harness) ||
    compareCodeUnits(leftName.effectiveName, rightName.effectiveName)
  );
}
