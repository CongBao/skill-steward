import type { DashboardSnapshot } from "./client.js";

const codexSources = Array.from({ length: 8 }, (_, index) => ({
  id: `qa-codex-${index}`,
  harness: "codex",
  scope: (index === 0 ? "project" : "global") as "project" | "global",
  kind: (index === 7 ? "native-plugin" : "direct-root") as "native-plugin" | "direct-root",
  path: `/qa-fixture/local/codex/source-${index}`,
  ...(index === 7
    ? { plugin: { id: "quality@fixture", version: "2.1.0" } }
    : {}),
  status: (index === 6 ? "invalid" : "scanned") as "invalid" | "scanned",
  skillCount: index === 7 ? 2 : 0,
  effectiveSkillCount: index === 7 ? 1 : 0,
  ...(index === 6
    ? { diagnostic: { code: "METADATA_INVALID_TOML", message: "Fixture-only invalid metadata" } }
    : {})
}));

export const inventoryCoverageFixture: DashboardSnapshot = {
  status: "ready",
  latest: {
    generatedAt: "2026-07-04T08:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skillCount: 3,
    findingCount: 1
  },
  kpis: [
    { id: "health-score", value: 82, status: "attention" },
    { id: "open-findings", value: 1, status: "attention" },
    { id: "installed-skills", value: 3, status: "neutral" },
    { id: "estimated-context", value: 1_460, status: "neutral" },
    { id: "harness-coverage", value: 2, status: "neutral" },
    { id: "inventory-coverage", value: { verified: 1, total: 3 }, status: "attention" }
  ],
  skills: [
    {
      id: "qa-direct-review",
      name: "Project review",
      description: "Review project changes before delivery.",
      path: "/qa-fixture/workspace/.github/skills/review",
      scope: "project",
      visibleTo: ["github-copilot"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 480,
      ownership: "direct",
      sourceIds: ["qa-copilot-project"],
      exposures: [{
        harness: "github-copilot",
        effectiveName: "review",
        state: "effective",
        sourceId: "qa-copilot-project",
        reason: "COPILOT_FIRST_FOUND"
      }]
    },
    {
      id: "qa-plugin-review",
      name: "Plugin review",
      description: "Review changes from the installed quality plugin.",
      path: "/qa-fixture/local/copilot/plugins/quality/review",
      scope: "global",
      visibleTo: [],
      fingerprint: `sha256:${"c".repeat(64)}`,
      files: [],
      estimatedTokens: 460,
      ownership: "native-plugin",
      plugin: { harness: "github-copilot", id: "quality@fixture", version: "2.1.0" },
      sourceIds: ["qa-copilot-plugin"],
      exposures: [{
        harness: "github-copilot",
        effectiveName: "review",
        state: "shadowed",
        sourceId: "qa-copilot-plugin",
        shadowedBy: "qa-direct-review",
        reason: "COPILOT_FIRST_FOUND_SHADOWED"
      }]
    },
    {
      id: "qa-codex-plugin",
      name: "Release checks",
      description: "Run the release-readiness review workflow.",
      path: "/qa-fixture/local/codex/plugins/release/checks",
      scope: "global",
      visibleTo: ["codex"],
      fingerprint: `sha256:${"d".repeat(64)}`,
      files: [],
      estimatedTokens: 520,
      ownership: "native-plugin",
      plugin: { harness: "codex", id: "release@fixture", version: "1.4.0" },
      sourceIds: ["qa-codex-7"],
      exposures: [{
        harness: "codex",
        effectiveName: "release-checks",
        state: "effective",
        sourceId: "qa-codex-7",
        reason: "CODEX_PRESERVES_INSTANCES"
      }]
    }
  ],
  priorityFindings: [{
    id: "qa-finding",
    code: "INVENTORY_COVERAGE_PARTIAL",
    severity: "warning",
    skillIds: [],
    summary: "One core adapter has partial coverage.",
    evidence: [],
    recommendation: "Review the bounded local diagnostic.",
    confidence: 1
  }],
  history: [],
  roots: [],
  inventory: {
    sources: [
      ...codexSources,
      { id: "qa-claude", harness: "claude", scope: "global", kind: "native-plugin", path: "/qa-fixture/local/claude/plugins", status: "ambiguous", skillCount: 0, effectiveSkillCount: 0, diagnostic: { code: "CLAUDE_ACTIVE_VERSION_AMBIGUOUS", message: "Fixture-only ambiguous version" } },
      { id: "qa-copilot-project", harness: "github-copilot", scope: "project", kind: "direct-root", path: "/qa-fixture/workspace/.github/skills", status: "scanned", skillCount: 1, effectiveSkillCount: 1 },
      { id: "qa-copilot-plugin", harness: "github-copilot", scope: "global", kind: "native-plugin", path: "/qa-fixture/local/copilot/plugins/quality", plugin: { id: "quality@fixture", version: "2.1.0" }, status: "scanned", skillCount: 1, effectiveSkillCount: 0 },
      { id: "qa-agents", harness: "agents", scope: "global", kind: "convention-root", path: "/qa-fixture/local/.agents/skills", status: "scanned", skillCount: 2, effectiveSkillCount: 0 },
      { id: "qa-gemini", harness: "gemini", scope: "project", kind: "convention-root", path: "/qa-fixture/workspace/.gemini/skills", status: "missing", skillCount: 0, effectiveSkillCount: 0 }
    ],
    harnesses: [
      { harness: "codex", status: "partial", sourceIds: codexSources.map(({ id }) => id), skillCount: 2, effectiveSkillCount: 1 },
      { harness: "claude", status: "partial", sourceIds: ["qa-claude"], skillCount: 0, effectiveSkillCount: 0 },
      { harness: "github-copilot", status: "verified", sourceIds: ["qa-copilot-project", "qa-copilot-plugin"], skillCount: 2, effectiveSkillCount: 1 },
      { harness: "agents", status: "convention-only", sourceIds: ["qa-agents"], skillCount: 2, effectiveSkillCount: 0 },
      { harness: "gemini", status: "convention-only", sourceIds: ["qa-gemini"], skillCount: 0, effectiveSkillCount: 0 }
    ]
  }
};

export function inventoryCoverageFixtureResponse(path: string): { found: boolean; data?: unknown } {
  if (!import.meta.env.DEV || typeof window === "undefined") return { found: false };
  if (new URLSearchParams(window.location.search).get("fixture") !== "inventory-coverage") {
    return { found: false };
  }
  const fixtures: Record<string, unknown> = {
    "/api/v1/dashboard": inventoryCoverageFixture,
    "/api/v1/roots": [],
    "/api/v1/governance/transactions": [],
    "/api/v1/integrations": [],
    "/api/v1/integrations/capabilities": [],
    "/api/v1/catalog/sources": { sources: [], snapshot: null },
    "/api/v1/evidence/policy": { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
  };
  return Object.hasOwn(fixtures, path)
    ? { found: true, data: fixtures[path] }
    : { found: false };
}
