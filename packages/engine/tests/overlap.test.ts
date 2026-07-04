import { describe, expect, it } from "vitest";
import type { HarnessId, SkillRecord, SkillRecordV2 } from "../src/domain.js";
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

function makeVisibleSkill(input: {
  id: string;
  name: string;
  path?: string;
  scope?: "global" | "project";
  harness: HarnessId;
  state: "effective" | "shadowed" | "ambiguous";
  effectiveName?: string;
  sourceId?: string;
  shadowedBy?: string;
  fingerprint?: string;
}): SkillRecordV2 {
  const sourceId = input.sourceId ?? `${input.harness}:${input.id}`;
  return {
    ...makeSkill(
      input.id,
      input.name,
      "Review code changes and find correctness defects",
      input.scope ?? "project"
    ),
    path: input.path ?? `/skills/${input.id}`,
    visibleTo: input.state === "effective" ? [input.harness] : [],
    fingerprint: input.fingerprint ?? `sha256:${"a".repeat(64)}`,
    ownership: "direct",
    sourceIds: [sourceId],
    exposures: [{
      harness: input.harness,
      effectiveName: input.effectiveName ?? input.name,
      state: input.state,
      sourceId,
      ...(input.shadowedBy ? { shadowedBy: input.shadowedBy } : {}),
      reason: input.state === "shadowed" ? "COPILOT_SHADOWED" : "TEST_EXPOSURE"
    }]
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

  it("does not compare skills without an effective or ambiguous Harness domain", () => {
    const findings = analyzeOverlap([
      makeVisibleSkill({ id: "one", name: "review", harness: "codex", state: "effective" }),
      makeVisibleSkill({ id: "two", name: "review", harness: "claude", state: "effective" })
    ]);

    expect(findings.some(({ code }) => code === "DUPLICATE_SKILL_NAME")).toBe(false);
    expect(findings.some(({ code }) => code === "SCOPE_SHADOWING")).toBe(false);
  });

  it("does not describe two effective Codex instances as scope shadowing", () => {
    const findings = analyzeOverlap([
      makeVisibleSkill({
        id: "global",
        name: "review",
        scope: "global",
        harness: "codex",
        state: "effective"
      }),
      makeVisibleSkill({
        id: "project",
        name: "review",
        scope: "project",
        harness: "codex",
        state: "effective"
      })
    ]);

    expect(findings.some(({ code }) => code === "DUPLICATE_SKILL_NAME")).toBe(true);
    expect(findings.some(({ code }) => code === "SCOPE_SHADOWING")).toBe(false);
  });

  it("does not treat Claude plugin or nested qualified names as direct-name duplicates", () => {
    const findings = analyzeOverlap([
      makeVisibleSkill({
        id: "direct",
        name: "review",
        harness: "claude",
        state: "effective",
        effectiveName: "review"
      }),
      makeVisibleSkill({
        id: "plugin",
        name: "review",
        harness: "claude",
        state: "effective",
        effectiveName: "quality:review"
      }),
      makeVisibleSkill({
        id: "nested",
        name: "review",
        harness: "claude",
        state: "effective",
        effectiveName: "pkg:review"
      })
    ]);

    expect(findings.some(({ code }) => code === "DUPLICATE_SKILL_NAME")).toBe(false);
    expect(findings.some(({ code }) => code === "SCOPE_SHADOWING")).toBe(false);
  });

  it("detects v2 name collisions by exact Harness effective name", () => {
    const findings = analyzeOverlap([
      makeVisibleSkill({
        id: "one",
        name: "review-source-one",
        harness: "claude",
        state: "ambiguous",
        effectiveName: "review"
      }),
      makeVisibleSkill({
        id: "two",
        name: "review-source-two",
        harness: "claude",
        state: "ambiguous",
        effectiveName: "review"
      })
    ]);
    const duplicate = findings.find(({ code }) => code === "DUPLICATE_SKILL_NAME");

    expect(duplicate).toMatchObject({ skillIds: ["one", "two"] });
    expect(duplicate?.evidence).toEqual([
      "harness=claude",
      "effectiveName=review"
    ]);
    expect(duplicate?.evidence.join("\n")).not.toContain("/skills/");
    expect(findings.some(({ code }) => code === "SCOPE_SHADOWING")).toBe(false);
  });

  it("emits stable resolver shadow findings with the actual winner", () => {
    const findings = analyzeOverlap([
      makeVisibleSkill({
        id: "winner",
        name: "review",
        harness: "github-copilot",
        state: "effective"
      }),
      makeVisibleSkill({
        id: "loser",
        name: "review",
        harness: "github-copilot",
        state: "shadowed",
        shadowedBy: "winner"
      })
    ]);
    const shadow = findings.find(({ code }) => code === "HARNESS_SKILL_SHADOWED");

    expect(shadow).toMatchObject({ skillIds: ["winner", "loser"] });
    expect(shadow?.evidence).toContain("winner=winner");
  });

  it("reports duplicate content only for distinct physical paths", () => {
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const distinct = analyzeOverlap([
      makeVisibleSkill({
        id: "one",
        name: "one",
        path: "/skills/one",
        harness: "codex",
        state: "effective",
        fingerprint
      }),
      makeVisibleSkill({
        id: "two",
        name: "two",
        path: "/skills/two",
        harness: "claude",
        state: "effective",
        fingerprint
      })
    ]);
    const alias = analyzeOverlap([
      makeVisibleSkill({
        id: "alias-one",
        name: "one",
        path: "/skills/shared",
        harness: "codex",
        state: "effective",
        fingerprint
      }),
      makeVisibleSkill({
        id: "alias-two",
        name: "two",
        path: "/skills/shared",
        harness: "claude",
        state: "effective",
        fingerprint
      })
    ]);

    expect(distinct.filter(({ code }) => code === "DUPLICATE_SKILL_CONTENT")).toHaveLength(1);
    expect(alias.some(({ code }) => code === "DUPLICATE_SKILL_CONTENT")).toBe(false);
  });
});
