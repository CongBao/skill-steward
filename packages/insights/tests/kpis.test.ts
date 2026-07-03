import { describe, expect, it } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
import { buildKpis, RECOMMENDED_KPI_IDS } from "../src/kpis.js";

const latest: PortfolioReport = {
  schemaVersion: 1,
  generatedAt: "2026-07-02T10:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  skills: [
    {
      id: "claude:global:review",
      name: "review",
      description: "Review changes",
      path: "/home/.claude/skills/review",
      root: "/home/.claude/skills",
      scope: "global",
      visibleTo: ["claude"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      estimatedTokens: 1200,
      files: [
        { relativePath: "SKILL.md", sha256: `sha256:${"c".repeat(64)}`, bytes: 2400 },
        { relativePath: "reference.md", sha256: `sha256:${"d".repeat(64)}`, bytes: 800 }
      ]
    },
    {
      id: "agents:project:test",
      name: "test",
      description: "Test changes",
      path: "/repo/.agents/skills/test",
      root: "/repo/.agents/skills",
      scope: "project",
      visibleTo: ["agents", "codex", "github-copilot"],
      fingerprint: `sha256:${"e".repeat(64)}`,
      estimatedTokens: 300,
      files: [
        { relativePath: "SKILL.md", sha256: `sha256:${"f".repeat(64)}`, bytes: 600 }
      ]
    }
  ],
  findings: [
    {
      id: "broken",
      code: "BROKEN_REFERENCE",
      severity: "error",
      skillIds: ["claude:global:review"],
      summary: "Broken reference",
      evidence: ["reference.md"],
      recommendation: "Repair it",
      confidence: 0.9
    },
    {
      id: "overlap",
      code: "SKILL_OVERLAP",
      severity: "warning",
      skillIds: ["claude:global:review", "agents:project:test"],
      summary: "Overlap",
      evidence: [],
      recommendation: "Clarify triggers",
      confidence: 0.7
    }
  ]
};

describe("buildKpis", () => {
  it("exposes sixteen stable KPI IDs and five recommended defaults", () => {
    expect(buildKpis({ latest, history: [], roots: [] }).map(({ id }) => id)).toEqual([
      "health-score",
      "open-findings",
      "installed-skills",
      "estimated-context",
      "harness-coverage",
      "bundle-size",
      "tracked-files",
      "broken-references",
      "overlap-groups",
      "parse-failures",
      "scope-distribution",
      "portfolio-change",
      "health-trend",
      "largest-skill",
      "root-availability",
      "finding-confidence"
    ]);
    expect(RECOMMENDED_KPI_IDS).toEqual([
      "health-score",
      "open-findings",
      "installed-skills",
      "estimated-context",
      "harness-coverage"
    ]);
  });

  it("calculates portfolio values without localized text", () => {
    const values = Object.fromEntries(
      buildKpis({
        latest,
        previous: { ...latest, skills: latest.skills.slice(0, 1) },
        history: [{ generatedAt: latest.generatedAt, healthScore: 83, skillCount: 2, findingCount: 2, estimatedTokens: 1500 }],
        roots: [
          { harness: "claude", scope: "global", path: "/home/.claude/skills", available: true, readable: true, skillCount: 1 },
          { harness: "codex", scope: "global", path: "/home/.codex/skills", available: false, readable: false, skillCount: 0 }
        ]
      }).map((kpi) => [kpi.id, kpi])
    );

    expect(values["health-score"]?.value).toBe(83);
    expect(values["estimated-context"]?.value).toBe(1500);
    expect(values["bundle-size"]?.value).toBe(3800);
    expect(values["portfolio-change"]?.comparison).toBe(1);
    expect(values["root-availability"]?.value).toEqual({ available: 1, total: 2 });
    expect(values["finding-confidence"]?.value).toBe(80);
  });
});
