import type { Finding, SkillRecord } from "./domain.js";
import { sha256 } from "./fingerprint.js";

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

function terms(skill: SkillRecord): Set<string> {
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

export function analyzeOverlap(skills: SkillRecord[]): Finding[] {
  const findings: Finding[] = [];

  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex];
      const right = skills[rightIndex];
      if (!left || !right) continue;

      if (left.name === right.name) {
        findings.push(makeFinding({
          code: "DUPLICATE_SKILL_NAME",
          severity: "error",
          skillIds: [left.id, right.id],
          summary: `Two installed skills use the name '${left.name}'.`,
          evidence: [left.path, right.path],
          recommendation: "Keep one canonical copy or rename one skill with a narrower responsibility.",
          confidence: 1
        }));

        if (left.scope !== right.scope) {
          findings.push(makeFinding({
            code: "SCOPE_SHADOWING",
            severity: "warning",
            skillIds: [left.id, right.id],
            summary: `Skill '${left.name}' is installed in multiple scopes.`,
            evidence: [`${left.scope}: ${left.path}`, `${right.scope}: ${right.path}`],
            recommendation: "Confirm which copy the harness loads and remove unintended shadow copies.",
            confidence: 0.95
          }));
        }
        continue;
      }

      const score = jaccard(terms(left), terms(right));
      if (score >= 0.55) {
        findings.push(makeFinding({
          code: "HIGH_DESCRIPTION_OVERLAP",
          severity: "warning",
          skillIds: [left.id, right.id],
          summary: `'${left.name}' and '${right.name}' have highly overlapping routing metadata.`,
          evidence: [`jaccard=${score.toFixed(2)}`, left.description, right.description],
          recommendation: "Narrow one description, scope one skill to a project, or evaluate whether both are necessary.",
          confidence: Math.min(0.95, score)
        }));
      }
    }
  }

  return findings;
}
