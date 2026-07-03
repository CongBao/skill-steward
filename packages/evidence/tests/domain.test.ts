import { describe, expect, it } from "vitest";
import {
  candidateFeatureSnapshotSchema,
  evidenceDatasetSchema,
  evidenceEventSchema,
  evidencePolicySchema,
  evidencePreflightSchema,
  evidenceSummarySchema
} from "../src/index.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const pseudonym = (character: string) => `hmac-sha256:${character.repeat(64)}`;

describe("evidence domain", () => {
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
  });

  it("validates privacy-reduced preflights and datasets", () => {
    const preflight = evidencePreflightSchema.parse({
      schemaVersion: 1,
      id: "run-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: hash("a"),
      taskHash: hash("b"),
      taskCharacterCount: 24,
      taskTermCount: 4,
      algorithmVersion: 2,
      harness: "codex",
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
      metrics: {
        usefulRate: { numerator: 0, denominator: 0, value: null },
        correctionPrecision: { numerator: 0, denominator: 0, value: null },
        correctionRecall: { numerator: 0, denominator: 0, value: null },
        correctionF1: { numerator: 0, denominator: 0, value: null },
        installConversion: { numerator: 0, denominator: 0, value: null }
      },
      lifecycleReasons: {},
      harnesses: [],
      algorithms: [],
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
