import { expect, it } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
import { buildDashboardSnapshot } from "../src/dashboard.js";

it("builds a first-run snapshot without fabricating report data", () => {
  expect(
    buildDashboardSnapshot({ latest: undefined, previous: undefined, history: [], roots: [] })
  ).toMatchObject({
    status: "first-run",
    latest: null,
    kpis: [],
    priorityFindings: []
  });
});

it("preserves every schema-v2 inventory source and coverage record", () => {
  const latest: PortfolioReport = {
    schemaVersion: 2,
    generatedAt: "2026-07-04T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    workspace: { path: "/workspace", identity: `sha256:${"b".repeat(64)}` },
    skills: [],
    findings: [],
    inventory: {
      sources: Array.from({ length: 8 }, (_, index) => ({
        id: `codex-source-${index}`,
        harness: "codex" as const,
        scope: "global" as const,
        kind: "direct-root" as const,
        path: `/local/source-${index}`,
        status: "scanned" as const,
        skillCount: 0,
        effectiveSkillCount: 0
      })),
      harnesses: [{
        harness: "codex",
        status: "verified",
        sourceIds: Array.from({ length: 8 }, (_, index) => `codex-source-${index}`),
        skillCount: 0,
        effectiveSkillCount: 0
      }]
    }
  };

  const snapshot = buildDashboardSnapshot({ latest, previous: undefined, history: [], roots: [] });

  expect(snapshot.inventory).toEqual(latest.inventory);
  expect(snapshot.inventory?.sources).toHaveLength(8);
});
