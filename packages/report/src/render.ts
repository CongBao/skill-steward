import {
  isVisibilityReport,
  type Finding,
  type HarnessId,
  type PortfolioReport,
  type PortfolioReportV2,
  type SkillRecordV2
} from "@skill-steward/engine";

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 240;

function normalizeLineEndings(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function markdownText(value: string): string {
  const normalized = normalizeLineEndings(value);
  return normalized.replace(
    /[&<>"'\\`*_[\]{}()#+\-.!|:/]/g,
    (character) => `&#${character.codePointAt(0)!};`
  );
}

function inlineCode(value: string): string {
  const content = normalizeLineEndings(value);
  const longestRun = (content.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0
  );
  const fence = "`".repeat(longestRun + 1);
  const padding = /^\s|\s$/.test(content) ||
    content.startsWith("`") ||
    content.endsWith("`")
    ? " "
    : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function tableCode(value: string): string {
  return `<code>${markdownText(value)}</code>`;
}

function harnessName(harness: HarnessId): string {
  if (harness === "codex") return "Codex";
  if (harness === "claude") return "Claude Code";
  if (harness === "github-copilot") return "GitHub Copilot CLI";
  if (harness === "agents") return "Agent Skills";
  return harness;
}

function boundedDiagnostic(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= MAX_DIAGNOSTIC_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function renderCoverage(report: PortfolioReport): string {
  if (!isVisibilityReport(report)) {
    return "Inventory coverage requires a schema-v2 scan.";
  }

  const table = [
    "| Harness | Coverage | Inspected sources | Skills | Effective |",
    "|---|---|---:|---:|---:|",
    ...report.inventory.harnesses.map((coverage) =>
      `| ${harnessName(coverage.harness)} | ${coverage.status} | ${coverage.sourceIds.length} | ${coverage.skillCount} | ${coverage.effectiveSkillCount} |`
    )
  ];
  const diagnostics = report.inventory.sources.flatMap((source) =>
    source.diagnostic ? [{ source, diagnostic: source.diagnostic }] : []
  );
  if (diagnostics.length === 0) return [...table, "", "No inventory diagnostics."].join("\n");

  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS).map(({ source, diagnostic }) =>
    `- ${inlineCode(diagnostic.code)} (${harnessName(source.harness)}, ${inlineCode(source.id)}): ${markdownText(boundedDiagnostic(diagnostic.message))}`
  );
  const remainder = diagnostics.length - shown.length;
  return [
    ...table,
    "",
    "### Inventory diagnostics",
    "",
    ...shown,
    ...(remainder > 0 ? [`- ${remainder} additional diagnostics omitted from this bounded summary.`] : [])
  ].join("\n");
}

function skillProvenance(skill: SkillRecordV2): string {
  if (skill.ownership === "direct") return "direct";
  return [
    "native-plugin",
    tableCode(skill.plugin.id),
    ...(skill.plugin.version ? [tableCode(`v${skill.plugin.version}`)] : [])
  ].join(" · ");
}

function renderVisibilitySkills(report: PortfolioReportV2): string {
  if (report.skills.length === 0) return "No valid skills discovered.";
  const skillNames = new Map(report.skills.map((skill) => [skill.id, skill.name]));
  return [
    "| Skill | Scope | Provenance | Sources | Harness exposure | Est. tokens |",
    "|---|---|---|---|---|---:|",
    ...report.skills.map((skill) => {
      const exposures = skill.exposures.map((exposure) => {
        const shadow = exposure.shadowedBy
          ? ` by ${tableCode(skillNames.get(exposure.shadowedBy) ?? "another resolved Skill")}`
          : "";
        return `${harnessName(exposure.harness)}: ${exposure.state}${shadow} as ${tableCode(exposure.effectiveName)} (${tableCode(exposure.reason)})`;
      }).join("; ") || "none";
      return `| ${markdownText(skill.name)} | ${skill.scope} | ${skillProvenance(skill)} | ${skill.sourceIds.map(tableCode).join(", ")} | ${exposures} | ${skill.estimatedTokens} |`;
    })
  ].join("\n");
}

function renderFinding(
  finding: Finding,
  skillNames: ReadonlyMap<string, string>
): string {
  const evidence =
    finding.evidence.length === 0
      ? "- Evidence: none recorded"
      : finding.evidence
          .map((item) => `- Evidence: ${inlineCode(item)}`)
          .join("\n");
  const affectedSkills = finding.skillIds
    .map((skillId) => inlineCode(skillNames.get(skillId) ?? skillId))
    .join(", ");

  return [
    `## ${finding.severity.toUpperCase()}: ${inlineCode(finding.code)}`,
    "",
    markdownText(finding.summary),
    "",
    ...(affectedSkills.length > 0
      ? [`- Affected Skills: ${affectedSkills}`]
      : []),
    evidence,
    `- Confidence: ${finding.confidence.toFixed(2)}`,
    "",
    `Recommendation: ${markdownText(finding.recommendation)}`
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
  const skills = isVisibilityReport(report)
    ? renderVisibilitySkills(report)
    : report.skills.length === 0
      ? "No valid skills discovered."
      : [
          "| Skill | Scope | Harnesses | Est. tokens |",
          "|---|---|---|---:|",
          ...report.skills.map(
            (skill) =>
              `| ${markdownText(skill.name)} | ${skill.scope} | ${skill.visibleTo.join(", ")} | ${skill.estimatedTokens} |`
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
    `Generated: ${inlineCode(report.generatedAt)}`,
    `Portfolio: ${inlineCode(report.portfolioFingerprint)}`,
    `Summary: ${summary}`,
    "",
    "## Installed skills",
    "",
    skills,
    "",
    "## Harness inventory coverage",
    "",
    renderCoverage(report),
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
