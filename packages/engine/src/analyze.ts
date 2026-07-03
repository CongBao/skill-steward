import type {
  Finding,
  PortfolioReport,
  SkillRecord,
  SkillRoot
} from "./domain.js";
import { discoverSkills } from "./discover.js";
import { sha256 } from "./fingerprint.js";
import { analyzeOverlap } from "./overlap.js";
import { parseSkill } from "./parse-skill.js";
import { analyzeSingleSkill } from "./rules/single-skill.js";

export async function scanPortfolio(
  roots: SkillRoot[],
  now = new Date()
): Promise<PortfolioReport> {
  const discovered = await discoverSkills(roots);
  const skills: SkillRecord[] = [];
  const findings: Finding[] = [];

  for (const candidate of discovered) {
    try {
      const parsed = await parseSkill(candidate);
      findings.push(...await analyzeSingleSkill(parsed));
      const { body: _body, ...skill } = parsed;
      skills.push(skill);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const input = {
        code: "SKILL_PARSE_FAILED",
        severity: "error" as const,
        skillIds: [],
        summary: `Could not parse skill at ${candidate.path}.`,
        evidence: [message],
        recommendation: "Repair the SKILL.md frontmatter before relying on this skill.",
        confidence: 1
      };
      findings.push({ ...input, id: sha256(JSON.stringify(input)) });
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  findings.push(...analyzeOverlap(skills));
  findings.sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id));

  const portfolioFingerprint = sha256(
    skills.map((skill) => `${skill.path}\0${skill.fingerprint}`).join("\0")
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    portfolioFingerprint,
    skills,
    findings
  };
}
