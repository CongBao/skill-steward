import type { PortfolioReport } from "@skill-steward/engine";
import type { DashboardSnapshot } from "@skill-steward/insights";

export const report: PortfolioReport = {
  schemaVersion: 2,
  generatedAt: "2026-07-02T10:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  workspace: {
    path: "/workspace",
    identity: `sha256:${"c".repeat(64)}`
  },
  skills: [
    {
      id: "skill-1",
      name: "review",
      description: "Review changes",
      path: "/skills/review",
      root: "review",
      scope: "global",
      visibleTo: ["claude"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 100,
      ownership: "direct",
      sourceIds: ["claude:fixture"],
      exposures: [{
        harness: "claude",
        effectiveName: "review",
        state: "effective",
        sourceId: "claude:fixture",
        reason: "TEST_EFFECTIVE"
      }]
    }
  ],
  findings: [
    {
      id: "finding-1",
      code: "BROKEN_RELATIVE_REFERENCE",
      severity: "error",
      skillIds: ["skill-1"],
      summary: "Broken reference",
      evidence: ["missing.md"],
      recommendation: "Repair it",
      confidence: 1
    }
  ],
  inventory: {
    sources: [{
      id: "claude:fixture",
      harness: "claude",
      scope: "global",
      kind: "direct-root",
      path: "/skills",
      status: "scanned",
      skillCount: 1,
      effectiveSkillCount: 1
    }],
    harnesses: [{
      harness: "claude",
      status: "verified",
      sourceIds: ["claude:fixture"],
      skillCount: 1,
      effectiveSkillCount: 1
    }]
  }
};

export const snapshot: DashboardSnapshot = {
  status: "ready",
  latest: {
    generatedAt: report.generatedAt,
    portfolioFingerprint: report.portfolioFingerprint,
    skillCount: 1,
    findingCount: 1
  },
  kpis: [],
  skills: report.skills,
  priorityFindings: report.findings,
  history: [],
  roots: [],
  inventory: report.inventory
};
