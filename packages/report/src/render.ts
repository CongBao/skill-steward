import type { Finding, PortfolioReport } from "@skill-steward/engine";

function escapeCode(value: string): string {
  return value.replaceAll("`", "\\`");
}

function renderFinding(
  finding: Finding,
  skillNames: ReadonlyMap<string, string>
): string {
  const evidence =
    finding.evidence.length === 0
      ? "- Evidence: none recorded"
      : finding.evidence
          .map((item) => `- Evidence: \`${escapeCode(item)}\``)
          .join("\n");
  const affectedSkills = finding.skillIds
    .map((skillId) => skillNames.get(skillId) ?? skillId)
    .join(", ");

  return [
    `## ${finding.severity.toUpperCase()}: ${finding.code}`,
    "",
    finding.summary,
    "",
    ...(affectedSkills.length > 0
      ? [`- Affected Skills: ${affectedSkills}`]
      : []),
    evidence,
    `- Confidence: ${finding.confidence.toFixed(2)}`,
    "",
    `Recommendation: ${finding.recommendation}`
  ].join("\n");
}

export function renderMarkdown(report: PortfolioReport): string {
  const skillNames = new Map(report.skills.map((skill) => [skill.id, skill.name]));
  const counts = report.findings.reduce<Record<string, number>>(
    (result, finding) => {
      result[finding.severity] = (result[finding.severity] ?? 0) + 1;
      return result;
    },
    {}
  );
  const summary = ["critical", "error", "warning", "info"]
    .map((severity) => `${severity}=${counts[severity] ?? 0}`)
    .join(", ");
  const skills =
    report.skills.length === 0
      ? "No valid skills discovered."
      : [
          "| Skill | Scope | Harnesses | Est. tokens |",
          "|---|---|---|---:|",
          ...report.skills.map(
            (skill) =>
              `| ${skill.name} | ${skill.scope} | ${skill.visibleTo.join(", ")} | ${skill.estimatedTokens} |`
          )
        ].join("\n");
  const findings =
    report.findings.length === 0
      ? "No findings."
      : report.findings
          .map((finding) => renderFinding(finding, skillNames))
          .join("\n\n");

  return [
    "# Skill Steward Portfolio Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Portfolio: ${report.portfolioFingerprint}`,
    `Summary: ${summary}`,
    "",
    "## Installed skills",
    "",
    skills,
    "",
    "## Findings",
    "",
    findings,
    ""
  ].join("\n");
}

export function renderJson(report: PortfolioReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
