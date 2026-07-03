import { describe, expect, it } from "vitest";
import {
  preflightFeedbackSchema,
  preflightRequestSchema,
  preflightResultSchema
} from "../src/domain.js";

describe("preflight domain", () => {
  it("normalizes a valid request and limits maxSkills", () => {
    expect(preflightRequestSchema).toBeDefined();
    expect(
      preflightRequestSchema.parse({ task: "  Review the security tests  " })
    ).toEqual({ task: "Review the security tests", maxSkills: 5 });
    expect(() =>
      preflightRequestSchema.parse({ task: "Review this", maxSkills: 6 })
    ).toThrow();
  });

  it("accepts feedback labels and requires unique selected IDs", () => {
    expect(preflightFeedbackSchema).toBeDefined();
    expect(
      preflightFeedbackSchema.parse({
        label: "incomplete",
        selectedSkillIds: ["review", "testing"]
      }).label
    ).toBe("incomplete");
    expect(() =>
      preflightFeedbackSchema.parse({
        label: "useful",
        selectedSkillIds: ["review", "review"]
      })
    ).toThrow();
  });

  it("requires every candidate to carry a reason", () => {
    expect(preflightResultSchema).toBeDefined();
    const candidate = {
      skillId: "review",
      name: "review",
      description: "Review code",
      scope: "global",
      visibleTo: ["codex"],
      relevance: 0.8,
      uniqueCoverage: 0.4,
      riskPenalty: 0,
      redundancyPenalty: 0,
      contextTokens: 200,
      decision: "selected",
      reasons: []
    };
    expect(() =>
      preflightResultSchema.parse({
        schemaVersion: 1,
        algorithmVersion: 1,
        id: "run-1",
        generatedAt: "2026-07-03T00:00:00.000Z",
        portfolioFingerprint: `sha256:${"a".repeat(64)}`,
        taskHash: `sha256:${"b".repeat(64)}`,
        taskCharacterCount: 25,
        taskTermCount: 4,
        selectedSkillIds: ["review"],
        candidates: [candidate],
        conflicts: [],
        selectedContextTokens: 200,
        plausibleContextTokens: 200,
        estimatedContextSaved: 0
      })
    ).toThrow();
  });
});
