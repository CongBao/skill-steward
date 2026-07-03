import { describe, expect, it } from "vitest";
import type { SkillRecord } from "../src/domain.js";
import { analyzeOverlap } from "../src/overlap.js";

function makeSkill(
  id: string,
  name: string,
  description: string,
  scope: "global" | "project"
): SkillRecord {
  return {
    id,
    name,
    description,
    path: `/skills/${id}`,
    root: name,
    scope,
    visibleTo: ["agents"],
    fingerprint: `sha256:${"a".repeat(64)}`,
    files: [],
    estimatedTokens: 100
  };
}

describe("analyzeOverlap", () => {
  it("reports duplicate names and scope shadowing", () => {
    const findings = analyzeOverlap([
      makeSkill("one", "debug-code", "Debug code failures", "global"),
      makeSkill("two", "debug-code", "Debug code failures", "project")
    ]);

    expect(findings.some((finding) => finding.code === "DUPLICATE_SKILL_NAME")).toBe(true);
    expect(findings.some((finding) => finding.code === "SCOPE_SHADOWING")).toBe(true);
  });

  it("reports high description overlap but ignores unrelated skills", () => {
    const findings = analyzeOverlap([
      makeSkill("one", "debug-code", "Systematically debug failing tests and find root causes", "global"),
      makeSkill("two", "root-cause", "Find root causes by systematically debugging test failures", "global"),
      makeSkill("three", "slides", "Create presentation slides from documents", "global")
    ]);
    const overlaps = findings.filter((finding) => finding.code === "HIGH_DESCRIPTION_OVERLAP");

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.skillIds.sort()).toEqual(["one", "two"]);
  });
});
