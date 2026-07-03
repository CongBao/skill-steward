import type { CatalogSkillRecord, CatalogSource } from "@skill-steward/catalog";
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
  scope: SkillScope = "global",
  fingerprint = hash("b")
): SkillRecord {
  return {
    id,
    name,
    description,
    path: `/skills/${id}`,
    root: id,
    scope,
    visibleTo: ["codex"],
    fingerprint,
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

function report(skills: SkillRecord[], findings: Finding[] = []): PortfolioReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    skills,
    findings
  };
}

const catalogSource: CatalogSource = {
  id: "fixture-catalog",
  name: "Fixture catalog",
  kind: "git",
  url: "https://example.com/skills.git",
  enabled: true,
  trust: "user",
  preset: false
};

function catalogSkill(
  id: string,
  name: string,
  description: string,
  options: {
    fingerprint?: string;
    findings?: Finding[];
    compatibleHarnesses?: CatalogSkillRecord["compatibleHarnesses"];
    estimatedTokens?: number;
  } = {}
): CatalogSkillRecord {
  return {
    id,
    sourceId: catalogSource.id,
    sourceRevision: "a".repeat(40),
    relativePath: id,
    name,
    description,
    fingerprint: options.fingerprint ?? hash("c"),
    estimatedTokens: options.estimatedTokens ?? 220,
    scripts: [],
    executables: [],
    findings: options.findings ?? [],
    compatibleHarnesses: options.compatibleHarnesses ?? [],
    compatibility: options.compatibleHarnesses?.length ? "declared" : "unknown"
  };
}

const fixed = {
  id: "run-1",
  now: new Date("2026-07-03T01:00:00.000Z"),
  catalogSkills: [] as CatalogSkillRecord[],
  catalogSources: [catalogSource]
};

describe("analyzePreflight v3", () => {
  it("selects a minimal installed set and explains exclusions", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review this TypeScript change for security regressions and missing tests",
      report: report([
        skill("security-review", "security-review", "Review code changes for security vulnerabilities and regressions", 500, "project"),
        skill("test-review", "test-review", "Review code changes for missing tests and test quality", 300),
        skill("resume-review", "resume-review", "Improve resumes and job applications", 900)
      ]),
      maxSkills: 3
    });

    expect(result.useCandidateIds).toEqual(["security-review", "test-review"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "resume-review"))
      .toMatchObject({ decision: "excluded" });
    expect(result.candidates.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  it("prefers installed Skills and recommends only complementary available Skills", () => {
    const critical = finding("critical", ["critical-available"], "critical");
    const result = analyzePreflight({
      ...fixed,
      task: "Review security vulnerabilities and find missing tests",
      report: report([
        skill("security-installed", "security-installed", "Review security vulnerabilities", 300)
      ]),
      catalogSkills: [
        catalogSkill("security-available", "security-available", "Review security vulnerabilities"),
        catalogSkill("testing-available", "testing-available", "Find missing tests"),
        catalogSkill("critical-available", "critical-available", "Find missing tests", {
          fingerprint: hash("d"),
          findings: [critical]
        })
      ],
      harness: "codex"
    });

    expect(result.schemaVersion).toBe(3);
    expect(result.algorithmVersion).toBe(3);
    expect(result.candidates[0]?.features).toEqual(expect.objectContaining({
      taskCoverage: expect.any(Number),
      skillPrecision: expect.any(Number),
      nameMatch: expect.any(Boolean),
      projectScopeFit: expect.any(Boolean)
    }));
    expect(JSON.stringify(result.candidates[0]?.features)).not.toContain("security");
    expect(result.candidates.find(({ name }) => name === "security-installed"))
      .toMatchObject({ availability: "installed", decision: "use" });
    expect(result.candidates.find(({ name }) => name === "security-available"))
      .toMatchObject({ decision: "excluded" });
    expect(result.candidates.find(({ name }) => name === "testing-available"))
      .toMatchObject({ availability: "available", decision: "install" });
    expect(result.candidates.find(({ name }) => name === "critical-available"))
      .toMatchObject({ decision: "excluded", highestSeverity: "critical" });
    expect(result.projectedCoverage).toBeGreaterThanOrEqual(result.installedCoverage);
  });

  it("matches complementary installed Skills for a Chinese task", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "检查代码安全问题和测试遗漏",
      report: report([
        skill("security", "安全检查", "检查代码安全问题和漏洞", 400),
        skill("testing", "测试审查", "发现缺失测试和测试遗漏", 350),
        skill("resume", "简历优化", "优化求职简历内容", 600)
      ])
    });
    expect(result.useCandidateIds).toEqual(["security", "testing"]);
  });

  it("keeps relevance separate from risk and prefers the safer installed Skill", () => {
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
    expect(result.useCandidateIds).toEqual(["safe"]);
    const safe = result.candidates.find(({ candidateId }) => candidateId === "safe");
    const risky = result.candidates.find(({ candidateId }) => candidateId === "risky");
    expect(risky?.relevance).toBe(safe?.relevance);
    expect(risky?.riskPenalty).toBe(0.2);
  });

  it("drops exact installed fingerprints and excludes incompatible available candidates", () => {
    const installed = skill("installed", "security", "Review security code", 200, "global", hash("e"));
    const result = analyzePreflight({
      ...fixed,
      task: "Review security code and missing tests",
      report: report([installed]),
      catalogSkills: [
        catalogSkill("same-content", "same-content", "Review security code", { fingerprint: hash("e") }),
        catalogSkill("claude-testing", "claude-testing", "Find missing tests", {
          fingerprint: hash("f"),
          compatibleHarnesses: ["claude"]
        })
      ],
      harness: "codex"
    });
    expect(result.candidates.some(({ candidateId }) => candidateId === "same-content")).toBe(false);
    expect(result.candidates.find(({ candidateId }) => candidateId === "claude-testing"))
      .toMatchObject({ decision: "excluded" });
  });

  it("returns gaps for uncovered task terms and supports installed-only mode", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review cryptography migration tests",
      report: report([]),
      catalogSkills: [catalogSkill("testing", "testing", "Review tests")],
      includeAvailable: false
    });
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(expect.arrayContaining(["cryptography", "migration"]));
  });

  it("presents readable Chinese capability gaps instead of tokenizer fragments", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "制作文件并润色布局",
      report: report([])
    });

    expect(result.capabilityGaps).toEqual(expect.arrayContaining(["制作", "文件", "润色", "布局"]));
    expect(result.capabilityGaps.every((term) => [...term].length >= 2)).toBe(true);
  });

  it("returns a valid empty-candidate result", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review this source change",
      report: report([])
    });
    expect(result.useCandidateIds).toEqual([]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.estimatedContextSaved).toBe(0);
  });

  it("uses stable candidate IDs to break exact ties", () => {
    const input = {
      ...fixed,
      task: "Review code changes",
      report: report([
        skill("z-skill", "review-z", "Review code changes", 200),
        skill("a-skill", "review-a", "Review code changes", 200)
      ]),
      maxSkills: 1
    };
    expect(analyzePreflight(input).useCandidateIds).toEqual(["a-skill"]);
    expect(analyzePreflight(input)).toEqual(analyzePreflight(input));
  });

  it("prefers exact PDF intent and honors an explicit negative routing clause", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Create and edit a PDF document with a polished layout",
      report: report([]),
      catalogSkills: [
        catalogSkill("pdf", "pdf", "Create, edit, merge, and inspect PDF files"),
        catalogSkill(
          "docx",
          "docx",
          "Create polished documents. Do NOT use this skill for PDFs or spreadsheets."
        )
      ],
      harness: "codex"
    });

    expect(result.installCandidateIds).toEqual(["pdf"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "docx"))
      .toMatchObject({
        decision: "excluded",
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
        ])
      });
  });

  it("does not select a project Skill from one generic task term", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review security regressions in this change",
      report: report([
        skill("sync", "openspec-sync", "Sync change specifications", 300, "project")
      ])
    });

    expect(result.useCandidateIds).toEqual([]);
  });

  it("does not treat one generic negative-clause term as a hard exclusion", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review code for security regressions",
      report: report([
        skill(
          "security",
          "security-review",
          "Review code for security regressions. Do not use for code generation.",
          300
        )
      ])
    });

    expect(result.useCandidateIds).toEqual(["security"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it("does not treat a shared positive context term as a negative target", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review frontend accessibility",
      report: report([
        skill(
          "accessibility",
          "accessibility-review",
          "Review frontend accessibility. Do not use for frontend implementation.",
          300
        )
      ])
    });

    expect(result.useCandidateIds).toEqual(["accessibility"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it("does not match a Skill name inside a larger task word", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Preview deployment output",
      report: report([
        skill("review", "review", "Review source changes", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      features: { nameMatch: false }
    });
  });
});
