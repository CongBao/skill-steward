import { describe, expect, it } from "vitest";
import {
  aggregateEvidence,
  type EvidenceDataset,
  type EvidenceFeedback,
  type EvidencePreflight
} from "../src/index.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function feedback(
  preflightId: string,
  label: EvidenceFeedback["label"],
  candidateIds: string[] = []
): EvidenceFeedback {
  return {
    schemaVersion: 1,
    preflightId,
    recordedAt: "2026-07-03T00:30:00.000Z",
    label,
    candidateIds
  };
}

function preflight(
  id: string,
  options: {
    label?: EvidenceFeedback["label"];
    corrected?: string[];
    use?: string[];
    install?: string[];
    portfolio?: string;
    harness?: EvidencePreflight["harness"];
    algorithm?: number;
    createdAt?: string;
  } = {}
): EvidencePreflight {
  const use = options.use ?? ["a", "b"];
  const install = options.install ?? [];
  const candidateIds = [...new Set([...use, ...install, ...(options.corrected ?? [])])];
  return {
    schemaVersion: 3,
    id,
    createdAt: options.createdAt ?? "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: options.portfolio ?? hash("a"),
    taskHash: hash("b"),
    taskCharacterCount: 20,
    taskTermCount: 3,
    algorithmVersion: options.algorithm ?? 2,
    harness: options.harness ?? "codex",
    candidateIds,
    useCandidateIds: use,
    installCandidateIds: install,
    ...(options.label ? {
      feedback: feedback(id, options.label, options.corrected ?? [])
    } : {})
  };
}

function emptyDataset(): EvidenceDataset {
  return { schemaVersion: 1, preflights: [], events: [], installations: [] };
}

describe("aggregateEvidence", () => {
  it("uses null for every empty denominator and reports all readiness gaps", () => {
    const summary = aggregateEvidence(emptyDataset(), new Date("2026-07-03T00:00:00.000Z"));
    expect(summary.metrics.feedbackRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(summary.metrics.usefulRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(summary.readiness).toEqual({
      status: "insufficient-evidence",
      reasons: [
        "Need 100 labeled preflights",
        "Need 30 corrected candidate sets",
        "Need 20 portfolio fingerprints"
      ]
    });
    expect(summary.windows.last7Days.totals.preflights).toBe(0);
  });

  it("calculates label rates, corrected-set metrics, and explicit install conversion", () => {
    const dataset: EvidenceDataset = {
      schemaVersion: 1,
      preflights: [
        preflight("useful", { label: "useful" }),
        preflight("incomplete", {
          label: "incomplete",
          corrected: ["b", "c"],
          use: ["a", "b"],
          install: ["install-me"]
        }),
        preflight("incorrect", { label: "incorrect", use: ["d"] }),
        preflight("unlabeled", { use: ["e"] })
      ],
      events: [{
        schemaVersion: 1,
        id: "delivery",
        createdAt: "2026-07-03T00:10:00.000Z",
        kind: "preflight-delivered",
        harness: "codex",
        preflightId: "incomplete",
        algorithmVersion: 2
      }],
      installations: [{
        schemaVersion: 1,
        id: "install-1",
        createdAt: "2026-07-03T00:20:00.000Z",
        preflightId: "incomplete",
        candidateId: "install-me"
      }]
    };
    const summary = aggregateEvidence(dataset, new Date("2026-07-03T01:00:00.000Z"));
    expect(summary.metrics.feedbackRate.value).toBe(0.75);
    expect(summary.metrics.usefulRate.value).toBeCloseTo(1 / 3);
    expect(summary.metrics.incompleteRate.value).toBeCloseTo(1 / 3);
    expect(summary.metrics.incorrectRate.value).toBeCloseTo(1 / 3);
    expect(summary.metrics.correctionPrecision.value).toBe(0.5);
    expect(summary.metrics.correctionRecall.value).toBe(0.5);
    expect(summary.metrics.correctionF1.value).toBe(0.5);
    expect(summary.metrics.installConversion.value).toBe(1);
  });

  it("keeps lifecycle reasons distinct from labels and groups Harnesses and algorithms", () => {
    const dataset: EvidenceDataset = {
      schemaVersion: 1,
      preflights: [
        preflight("codex", { label: "useful", harness: "codex", algorithm: 2 }),
        preflight("claude", { label: "incorrect", harness: "claude-code", algorithm: 3 })
      ],
      events: [
        {
          schemaVersion: 1,
          id: "turn-1",
          createdAt: "2026-07-03T00:10:00.000Z",
          kind: "turn-finished",
          harness: "codex",
          preflightId: "codex",
          reason: "complete"
        },
        {
          schemaVersion: 1,
          id: "turn-2",
          createdAt: "2026-07-03T00:20:00.000Z",
          kind: "turn-finished",
          harness: "claude-code",
          preflightId: "claude",
          reason: "error"
        }
      ],
      installations: []
    };
    const summary = aggregateEvidence(dataset, new Date("2026-07-03T01:00:00.000Z"));
    expect(summary.lifecycleReasons).toEqual({ complete: 1, error: 1 });
    expect(summary.harnesses.map(({ key }) => key)).toEqual(["claude-code", "codex"]);
    expect(summary.algorithms.map(({ key }) => key)).toEqual(["2", "3"]);
    expect(JSON.stringify(summary)).not.toContain("successRate");
  });

  it("becomes calibration-ready only after every sample gate is reached", () => {
    const preflights = Array.from({ length: 100 }, (_, index) => preflight(`run-${index}`, {
      label: index < 30 ? "incomplete" : "useful",
      corrected: index < 30 ? ["a", "b"] : [],
      portfolio: `sha256:${(index % 20).toString(16).padStart(2, "0").repeat(32)}`
    }));
    const summary = aggregateEvidence({
      schemaVersion: 1,
      preflights,
      events: [],
      installations: []
    }, new Date("2026-07-03T01:00:00.000Z"));
    expect(summary.readiness).toEqual({ status: "ready-for-calibration", reasons: [] });
  });
});
