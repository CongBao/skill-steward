import { access } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Finding, ParsedSkill } from "../domain.js";
import { sha256 } from "../fingerprint.js";

function finding(input: Omit<Finding, "id">): Finding {
  return { ...input, id: sha256(JSON.stringify(input)) };
}

function markdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#"));
}

export async function analyzeSingleSkill(skill: ParsedSkill): Promise<Finding[]> {
  const findings: Finding[] = [];

  if (skill.name !== skill.root) {
    findings.push(finding({
      code: "NAME_DIRECTORY_MISMATCH",
      severity: "warning",
      skillIds: [skill.id],
      summary: `Skill name '${skill.name}' differs from directory '${skill.root}'.`,
      evidence: [skill.path],
      recommendation: "Rename the directory or frontmatter name so routing and installation metadata agree.",
      confidence: 1
    }));
  }

  for (const target of markdownLinks(skill.body)) {
    const cleanTarget = target.split("#")[0] ?? target;
    const skillRoot = resolve(skill.path);
    const absoluteTarget = resolve(dirname(join(skill.path, "SKILL.md")), cleanTarget);

    if (absoluteTarget !== skillRoot && !absoluteTarget.startsWith(`${skillRoot}${sep}`)) {
      findings.push(finding({
        code: "REFERENCE_ESCAPES_SKILL_ROOT",
        severity: "warning",
        skillIds: [skill.id],
        summary: `Relative reference '${target}' resolves outside the skill root.`,
        evidence: [`${skill.path}/SKILL.md -> ${target}`],
        recommendation: "Copy the reference into the skill bundle or remove the external relative path.",
        confidence: 1
      }));
      continue;
    }

    try {
      await access(absoluteTarget);
    } catch {
      findings.push(finding({
        code: "BROKEN_RELATIVE_REFERENCE",
        severity: "error",
        skillIds: [skill.id],
        summary: `Relative reference '${target}' does not exist.`,
        evidence: [`${skill.path}/SKILL.md -> ${target}`],
        recommendation: "Restore the referenced file or remove the dead link.",
        confidence: 1
      }));
    }
  }

  const combined = `${skill.description}\n${skill.body}`;
  const absolutePaths = combined.match(/(?:\/Users\/[^\s`'\")]+|\/home\/[^\s`'\")]+|[A-Za-z]:\\\\Users\\\\[^\s`'\")]+)/g) ?? [];
  if (absolutePaths.length > 0) {
    findings.push(finding({
      code: "USER_SPECIFIC_ABSOLUTE_PATH",
      severity: "warning",
      skillIds: [skill.id],
      summary: "Skill contains user-specific absolute paths.",
      evidence: [...new Set(absolutePaths)].slice(0, 5),
      recommendation: "Replace user-specific paths with environment variables or paths relative to the skill root.",
      confidence: 0.95
    }));
  }

  const lineCount = skill.body.split(/\r?\n/).length;
  if (lineCount > 500) {
    findings.push(finding({
      code: "OVERSIZED_SKILL_BODY",
      severity: "warning",
      skillIds: [skill.id],
      summary: `SKILL.md body contains ${lineCount} lines.`,
      evidence: [`estimatedTokens=${skill.estimatedTokens}`],
      recommendation: "Move detailed references or deterministic procedures into references/ or scripts/.",
      confidence: 1
    }));
  }

  return findings;
}
