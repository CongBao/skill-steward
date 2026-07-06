import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import {
  PREFLIGHT_ALGORITHM_VERSION,
  algorithmVersionForIntlRuntime,
  preflightFeedbackSchema,
  preflightRequestSchema,
  preflightResultSchema
} from "../src/domain.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function result(candidate: Record<string, unknown>) {
  return {
    schemaVersion: 5,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
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
    inventoryWarnings: [],
    capabilityGaps: [],
    installedCoverage: 0.5,
    projectedCoverage: 0.5,
    selectedContextTokens: 200,
    plausibleContextTokens: 200,
    estimatedContextSaved: 0
  };
}

describe("preflight v5 domain", () => {
  it("keeps ordered phrase and polarity internals out of the public package API", () => {
    expect(publicApi).not.toHaveProperty("tokenizeSequence");
    expect(publicApi).not.toHaveProperty("positiveTaskText");
    expect(publicApi).not.toHaveProperty("negativeTaskClauses");
    expect(publicApi).not.toHaveProperty("positiveRoutingText");
    expect(publicApi).not.toHaveProperty("negativeRoutingClauses");
    expect(publicApi).not.toHaveProperty("extractCapabilities");
    expect(publicApi).toHaveProperty("tokenize");
    expect(publicApi).toHaveProperty("normalizeTask");
  });

  it("separates ranking evidence when the Intl word-boundary runtime changes", () => {
    expect(algorithmVersionForIntlRuntime({
      cldr: "48.0",
      icu: "78.2",
      unicode: "17.0"
    })).toBe(9);
    const alternate = algorithmVersionForIntlRuntime({
      cldr: "47.0",
      icu: "76.1",
      unicode: "16.0"
    });
    expect(alternate).toBeGreaterThan(9_000_000_000_000);
    expect(algorithmVersionForIntlRuntime({
      cldr: "47.0",
      icu: "76.1",
      unicode: "16.0"
    })).toBe(alternate);
    expect(algorithmVersionForIntlRuntime({
      cldr: "46.0",
      icu: "75.1",
      unicode: "15.1"
    })).not.toBe(alternate);
  });

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

  it("keeps full results strict while accepting legacy candidate IDs for membership-checked feedback", () => {
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
      features: {
        taskCoverage: 0.75,
        skillPrecision: 0.5,
        nameMatch: true,
        projectScopeFit: false,
        capabilityCoverage: 0,
        capabilityPrecision: 0,
        triggerConfidence: "none"
      },
      decision: "use",
      reasons: [{ code: "UNIQUE_COVERAGE", detail: "Covers review" }]
    };
    const valid = result(candidate);

    for (const invalidId of ["unsafe id", "x".repeat(97)]) {
      expect(() => preflightResultSchema.parse({ ...valid, id: invalidId })).toThrow();
      expect(() => preflightResultSchema.parse({
        ...valid,
        useCandidateIds: [invalidId],
        candidates: [{
          ...candidate,
          candidateId: invalidId,
          installedSkillId: invalidId
        }]
      })).toThrow();
      expect(preflightFeedbackSchema.parse({
        label: "useful",
        candidateIds: [invalidId]
      }).candidateIds).toEqual([invalidId]);
    }

    expect(preflightResultSchema.parse({
      ...valid,
      id: `P${"a".repeat(95)}`,
      useCandidateIds: [`C${"b".repeat(95)}`],
      candidates: [{
        ...candidate,
        candidateId: `C${"b".repeat(95)}`,
        installedSkillId: `C${"b".repeat(95)}`
      }]
    })).toBeDefined();
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
      features: {
        taskCoverage: 0.75,
        skillPrecision: 0.5,
        nameMatch: true,
        projectScopeFit: false,
        capabilityCoverage: 0,
        capabilityPrecision: 0,
        triggerConfidence: "none"
      },
      decision: "use",
      reasons: [{ code: "UNIQUE_COVERAGE", detail: "Covers review" }]
    };
    expect(preflightResultSchema.parse(result(candidate)).schemaVersion).toBe(5);
    expect(() => preflightResultSchema.parse(result({
      ...candidate,
      installedSkillId: undefined,
      reasons: []
    }))).toThrow();
  });

  it("bounds visibility explanations and inventory warnings", () => {
    const candidate = {
      candidateId: "shadowed",
      availability: "installed",
      installedSkillId: "shadowed",
      name: "shadowed",
      description: "Review code",
      scope: "global",
      compatibleHarnesses: [],
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.8,
      uniqueCoverage: 0,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0,
      contextTokens: 200,
      features: {
        taskCoverage: 0.75,
        skillPrecision: 0.5,
        nameMatch: true,
        projectScopeFit: false,
        capabilityCoverage: 0,
        capabilityPrecision: 0,
        triggerConfidence: "none"
      },
      decision: "excluded",
      reasons: [{
        code: "HARNESS_SHADOWED",
        detail: "Shadowed by installed candidate 'effective'."
      }]
    };
    const parsed = preflightResultSchema.parse({
      ...result(candidate),
      useCandidateIds: [],
      inventoryWarnings: [{
        code: "HARNESS_AMBIGUOUS",
        harness: "codex",
        detail: "Visibility is ambiguous for every matching installed candidate."
      }]
    });

    expect(parsed.inventoryWarnings).toHaveLength(1);
    expect(() => preflightResultSchema.parse({
      ...parsed,
      inventoryWarnings: Array.from({ length: 4 }, () => parsed.inventoryWarnings[0])
    })).toThrow();
    expect(() => preflightResultSchema.parse({
      ...parsed,
      candidates: [{
        ...candidate,
        reasons: [{ code: "HARNESS_INACTIVE", detail: "x".repeat(201) }]
      }]
    })).toThrow();
    expect(() => preflightResultSchema.parse({
      ...parsed,
      inventoryWarnings: [{
        ...parsed.inventoryWarnings[0],
        detail: "Ambiguous source at /private/native/cache"
      }]
    })).toThrow();
    expect(() => preflightResultSchema.parse({
      ...parsed,
      candidates: [{
        ...candidate,
        reasons: Array.from({ length: 13 }, () => candidate.reasons[0])
      }]
    })).toThrow();
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
      features: {
        taskCoverage: 0.5,
        skillPrecision: 0.5,
        nameMatch: false,
        projectScopeFit: false,
        capabilityCoverage: 0,
        capabilityPrecision: 0,
        triggerConfidence: "none"
      },
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
