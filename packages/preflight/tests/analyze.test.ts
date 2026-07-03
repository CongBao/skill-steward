import type {
  Finding,
  PortfolioReport,
  SkillRecord,
  SkillScope
} from "@skill-steward/engine";
import { describe, expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function skill(
  id: string,
  name: string,
  description: string,
  estimatedTokens: number,
  scope: SkillScope = "global"
): SkillRecord {
  return {
    id,
    name,
    description,
    path: `/skills/${id}`,
    root: id,
    scope,
    visibleTo: ["codex"],
    fingerprint: hash("b"),
    files: [],
    estimatedTokens
  };
}

function finding(
  id: string,
  skillIds: string[],
  severity: Finding["severity"],
  code = "PORTFOLIO_RISK"
): Finding {
  return {
    id,
    code,
    severity,
    skillIds,
    summary: "Risk affects this Skill",
    evidence: ["fixture"],
    recommendation: "Review the risk",
    confidence: 1
  };
}

function report(
  skills: SkillRecord[],
  findings: Finding[] = []
): PortfolioReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    skills,
    findings
  };
}

const fixed = {
  id: "run-1",
  now: new Date("2026-07-03T01:00:00.000Z")
};

describe("analyzePreflight", () => {
  it("selects a minimal complementary set and explains exclusions", () => {
    expect(analyzePreflight).toBeDefined();
    const result = analyzePreflight({
      ...fixed,
      task: "Review this TypeScript change for security regressions and missing tests",
      report: report([
        skill(
          "security-review",
          "security-review",
          "Review code changes for security vulnerabilities and regressions",
          500,
          "project"
        ),
        skill(
          "test-review",
          "test-review",
          "Review code changes for missing tests and test quality",
          300
        ),
        skill(
          "resume-review",
          "resume-review",
          "Improve resumes and job applications",
          900
        )
      ]),
      maxSkills: 3
    });

    expect(result.selectedSkillIds).toEqual([
      "security-review",
      "test-review"
    ]);
    expect(
      result.candidates.find(({ skillId }) => skillId === "resume-review")
    ).toMatchObject({
      decision: "excluded",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "LOW_RELEVANCE" })
      ])
    });
    expect(result.estimatedContextSaved).toBe(
      result.plausibleContextTokens - result.selectedContextTokens
    );
    expect(result.candidates.every(({ reasons }) => reasons.length > 0)).toBe(
      true
    );
  });

  it("matches complementary Skills for a Chinese task", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "检查代码安全问题和测试遗漏",
      report: report([
        skill("security", "安全检查", "检查代码安全问题和漏洞", 400),
        skill("testing", "测试审查", "发现缺失测试和测试遗漏", 350),
        skill("resume", "简历优化", "优化求职简历内容", 600)
      ])
    });

    expect(result.selectedSkillIds).toEqual(["security", "testing"]);
  });

  it("keeps task relevance separate from risk and prefers the safer Skill", () => {
    const skills = [
      skill("safe", "security-review", "Review security vulnerabilities", 300),
      skill("risky", "security-review", "Review security vulnerabilities", 200)
    ];
    const result = analyzePreflight({
      ...fixed,
      task: "Review security vulnerabilities",
      report: report(skills, [finding("risk-1", ["risky"], "error")]),
      maxSkills: 1
    });

    expect(result.selectedSkillIds).toEqual(["safe"]);
    const safe = result.candidates.find(({ skillId }) => skillId === "safe");
    const risky = result.candidates.find(({ skillId }) => skillId === "risky");
    expect(risky?.relevance).toBe(safe?.relevance);
    expect(risky?.riskPenalty).toBe(0.2);
  });

  it("excludes redundant candidates once covered terms reach the target", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review code security vulnerabilities",
      report: report([
        skill("a", "security-review", "Review code security vulnerabilities", 300),
        skill("b", "security-audit", "Review code security vulnerabilities", 280)
      ]),
      maxSkills: 5
    });

    expect(result.selectedSkillIds).toHaveLength(1);
    expect(
      result.candidates.find(({ decision }) => decision === "excluded")
        ?.reasons
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "REDUNDANT_WITH_SELECTED" })
      ])
    );
  });

  it("treats an exact normalized Skill name as plausible", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Run resume-analyzer for this candidate",
      report: report([
        skill("resume", "resume-analyzer", "Evaluate a curriculum vitae", 250)
      ])
    });

    expect(result.selectedSkillIds).toEqual(["resume"]);
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NAME_MATCH" })
      ])
    );
  });

  it("returns a valid empty result for an empty portfolio", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review this source change",
      report: report([])
    });

    expect(result.selectedSkillIds).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.estimatedContextSaved).toBe(0);
  });

  it("uses stable Skill IDs to break exact ties", () => {
    const input = {
      ...fixed,
      task: "Review code changes",
      report: report([
        skill("z-skill", "review-z", "Review code changes", 200),
        skill("a-skill", "review-a", "Review code changes", 200)
      ]),
      maxSkills: 1
    };

    expect(analyzePreflight(input).selectedSkillIds).toEqual(["a-skill"]);
    expect(analyzePreflight(input)).toEqual(analyzePreflight(input));
  });
});
