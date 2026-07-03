import { describe, expect, it } from "vitest";
import {
  preflightFeedbackSchema,
  preflightRequestSchema,
  preflightResultSchema
} from "../src/domain.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function result(candidate: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    algorithmVersion: 2,
    id: "run-1",
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    taskHash: hash("b"),
    taskCharacterCount: 25,
    taskTermCount: 4,
    useCandidateIds: ["review"],
    installCandidateIds: [],
    candidates: [candidate],
    conflicts: [],
    capabilityGaps: [],
    installedCoverage: 0.5,
    projectedCoverage: 0.5,
    selectedContextTokens: 200,
    plausibleContextTokens: 200,
    estimatedContextSaved: 0
  };
}

describe("preflight v2 domain", () => {
  it("normalizes discovery options and validates Harness IDs", () => {
    expect(preflightRequestSchema.parse({
      task: "  Review the security tests  ",
      harness: "codex"
    })).toEqual({
      task: "Review the security tests",
      maxSkills: 5,
      harness: "codex",
      includeAvailable: true
    });
    expect(() => preflightRequestSchema.parse({
      task: "Review the security tests",
      harness: "not-a-harness"
    })).toThrow();
  });

  it("accepts feedback labels and requires unique candidate IDs", () => {
    expect(preflightFeedbackSchema.parse({
      label: "incomplete",
      candidateIds: ["review", "testing"]
    }).label).toBe("incomplete");
    expect(() => preflightFeedbackSchema.parse({
      label: "useful",
      candidateIds: ["review", "review"]
    })).toThrow();
  });

  it("requires installed identity for use decisions and a reason", () => {
    const candidate = {
      candidateId: "review",
      availability: "installed",
      installedSkillId: "review",
      name: "review",
      description: "Review code",
      scope: "global",
      compatibleHarnesses: ["codex"],
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.8,
      uniqueCoverage: 0.4,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0,
      contextTokens: 200,
      decision: "use",
      reasons: [{ code: "UNIQUE_COVERAGE", detail: "Covers review" }]
    };
    expect(preflightResultSchema.parse(result(candidate)).schemaVersion).toBe(2);
    expect(() => preflightResultSchema.parse(result({
      ...candidate,
      installedSkillId: undefined,
      reasons: []
    }))).toThrow();
  });

  it("requires available identity and source for install decisions", () => {
    const candidate = {
      candidateId: "catalog:testing",
      availability: "available",
      catalogSkillId: "catalog:testing",
      name: "testing",
      description: "Find missing tests",
      scope: "unknown",
      compatibleHarnesses: [],
      compatibility: "unknown",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.8,
      uniqueCoverage: 0.4,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0.08,
      contextTokens: 200,
      decision: "install",
      source: {
        sourceId: "openai-plugins",
        trust: "vendor",
        url: "https://github.com/openai/plugins.git",
        revision: "a".repeat(40),
        relativePath: "testing"
      },
      reasons: [{ code: "UNIQUE_COVERAGE", detail: "Covers testing" }]
    };
    const input = {
      ...result({ ...candidate, decision: "excluded" }),
      useCandidateIds: [],
      installCandidateIds: [candidate.candidateId],
      candidates: [candidate]
    };
    expect(preflightResultSchema.parse(input).installCandidateIds).toEqual([
      "catalog:testing"
    ]);
    expect(() => preflightResultSchema.parse({
      ...input,
      candidates: [{ ...candidate, source: undefined }]
    })).toThrow();
  });
});
