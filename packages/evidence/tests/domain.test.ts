import { describe, expect, it } from "vitest";
import {
  candidateFeatureSnapshotSchema,
  evidenceDeliverySchema,
  evidenceDatasetSchema,
  evidenceEventSchema,
  evidenceHarnessSchema,
  evidencePolicySchema,
  evidencePreflightSchema,
  evidenceSummarySchema,
  normalizeEvidenceHarness
} from "../src/index.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const pseudonym = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const zeroMetric = { numerator: 0, denominator: 0, value: null } as const;
const zeroMetrics = {
  feedbackRate: zeroMetric,
  usefulRate: zeroMetric,
  incompleteRate: zeroMetric,
  incorrectRate: zeroMetric,
  correctionPrecision: zeroMetric,
  correctionRecall: zeroMetric,
  correctionF1: zeroMetric,
  installConversion: zeroMetric
};
const zeroBreakdown = {
  key: "empty",
  totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 },
  metrics: zeroMetrics
};

describe("evidence domain", () => {
  it("preserves valid engine Harness IDs while canonicalizing Claude", () => {
    expect([
      normalizeEvidenceHarness("codex"),
      normalizeEvidenceHarness("claude"),
      normalizeEvidenceHarness("github-copilot"),
      normalizeEvidenceHarness("cursor"),
      normalizeEvidenceHarness("gemini"),
      normalizeEvidenceHarness("agents"),
      normalizeEvidenceHarness("unknown"),
      normalizeEvidenceHarness("claude-code"),
      normalizeEvidenceHarness("not-a-harness"),
      normalizeEvidenceHarness(undefined)
    ]).toEqual([
      "codex",
      "claude-code",
      "github-copilot",
      "cursor",
      "gemini",
      "agents",
      "unknown",
      "claude-code",
      undefined,
      undefined
    ]);
    expect(evidenceHarnessSchema.parse("cursor")).toBe("cursor");
    expect(evidenceHarnessSchema.parse("gemini")).toBe("gemini");
    expect(() => evidenceHarnessSchema.parse("not-a-harness")).toThrow();
  });

  it("validates delivery attribution", () => {
    expect(evidenceDeliverySchema.options).toEqual(["cli", "dashboard", "hook"]);
  });

  it("accepts bounded policies and rejects unsafe retention", () => {
    expect(evidencePolicySchema.parse({
      schemaVersion: 1,
      mode: "minimal",
      retentionDays: 30,
      maxEvents: 5_000
    }).mode).toBe("minimal");
    expect(() => evidencePolicySchema.parse({
      schemaVersion: 1,
      mode: "learning",
      retentionDays: 366,
      maxEvents: 5_000
    })).toThrow();
    expect(() => evidencePolicySchema.parse({
      schemaVersion: 1,
      mode: "minimal",
      retentionDays: 30,
      maxEvents: 99
    })).toThrow();
  });

  it("accepts only primitive candidate feature snapshots", () => {
    const feature = {
      candidateId: "review",
      availability: "installed",
      taskCoverage: 0.75,
      skillPrecision: 0.5,
      nameMatch: true,
      projectScopeFit: false,
      capabilityCoverage: 0.5,
      capabilityPrecision: 0.75,
      triggerConfidence: "exact",
      relevance: 0.8,
      uniqueCoverage: 0.4,
      riskPenalty: 0,
      redundancyPenalty: 0.1,
      installPenalty: 0,
      contextTokens: 240,
      decision: "use"
    };
    expect(candidateFeatureSnapshotSchema.parse(feature).decision).toBe("use");
    expect(() => candidateFeatureSnapshotSchema.parse({
      ...feature,
      matchedTerm: "private-term"
    })).toThrow();
    expect(() => candidateFeatureSnapshotSchema.parse({
      ...feature,
      capabilityDetails: ["review:private-code"]
    })).toThrow();
  });

  it("rejects raw identifiers and content-shaped lifecycle fields", () => {
    expect(evidenceEventSchema.parse({
      schemaVersion: 1,
      id: "event-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      kind: "preflight-delivered",
      harness: "codex",
      preflightId: "run-1",
      algorithmVersion: 2,
      sessionKey: pseudonym("a")
    }).kind).toBe("preflight-delivered");
    expect(() => evidenceEventSchema.parse({
      schemaVersion: 1,
      id: "event-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      kind: "preflight-delivered",
      harness: "codex",
      preflightId: "run-1",
      algorithmVersion: 2,
      sessionKey: "session-raw",
      prompt: "private task"
    })).toThrow();
    expect(evidenceEventSchema.parse({
      schemaVersion: 1,
      id: "event-copilot",
      createdAt: "2026-07-03T00:00:00.000Z",
      kind: "prompt-observed",
      harness: "github-copilot",
      sessionKey: pseudonym("c")
    }).kind).toBe("prompt-observed");
  });

  it("validates privacy-reduced preflights and datasets", () => {
    const preflight = evidencePreflightSchema.parse({
      schemaVersion: 3,
      id: "run-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: hash("a"),
      taskHash: hash("b"),
      taskCharacterCount: 24,
      taskTermCount: 4,
      algorithmVersion: 2,
      harness: "codex",
      delivery: "cli",
      candidateIds: ["review"],
      useCandidateIds: ["review"],
      installCandidateIds: [],
      candidateFeatures: []
    });
    expect(evidenceDatasetSchema.parse({
      schemaVersion: 1,
      preflights: [preflight],
      events: [],
      installations: []
    }).preflights).toHaveLength(1);
    expect(preflight.delivery).toBe("cli");
    const { delivery: _delivery, ...legacyPreflight } = preflight;
    expect(evidencePreflightSchema.parse(legacyPreflight)).not.toHaveProperty("delivery");
    expect(() => evidencePreflightSchema.parse({
      ...preflight,
      task: "private task"
    })).toThrow();
  });

  it("represents nullable metrics with explicit denominators", () => {
    const summary = evidenceSummarySchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      period: { from: null, to: null },
      totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 },
      metrics: zeroMetrics,
      lifecycleReasons: {},
      harnesses: [],
      algorithms: [],
      windows: {
        last7Days: { ...zeroBreakdown, key: "7d" },
        last30Days: { ...zeroBreakdown, key: "30d" }
      },
      readiness: {
        status: "insufficient-evidence",
        reasons: ["Need 100 labeled preflights"]
      }
    });
    expect(summary.metrics.usefulRate.value).toBeNull();
    expect(() => evidenceSummarySchema.parse({
      ...summary,
      metrics: {
        ...summary.metrics,
        usefulRate: { numerator: 1, denominator: 0, value: 1 }
      }
    })).toThrow();
  });
});
