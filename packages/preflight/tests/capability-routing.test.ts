import type { PortfolioReportV2, SkillRecordV2 } from "@skill-steward/engine";
import { describe, expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function skill(
  id: string,
  description: string,
  estimatedTokens: number
): SkillRecordV2 {
  const sourceId = `codex:test:${id}`;
  return {
    id,
    name: id,
    description,
    path: `/fixture/${id}`,
    root: id,
    scope: "global",
    visibleTo: ["codex"],
    fingerprint: hash(id.length % 2 === 0 ? "b" : "c"),
    files: [],
    estimatedTokens,
    ownership: "direct",
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex",
      effectiveName: id,
      state: "effective",
      sourceId,
      reason: "TEST_EFFECTIVE"
    }]
  };
}

const skills = [
  skill(
    "writing-plans",
    "Plan specifications and requirements before implementing code.",
    700
  ),
  skill(
    "test-driven-development",
    "Implement features and test code before changes.",
    1_100
  ),
  skill(
    "requesting-code-review",
    "Review code before publishing or merging changes.",
    600
  ),
  skill(
    "release-publisher",
    "Publish releases to GitHub after verification.",
    450
  ),
  skill(
    "review-alternative",
    "Review code before publishing or merging changes.",
    900
  ),
  skill(
    "generic-skill-context",
    "Skills, code, agents, documents, and reviews are background context.",
    200
  ),
  skill(
    "pdf-renderer",
    "Render and inspect PDF documents.",
    500
  )
];

function report(): PortfolioReportV2 {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-06T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    workspace: { path: "/fixture", identity: hash("d") },
    skills,
    findings: [],
    inventory: {
      sources: skills.map((entry) => ({
        id: entry.sourceIds[0]!,
        harness: "codex" as const,
        scope: "global" as const,
        kind: "direct-root" as const,
        path: `/fixture/${entry.id}`,
        status: "scanned" as const,
        skillCount: 1,
        effectiveSkillCount: 1
      })),
      harnesses: [{
        harness: "codex",
        status: "verified",
        sourceIds: skills.map((entry) => entry.sourceIds[0]!),
        skillCount: skills.length,
        effectiveSkillCount: skills.length
      }]
    }
  };
}

const input = {
  id: "phase-8-routing",
  now: new Date("2026-07-06T01:00:00.000Z"),
  report: report(),
  catalogSkills: [],
  catalogSources: [],
  harness: "codex" as const,
  maxSkills: 4
};

describe("capability-aware routing", () => {
  it("selects the smallest complementary workflow set for a long task", () => {
    const result = analyzePreflight({
      ...input,
      task: "Plan the product specification and requirements, implement the feature, test the CLI, review the code, and publish the GitHub release."
    });

    expect(result.schemaVersion).toBe(5);
    expect(result.algorithmVersion).toBe(9);
    expect([...result.useCandidateIds].sort()).toEqual([
      "test-driven-development",
      "release-publisher",
      "writing-plans",
      "requesting-code-review"
    ].sort());
    expect(result.selectedContextTokens).toBe(2_850);
    for (const id of result.useCandidateIds) {
      const candidate = result.candidates.find(({ candidateId }) => candidateId === id)!;
      expect(candidate.features.capabilityCoverage).toBeGreaterThan(0);
      expect(candidate.features.triggerConfidence).not.toBe("none");
      expect(candidate.reasons).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MARGINAL_CAPABILITY" })
      ]));
      for (const reason of candidate.reasons.filter(({ code }) =>
        code === "CAPABILITY_MATCH" || code === "MARGINAL_CAPABILITY"
      )) {
        const labels = reason.detail.split(", ");
        expect(new Set(labels).size).toBe(labels.length);
      }
    }
    expect(result.candidates.find(({ candidateId }) =>
      candidateId === "review-alternative"
    )?.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REDUNDANT_CAPABILITY" })
    ]));
    expect(result.useCandidateIds).not.toContain("generic-skill-context");
    expect(result.useCandidateIds).not.toContain("pdf-renderer");
  });

  it("keeps equivalent Chinese workflow intent decision-compatible", () => {
    const result = analyzePreflight({
      ...input,
      task: "规划产品规范与需求，实现功能并测试 CLI，审查代码，然后发布 GitHub 版本。"
    });

    expect([...result.useCandidateIds].sort()).toEqual([
      "test-driven-development",
      "release-publisher",
      "writing-plans",
      "requesting-code-review"
    ].sort());
  });

  it("does not force generic or unrelated candidates", () => {
    const result = analyzePreflight({
      ...input,
      task: "Skills, code, agents, documents, and reviews are project background context."
    });

    expect(
      result.useCandidateIds,
      JSON.stringify(result.candidates.find(({ candidateId }) =>
        candidateId === "generic-skill-context"
      ))
    ).toEqual([]);
  });

  it("keeps explicitly rejected capabilities out of selection", () => {
    const result = analyzePreflight({
      ...input,
      task: "Do not publish a release or deploy anything; instead plan requirements, implement the feature, and test the CLI."
    });

    expect(result.useCandidateIds).not.toContain("release-publisher");
    expect(result.useCandidateIds).toEqual(expect.arrayContaining([
      "writing-plans",
      "test-driven-development"
    ]));
  });
});
