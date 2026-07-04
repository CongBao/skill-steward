import { describe, expect, it } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
import { marked } from "marked";
import { renderJson, renderMarkdown } from "../src/render.js";

const report: PortfolioReport = {
  schemaVersion: 1,
  generatedAt: "2026-07-02T00:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  skills: [],
  findings: [
    {
      id: "finding-1",
      code: "BROKEN_RELATIVE_REFERENCE",
      severity: "error",
      skillIds: [],
      summary: "Missing file.",
      evidence: ["references/missing.md"],
      recommendation: "Restore the file.",
      confidence: 1
    }
  ]
};

describe("report rendering", () => {
  it("renders a Markdown finding with evidence and recommendation", () => {
    const output = renderMarkdown(report);
    expect(output).toContain("# Skill Steward Portfolio Report");
    expect(output).toContain("BROKEN_RELATIVE_REFERENCE");
    expect(output).toContain("references/missing.md");
    expect(output).toContain("Restore the file&#46;");
  });

  it("identifies affected Skills by name", () => {
    const skillId = "codex:global:review";
    const output = renderMarkdown({
      ...report,
      skills: [{
        id: skillId,
        name: "review",
        description: "Review code",
        path: "/skills/review",
        root: "/skills",
        scope: "global",
        visibleTo: ["codex"],
        fingerprint: `sha256:${"b".repeat(64)}`,
        files: [],
        estimatedTokens: 100
      }],
      findings: [{ ...report.findings[0]!, skillIds: [skillId] }]
    });

    expect(output).toContain("Affected Skills: `review`");
  });

  it("renders parseable JSON with a trailing newline", () => {
    const output = renderJson(report);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual(report);
  });

  it("renders complete schema-v2 coverage, provenance, and shadow-chain evidence", () => {
    const winnerId = "github-copilot:project:review";
    const pluginId = "github-copilot:plugin:review";
    const visibilityReport: PortfolioReport = {
      schemaVersion: 2,
      generatedAt: report.generatedAt,
      portfolioFingerprint: report.portfolioFingerprint,
      workspace: {
        path: "/workspace",
        identity: `sha256:${"f".repeat(64)}`
      },
      skills: [
        {
          id: winnerId,
          name: "review",
          description: "Review project changes",
          path: "/workspace/.github/skills/review",
          root: "/workspace/.github/skills",
          scope: "project",
          visibleTo: ["github-copilot"],
          fingerprint: `sha256:${"b".repeat(64)}`,
          files: [],
          estimatedTokens: 120,
          ownership: "direct",
          sourceIds: ["copilot-project"],
          exposures: [{
            harness: "github-copilot",
            effectiveName: "review",
            state: "effective",
            sourceId: "copilot-project",
            reason: "COPILOT_FIRST_FOUND"
          }]
        },
        {
          id: pluginId,
          name: "review",
          description: "Review changes from a plugin",
          path: "/home/.copilot/plugins/cache/team/review",
          root: "/home/.copilot/plugins/cache/team",
          scope: "global",
          visibleTo: [],
          fingerprint: `sha256:${"c".repeat(64)}`,
          files: [],
          estimatedTokens: 100,
          ownership: "native-plugin",
          plugin: { harness: "github-copilot", id: "quality@team", version: "2.1.0" },
          sourceIds: ["copilot-plugin"],
          exposures: [{
            harness: "github-copilot",
            effectiveName: "review",
            state: "shadowed",
            sourceId: "copilot-plugin",
            shadowedBy: winnerId,
            reason: "COPILOT_FIRST_FOUND_SHADOWED"
          }]
        }
      ],
      findings: [],
      inventory: {
        sources: [
          { id: "codex-direct", harness: "codex", scope: "global", kind: "direct-root", path: "/home/.codex/skills", status: "scanned", skillCount: 0, effectiveSkillCount: 0 },
          { id: "codex-config", harness: "codex", scope: "global", kind: "native-plugin", path: "/home/.codex/config.toml", status: "invalid", skillCount: 0, effectiveSkillCount: 0, diagnostic: { code: "METADATA_INVALID_TOML", message: "The bounded local configuration parser\nrejected this file." } },
          { id: "claude-direct", harness: "claude", scope: "global", kind: "direct-root", path: "/home/.claude/skills", status: "missing", skillCount: 0, effectiveSkillCount: 0 },
          { id: "copilot-project", harness: "github-copilot", scope: "project", kind: "direct-root", path: "/workspace/.github/skills", status: "scanned", skillCount: 1, effectiveSkillCount: 1 },
          { id: "copilot-plugin", harness: "github-copilot", scope: "global", kind: "native-plugin", path: "/home/.copilot/plugins/cache/team", plugin: { id: "quality@team", version: "2.1.0" }, status: "scanned", skillCount: 1, effectiveSkillCount: 0 },
          { id: "agents-convention", harness: "agents", scope: "global", kind: "convention-root", path: "/home/.agents/skills", status: "scanned", skillCount: 0, effectiveSkillCount: 0 }
        ],
        harnesses: [
          { harness: "codex", status: "partial", sourceIds: ["codex-direct", "codex-config"], skillCount: 0, effectiveSkillCount: 0 },
          { harness: "claude", status: "unavailable", sourceIds: ["claude-direct"], skillCount: 0, effectiveSkillCount: 0 },
          { harness: "github-copilot", status: "verified", sourceIds: ["copilot-project", "copilot-plugin"], skillCount: 2, effectiveSkillCount: 1 },
          { harness: "agents", status: "convention-only", sourceIds: ["agents-convention"], skillCount: 0, effectiveSkillCount: 0 }
        ]
      }
    };

    const output = renderMarkdown(visibilityReport);

    expect(output).toContain("## Harness inventory coverage");
    expect(output).toContain("| Codex | partial | 2 | 0 | 0 |");
    expect(output).toContain("| Claude Code | unavailable | 1 | 0 | 0 |");
    expect(output).toContain("| GitHub Copilot CLI | verified | 2 | 2 | 1 |");
    expect(output).toContain("| Agent Skills | convention-only | 1 | 0 | 0 |");
    expect(output).toContain("METADATA_INVALID_TOML");
    expect(output).toContain("The bounded local configuration parser rejected this file&#46;");
    expect(output).toContain("native-plugin · <code>quality@team</code> · <code>v2&#46;1&#46;0</code>");
    expect(output).toContain("GitHub Copilot CLI: shadowed by <code>review</code> as <code>review</code> (<code>COPILOT&#95;FIRST&#95;FOUND&#95;SHADOWED</code>)");
    expect(output).toContain("<code>copilot&#45;plugin</code>");
    expect(JSON.parse(renderJson(visibilityReport))).toEqual(visibilityReport);
  });

  it("does not invent verified inventory coverage for schema-v1 reports", () => {
    const output = renderMarkdown(report);

    expect(output).toContain("Inventory coverage requires a schema-v2 scan.");
    expect(output).not.toContain("| verified |");
  });

  it("neutralizes Markdown structures in legacy prose and safely fences references", () => {
    const backticks = "`".repeat(3);
    const maliciousName = "review | [name](https://evil.invalid) <b>raw</b>";
    const evidence = `\`edge|${backticks}run\``;
    const output = renderMarkdown({
      ...report,
      skills: [{
        id: "legacy-skill",
        name: maliciousName,
        description: "",
        path: "/skills/review",
        root: "/skills",
        scope: "global",
        visibleTo: ["codex"],
        fingerprint: `sha256:${"d".repeat(64)}`,
        files: [],
        estimatedTokens: 100
      }],
      findings: [{
        ...report.findings[0]!,
        skillIds: ["legacy-skill"],
        summary: "[summary](https://evil.invalid)\n# injected heading\n- injected list | <script>alert(1)</script>",
        evidence: [evidence],
        recommendation: "<img src=x onerror=alert(1)>\n1. injected [action](https://evil.invalid)"
      }]
    });
    const fence = "`".repeat(4);

    expect(output).not.toContain("[summary](https://evil.invalid)");
    expect(output).not.toContain("[action](https://evil.invalid)");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<img");
    expect(output).not.toMatch(/\n# injected heading/);
    expect(output).not.toMatch(/\n- injected list/);
    expect(output).toContain("&#91;summary&#93;&#40;https&#58;&#47;&#47;evil&#46;invalid&#41;");
    expect(output).toContain(`- Affected Skills: ${"`"}${maliciousName}${"`"}`);
    expect(output).toContain(`- Evidence: ${fence} ${evidence} ${fence}`);
  });

  it("uses context-safe code representations for schema-v2 identifiers and diagnostics", () => {
    const backticks = "`".repeat(3);
    const winnerId = "winner";
    const sourceId = `source|${backticks}\nnext`;
    const effectiveName = ` effective|${backticks}name `;
    const winnerName = `winner|${backticks}name`;
    const pluginId = `plugin|${backticks}id`;
    const output = renderMarkdown({
      schemaVersion: 2,
      generatedAt: report.generatedAt,
      portfolioFingerprint: report.portfolioFingerprint,
      workspace: { path: "/workspace", identity: `sha256:${"e".repeat(64)}` },
      skills: [{
        id: winnerId,
        name: winnerName,
        description: "",
        path: "/workspace/winner",
        root: "/workspace",
        scope: "project",
        visibleTo: ["codex"],
        fingerprint: `sha256:${"f".repeat(64)}`,
        files: [],
        estimatedTokens: 10,
        ownership: "direct",
        sourceIds: ["winner-source"],
        exposures: [{ harness: "codex", effectiveName, state: "effective", sourceId: "winner-source", reason: "DIRECT_SKILL" }]
      }, {
        id: "plugin-skill",
        name: "plugin review",
        description: "",
        path: "/plugins/review",
        root: "/plugins",
        scope: "global",
        visibleTo: [],
        fingerprint: `sha256:${"0".repeat(64)}`,
        files: [],
        estimatedTokens: 10,
        ownership: "native-plugin",
        plugin: { harness: "codex", id: pluginId },
        sourceIds: [sourceId],
        exposures: [{ harness: "codex", effectiveName, state: "shadowed", sourceId, shadowedBy: winnerId, reason: "DIRECT_SKILL_SHADOWED" }]
      }],
      findings: [],
      inventory: {
        sources: [{
          id: sourceId,
          harness: "codex",
          scope: "global",
          kind: "native-plugin",
          path: "/plugins",
          plugin: { id: pluginId },
          status: "invalid",
          skillCount: 1,
          effectiveSkillCount: 0,
          diagnostic: {
            code: "METADATA_INVALID",
            message: "[diagnostic](https://evil.invalid)\n## heading | <svg onload=alert(1)>"
          }
        }],
        harnesses: [{ harness: "codex", status: "partial", sourceIds: [sourceId], skillCount: 2, effectiveSkillCount: 1 }]
      }
    });
    const fence = "`".repeat(4);

    expect(output).not.toContain("[diagnostic](https://evil.invalid)");
    expect(output).not.toContain("<svg");
    expect(output).not.toMatch(/\n## heading/);
    expect(output).toContain(`${fence}source|${backticks} next${fence}`);
    expect(output).toContain(`<code>${effectiveName.replace("|", "&#124;").replaceAll("`", "&#96;")}</code>`);
    expect(output).toContain(`<code>${pluginId.replace("|", "&#124;").replaceAll("`", "&#96;")}</code>`);
    expect(output).toContain(`<code>${winnerName.replace("|", "&#124;").replaceAll("`", "&#96;")}</code>`);
    expect(output).toContain("<code>DIRECT&#95;SKILL&#95;SHADOWED</code>");
  });

  it("keeps arbitrary values inside their GFM table cells without active attacker markup", async () => {
    const winnerId = "winner";
    const winnerName = "winner\r[shadow-link](https://evil.invalid/shadow)";
    const sourceId = `source${"\\".repeat(1)}|INJECTED ${"\\".repeat(2)}|DOUBLE ${"\\".repeat(3)}|TRIPLE\r[source-link](https://evil.invalid/source) ![source-image](https://evil.invalid/source.png)`;
    const pluginId = "plugin\r![plugin-image](https://evil.invalid/plugin.png) &lt;img src=x onerror=alert(1)&gt;";
    const effectiveName = "effective\r[exposure-link](https://evil.invalid/exposure)";
    const output = renderMarkdown({
      schemaVersion: 2,
      generatedAt: report.generatedAt,
      portfolioFingerprint: report.portfolioFingerprint,
      workspace: { path: "/workspace", identity: `sha256:${"2".repeat(64)}` },
      skills: [{
        id: winnerId,
        name: winnerName,
        description: "",
        path: "/workspace/winner",
        root: "/workspace",
        scope: "project",
        visibleTo: ["codex"],
        fingerprint: `sha256:${"3".repeat(64)}`,
        files: [],
        estimatedTokens: 20,
        ownership: "direct",
        sourceIds: ["winner-source"],
        exposures: [{ harness: "codex", effectiveName: "winner", state: "effective", sourceId: "winner-source", reason: "DIRECT_SKILL" }]
      }, {
        id: "plugin-skill",
        name: "plugin\r[skill-link](https://evil.invalid/skill)",
        description: "",
        path: "/plugins/review",
        root: "/plugins",
        scope: "global",
        visibleTo: [],
        fingerprint: `sha256:${"4".repeat(64)}`,
        files: [],
        estimatedTokens: 10,
        ownership: "native-plugin",
        plugin: { harness: "codex", id: pluginId },
        sourceIds: [sourceId],
        exposures: [{ harness: "codex", effectiveName, state: "shadowed", sourceId, shadowedBy: winnerId, reason: "DIRECT_SKILL_SHADOWED" }]
      }],
      findings: [],
      inventory: {
        sources: [{ id: sourceId, harness: "codex", scope: "global", kind: "native-plugin", path: "/plugins", plugin: { id: pluginId }, status: "scanned", skillCount: 1, effectiveSkillCount: 0 }],
        harnesses: [{ harness: "codex", status: "partial", sourceIds: [sourceId], skillCount: 2, effectiveSkillCount: 1 }]
      }
    });
    const html = await marked.parse(output, { gfm: true });
    const skillsTable = html.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
    const rows = [...skillsTable.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    const pluginCells = [...(rows[2]?.[1] ?? "").matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)]
      .map((match) => match[1] ?? "");

    expect.soft(output).not.toContain("\r");
    expect.soft(skillsTable.match(/<th(?:\s|>)/g) ?? []).toHaveLength(6);
    expect.soft(rows).toHaveLength(3);
    expect.soft(skillsTable.match(/<td(?:\s|>)/g) ?? []).toHaveLength(12);
    expect.soft(pluginCells).toHaveLength(6);
    expect.soft(pluginCells[3]).toContain("INJECTED");
    expect.soft(pluginCells[4]).toContain("shadowed");
    expect.soft(pluginCells[5]?.trim()).toBe("10");
    expect.soft(output).toContain("<code>source&#92;&#124;INJECTED &#92;&#92;&#124;DOUBLE &#92;&#92;&#92;&#124;TRIPLE");
    expect.soft(output).toContain("&#38;lt;img src=x onerror=alert&#40;1&#41;&#38;gt;");
    expect.soft(html).not.toMatch(/<a\b/i);
    expect.soft(html).not.toMatch(/<img\b/i);
  });

  it("keeps inventory diagnostics bounded to 20 entries and 240 normalized characters", () => {
    const visibilityReport = {
      schemaVersion: 2 as const,
      generatedAt: report.generatedAt,
      portfolioFingerprint: report.portfolioFingerprint,
      workspace: { path: "/workspace", identity: `sha256:${"1".repeat(64)}` },
      skills: [],
      findings: [],
      inventory: {
        sources: Array.from({ length: 21 }, (_, index) => ({
          id: `source-${index}`,
          harness: "codex" as const,
          scope: "global" as const,
          kind: "direct-root" as const,
          path: `/source-${index}`,
          status: "invalid" as const,
          skillCount: 0,
          effectiveSkillCount: 0,
          diagnostic: { code: `DIAGNOSTIC_${index}`, message: "x".repeat(300) }
        })),
        harnesses: [{ harness: "codex" as const, status: "partial" as const, sourceIds: [], skillCount: 0, effectiveSkillCount: 0 }]
      }
    } satisfies PortfolioReport;
    const output = renderMarkdown(visibilityReport);
    const firstDiagnostic = output.split("\n").find((line) => line.includes("DIAGNOSTIC_0"));

    expect(output.match(/DIAGNOSTIC_\d+/g)).toHaveLength(20);
    expect(output).toContain("1 additional diagnostics omitted");
    expect(firstDiagnostic?.endsWith(`${"x".repeat(239)}…`)).toBe(true);
  });
});
