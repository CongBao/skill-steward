import type { CatalogSkillRecord, CatalogSource } from "@skill-steward/catalog";
import type {
  Finding,
  PortfolioReport,
  PortfolioReportV2,
  SkillRecordV2,
  SkillScope
} from "@skill-steward/engine";
import { portfolioReportV2Schema, sha256 } from "@skill-steward/engine";
import { describe, expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";
import { normalizePreflightCandidates } from "../src/candidates.js";
import { PREFLIGHT_ALGORITHM_VERSION } from "../src/domain.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function skill(
  id: string,
  name: string,
  description: string,
  estimatedTokens: number,
  scope: SkillScope = "global",
  fingerprint = hash("b")
): SkillRecordV2 {
  const sourceId = `codex:test:${id}`;
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
    estimatedTokens,
    ownership: "direct",
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex",
      effectiveName: name,
      state: "effective",
      sourceId,
      reason: "TEST_EFFECTIVE"
    }]
  };
}

function withExposure(
  value: SkillRecordV2,
  state: "effective" | "shadowed" | "inactive" | "ambiguous",
  options: { shadowedBy?: string; reason?: string } = {}
): SkillRecordV2 {
  const exposure = value.exposures[0]!;
  return {
    ...value,
    visibleTo: state === "effective" ? ["codex"] : [],
    exposures: [{
      ...exposure,
      state,
      reason: options.reason ?? `TEST_${state.toUpperCase()}`,
      ...(options.shadowedBy ? { shadowedBy: options.shadowedBy } : {})
    }]
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

function report(skills: SkillRecordV2[], findings: Finding[] = []): PortfolioReportV2 {
  const sources = skills.map((skill) => {
    const exposure = skill.exposures[0]!;
    const status = exposure.reason === "SOURCE_STALE"
      ? "stale" as const
      : exposure.state === "inactive"
        ? "disabled" as const
        : "scanned" as const;
    return {
      id: exposure.sourceId,
      harness: exposure.harness,
      scope: skill.scope,
      kind: "direct-root" as const,
      path: `/roots/${skill.id}`,
      status,
      skillCount: 1,
      effectiveSkillCount: exposure.state === "effective" ? 1 : 0
    };
  });
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    workspace: { path: "/workspace", identity: hash("f") },
    skills,
    findings,
    inventory: {
      sources,
      harnesses: [{
        harness: "codex",
        status: "verified",
        sourceIds: sources.map(({ id }) => id),
        skillCount: skills.length,
        effectiveSkillCount: skills.filter(({ exposures }) =>
          exposures.some(({ state }) => state === "effective")
        ).length
      }]
    }
  };
}

function legacyReport(): PortfolioReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    skills: [],
    findings: []
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

const PHASE_2_REVIEW_TASK = "Review Phase 2 lifecycle-record v1/v2 compatibility, legacy Alpha dual-proof adoption, filesystem race safety, and public API privacy before merge.";

function sessionRequirementsSkill(): SkillRecordV2 {
  return skill(
    "maintaining-session-requirements",
    "maintaining-session-requirements",
    "Use when a multi-turn task has evolving requirements or clarifications, a shared requirements ledger exists, work resumes after context compaction, or Codex and Copilot must preserve user intent across a long development session.",
    500
  );
}

describe("analyzePreflight schema v4 / algorithm v8", () => {
  it("requires a visibility-aware inventory before ranking", () => {
    try {
      analyzePreflight({
        ...fixed,
        task: "Review security changes",
        report: legacyReport()
      });
      throw new Error("expected visibility error");
    } catch (error) {
      expect(error).toMatchObject({
        name: "PreflightError",
        code: "INVENTORY_RESCAN_REQUIRED",
        message: "INVENTORY_RESCAN_REQUIRED"
      });
    }
  });

  it("uses only effective Harness instances and explains every visibility exclusion", () => {
    const winner = skill(
      "effective-review",
      "security-review",
      "Review security changes",
      200
    );
    const shadowed = withExposure(skill(
      "shadowed-review",
      "security-review",
      "Review security changes",
      180
    ), "shadowed", { shadowedBy: winner.id });
    const inactive = withExposure(skill(
      "inactive-review",
      "security-review",
      "Review security changes",
      180
    ), "inactive");
    const stale = withExposure(skill(
      "stale-review",
      "security-review",
      "Review security changes",
      180
    ), "inactive", { reason: "SOURCE_STALE" });
    const ambiguous = withExposure(skill(
      "ambiguous-review",
      "security-review",
      "Review security changes",
      180
    ), "ambiguous", { reason: "COPILOT_PRECEDENCE_AMBIGUOUS" });

    const input = {
      ...fixed,
      task: "Review security changes",
      report: report([winner, shadowed, inactive, stale, ambiguous]),
      harness: "codex" as const,
      maxSkills: 5
    };
    const normalized = normalizePreflightCandidates(input);
    const normalizedById = new Map(normalized.map((candidate) => [candidate.candidateId, candidate]));

    expect(normalizedById.get(winner.id)).toMatchObject({
      harnessVisibility: "effective",
      harnessCompatible: true,
      harnessEligible: true
    });
    for (const [id, state] of [
      [shadowed.id, "shadowed"],
      [inactive.id, "inactive"],
      [stale.id, "inactive"],
      [ambiguous.id, "ambiguous"]
    ] as const) {
      expect(normalizedById.get(id)).toMatchObject({
        harnessVisibility: state,
        harnessCompatible: false,
        harnessEligible: false
      });
    }

    const result = analyzePreflight(input);

    expect(result.useCandidateIds).toEqual([winner.id]);
    expect(result.candidates.find(({ candidateId }) => candidateId === shadowed.id))
      .toMatchObject({
        decision: "excluded",
        reasons: expect.arrayContaining([expect.objectContaining({
          code: "HARNESS_SHADOWED",
          detail: expect.stringContaining(winner.id)
        })])
      });
    for (const id of [inactive.id, stale.id]) {
      expect(result.candidates.find(({ candidateId }) => candidateId === id)?.reasons)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "HARNESS_INACTIVE" })
        ]));
    }
    expect(result.candidates.find(({ candidateId }) => candidateId === ambiguous.id)?.reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
      ]));
    for (const id of [shadowed.id, inactive.id, stale.id, ambiguous.id]) {
      const primaryExclusions = result.candidates
        .find(({ candidateId }) => candidateId === id)?.reasons
        .filter(({ code }) => [
          "HARNESS_SHADOWED",
          "HARNESS_INACTIVE",
          "HARNESS_AMBIGUOUS",
          "HARNESS_INCOMPATIBLE",
          "REDUNDANT_WITH_SELECTED",
          "LOW_RELEVANCE"
        ].includes(code));
      expect(primaryExclusions).toHaveLength(1);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/roots/");
    expect(serialized).not.toContain("COPILOT_PRECEDENCE_AMBIGUOUS");
  });

  it("keeps available catalog compatibility independent from installed visibility", () => {
    const declared = catalogSkill(
      "declared-codex",
      "security-review",
      "Review security changes",
      { compatibleHarnesses: ["codex"] }
    );
    const incompatible = catalogSkill(
      "declared-claude",
      "security-review",
      "Review security changes",
      { fingerprint: hash("4"), compatibleHarnesses: ["claude"] }
    );
    const portable = {
      ...catalogSkill(
        "portable",
        "security-review",
        "Review security changes",
        { fingerprint: hash("5") }
      ),
      compatibility: "portable" as const
    };
    const normalized = normalizePreflightCandidates({
      ...fixed,
      task: "Review security changes",
      report: report([]),
      catalogSkills: [declared, incompatible, portable],
      harness: "codex"
    });
    const byId = new Map(normalized.map((candidate) => [candidate.candidateId, candidate]));

    expect(byId.get(declared.id)).toMatchObject({
      availability: "available",
      harnessCompatible: true,
      harnessEligible: true
    });
    expect(byId.get(incompatible.id)).toMatchObject({
      availability: "available",
      harnessCompatible: false,
      harnessEligible: false
    });
    expect(byId.get(portable.id)).toMatchObject({
      availability: "available",
      compatibility: "portable",
      harnessCompatible: true,
      harnessEligible: true
    });
  });

  it("fails closed when a shadow winner cannot be verified", () => {
    const missing = withExposure(skill(
      "shadow-missing",
      "security-review",
      "Review security changes",
      100
    ), "shadowed", { shadowedBy: "missing-winner" });
    const missingResult = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([missing]),
      harness: "codex"
    });
    expect(missingResult.inventoryWarnings).toEqual([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS", harness: "codex" })
    ]);

    const nonEffectiveTarget = withExposure(skill(
      "non-effective-target",
      "security-review",
      "Review security changes",
      100
    ), "inactive");
    const scenarios = [
      {
        candidate: withExposure(skill(
          "shadow-non-effective",
          "security-review",
          "Review security changes",
          100
        ), "shadowed", { shadowedBy: nonEffectiveTarget.id }),
        extra: [nonEffectiveTarget],
        forbidden: nonEffectiveTarget.id
      },
      {
        candidate: withExposure(skill(
          "shadow-self",
          "security-review",
          "Review security changes",
          100
        ), "shadowed", { shadowedBy: "shadow-self" }),
        extra: [],
        forbidden: "shadow-self"
      },
      {
        candidate: withExposure(skill(
          "shadow-unsafe",
          "security-review",
          "Review security changes",
          100
        ), "shadowed", { shadowedBy: "/private/native/cache/winner" }),
        extra: [],
        forbidden: "/private/native/cache/winner"
      }
    ];

    for (const { candidate, extra, forbidden } of scenarios) {
      const result = analyzePreflight({
        ...fixed,
        task: "Review security changes",
        report: report([candidate, ...extra]),
        harness: "codex"
      });
      const reasons = result.candidates.find(
        ({ candidateId }) => candidateId === candidate.id
      )?.reasons ?? [];
      expect(reasons).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
      ]));
      expect(reasons.some(({ code }) =>
        code === "HARNESS_SHADOWED" || code === "HARNESS_INCOMPATIBLE"
      )).toBe(false);
      expect(JSON.stringify(reasons)).not.toContain(forbidden);
    }

    const duplicateWinner = skill(
      "duplicate-winner",
      "security-review",
      "Review security changes",
      100
    );
    const duplicateWinnerAlias = {
      ...skill(
        "duplicate-winner-alias",
        "security-review",
        "Review security changes",
        100
      ),
      id: duplicateWinner.id
    };
    const duplicateShadow = withExposure(skill(
      "shadow-duplicate",
      "security-review",
      "Review security changes",
      100
    ), "shadowed", { shadowedBy: duplicateWinner.id });
    const duplicateNormalized = normalizePreflightCandidates({
      ...fixed,
      task: "Review security changes",
      report: report([duplicateShadow, duplicateWinner, duplicateWinnerAlias]),
      harness: "codex"
    }).find(({ candidateId }) => candidateId === duplicateShadow.id);
    expect(duplicateNormalized).toMatchObject({
      harnessVisibility: "ambiguous",
      harnessCompatible: false,
      harnessEligible: false
    });
    expect(duplicateNormalized).not.toHaveProperty("shadowedByCandidateId");
  });

  it("fails closed for an existing effective winner with an unsafe raw ID", () => {
    const unsafeRawId = "/private/native/cache/winner";
    const unsafeWinner = {
      ...skill(
        "unsafe-winner-record",
        "release-winner",
        "Manage release deployments",
        100
      ),
      id: unsafeRawId
    };
    const loser = withExposure(skill(
      "unsafe-shadow-loser",
      "security-review",
      "Review security changes",
      100
    ), "shadowed", { shadowedBy: unsafeRawId });
    const unsafeReport = report([unsafeWinner, loser]);
    expect(portfolioReportV2Schema.safeParse(unsafeReport).success).toBe(true);

    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: unsafeReport,
      harness: "codex"
    });
    const loserResult = result.candidates.find(
      ({ candidateId }) => candidateId === loser.id
    );

    expect(loserResult?.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
    ]));
    expect(loserResult?.reasons.some(({ code }) => code === "HARNESS_SHADOWED"))
      .toBe(false);
    expect(result.inventoryWarnings).toEqual([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS", harness: "codex" })
    ]);
    expect(result.candidates.map(({ candidateId }) => candidateId)
      .every((candidateId) => /^[a-z0-9][a-z0-9._:@+-]{0,95}$/iu.test(candidateId)))
      .toBe(true);
    expect(JSON.stringify(result)).not.toContain(unsafeRawId);
  });

  it("fails closed when a claimed shadow winner has an unrelated effective name", () => {
    const winner = skill(
      "unrelated-effective-winner",
      "totally-unrelated",
      "Manage unrelated work",
      100
    );
    const loser = withExposure(skill(
      "mismatched-shadow-loser",
      "security-review",
      "Review security changes",
      100
    ), "shadowed", { shadowedBy: winner.id });
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([winner, loser]),
      harness: "codex"
    });
    const loserResult = result.candidates.find(
      ({ candidateId }) => candidateId === loser.id
    );

    expect(loserResult?.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
    ]));
    expect(loserResult?.reasons.some(({ code }) => code === "HARNESS_SHADOWED"))
      .toBe(false);
    expect(result.inventoryWarnings).toEqual([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS", harness: "codex" })
    ]);
    expect(JSON.stringify(result.inventoryWarnings)).not.toMatch(/\/skills\/|\/private\//u);
  });

  it("verifies every shadowed exposure against the same winner effective name", () => {
    const winner = skill(
      "multi-effective-winner",
      "security-review",
      "Review security and deployment changes",
      100
    );
    winner.exposures.push({
      ...winner.exposures[0]!,
      effectiveName: "deployment-review"
    });
    const loser = withExposure(skill(
      "multi-shadow-loser",
      "security-review",
      "Review security and deployment changes",
      100
    ), "shadowed", { shadowedBy: winner.id });
    loser.exposures.push({
      ...loser.exposures[0]!,
      effectiveName: "deployment-review"
    });

    const matching = analyzePreflight({
      ...fixed,
      task: "Review security and deployment changes",
      report: report([winner, loser]),
      harness: "codex"
    });
    expect(matching.candidates.find(({ candidateId }) => candidateId === loser.id)?.reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_SHADOWED" })
      ]));

    winner.exposures[1] = {
      ...winner.exposures[1]!,
      effectiveName: "totally-unrelated"
    };
    const mismatching = analyzePreflight({
      ...fixed,
      task: "Review security and deployment changes",
      report: report([winner, loser]),
      harness: "codex"
    });
    expect(mismatching.candidates.find(({ candidateId }) => candidateId === loser.id)?.reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
      ]));
  });

  it("normalizes duplicate raw installed IDs uniquely without losing records", () => {
    const duplicateRawId = "duplicate-winner";
    const firstWinner = {
      ...skill(
        "duplicate-winner-record-a",
        "winner-alpha",
        "Review security changes",
        100,
        "global",
        hash("6")
      ),
      id: duplicateRawId
    };
    const secondWinner = {
      ...skill(
        "duplicate-winner-record-b",
        "winner-beta",
        "Review security changes",
        110,
        "global",
        hash("7")
      ),
      id: duplicateRawId
    };
    const loser = withExposure(skill(
      "duplicate-shadow-loser",
      "security-review",
      "Review security changes",
      120,
      "global",
      hash("8")
    ), "shadowed", { shadowedBy: duplicateRawId });
    const duplicateFinding = finding(
      "duplicate-risk",
      [duplicateRawId],
      "error"
    );
    const duplicateReport = report(
      [firstWinner, secondWinner, loser],
      [duplicateFinding]
    );
    const persistedValidation = portfolioReportV2Schema.safeParse(duplicateReport);
    expect(persistedValidation.success).toBe(false);
    if (!persistedValidation.success) {
      expect(persistedValidation.error.issues.map(({ message }) => message))
        .toEqual(expect.arrayContaining([
          "DUPLICATE_SKILL_ID",
          "AMBIGUOUS_EXPOSURE_SHADOW_TARGET"
        ]));
    }

    const input = {
      ...fixed,
      task: "Review security changes",
      report: duplicateReport,
      harness: "codex" as const
    };
    const result = analyzePreflight(input);
    const candidateIds = result.candidates.map(({ candidateId }) => candidateId);
    const normalizedWinners = result.candidates.filter(({ name }) =>
      name === firstWinner.name || name === secondWinner.name
    );

    expect(result.candidates).toHaveLength(3);
    expect(new Set(candidateIds).size).toBe(candidateIds.length);
    expect(candidateIds).not.toContain(duplicateRawId);
    expect(normalizedWinners).toHaveLength(2);
    expect(normalizedWinners.every(({ highestSeverity }) => highestSeverity === "error"))
      .toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.skillIds.sort()).toEqual(
      normalizedWinners.map(({ candidateId }) => candidateId).sort()
    );
    expect(JSON.stringify(result.conflicts)).not.toContain(duplicateRawId);
    expect(result.candidates.find(({ name }) => name === loser.name)?.reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
      ]));

    const reordered = analyzePreflight({
      ...input,
      report: report([loser, secondWinner, firstWinner], [duplicateFinding])
    });
    expect(new Map(result.candidates.map(({ name, candidateId }) => [name, candidateId])))
      .toEqual(new Map(reordered.candidates.map(({ name, candidateId }) => [name, candidateId])));
  });

  it("sanitizes every conflict reference with a stable bounded one-to-many replacement", () => {
    const rawId = "/private/native/cache/unsafe-id";
    const first = {
      ...skill(
        "unsafe-conflict-record-a",
        "security-review-alpha",
        "Review security changes",
        100,
        "global",
        hash("1")
      ),
      id: rawId
    };
    const second = {
      ...skill(
        "unsafe-conflict-record-b",
        "security-review-beta",
        "Review security changes",
        110,
        "global",
        hash("2")
      ),
      id: rawId
    };
    const unrelated = "Leave /private/native/cache/unrelated-id unchanged";
    const unsafeFinding: Finding = {
      id: "unsafe-reference-risk",
      code: "PORTFOLIO_RISK",
      severity: "warning",
      skillIds: [rawId],
      summary: `Affected ${rawId} exactly`,
      evidence: [rawId, `prefix ${rawId} suffix`, unrelated],
      recommendation: `Review ${rawId} before use`,
      confidence: 1
    };
    const input = {
      ...fixed,
      task: "Review security changes",
      report: report([first, second], [unsafeFinding]),
      harness: "codex" as const
    };
    const result = analyzePreflight(input);
    const conflict = result.conflicts[0]!;
    const replacement = conflict.evidence[0]!;
    const normalizedIds = result.candidates
      .filter(({ name }) => name === first.name || name === second.name)
      .map(({ candidateId }) => candidateId)
      .sort();

    expect([...conflict.skillIds].sort()).toEqual(normalizedIds);
    expect(replacement).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(replacement.length).toBeLessThanOrEqual(96);
    expect(conflict.summary).toBe(`Affected ${replacement} exactly`);
    expect(conflict.evidence).toEqual([
      replacement,
      `prefix ${replacement} suffix`,
      unrelated
    ]);
    expect(conflict.recommendation).toBe(`Review ${replacement} before use`);
    expect(conflict.summary.length).toBeGreaterThan(0);
    expect(conflict.recommendation.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(rawId);

    const reordered = analyzePreflight({
      ...input,
      report: report([second, first], [unsafeFinding])
    });
    expect(reordered.conflicts[0]?.evidence[0]).toBe(replacement);
  });

  it("allocates finding replacements outside every raw and normalized ID namespace", () => {
    const groupARawId = "/private/native/cache/collision-group-a";
    const groupA = [
      {
        ...skill(
          "collision-a-record-1",
          "security-review-a1",
          "Review security changes",
          100,
          "global",
          hash("3")
        ),
        id: groupARawId
      },
      {
        ...skill(
          "collision-a-record-2",
          "security-review-a2",
          "Review security changes",
          101,
          "global",
          hash("4")
        ),
        id: groupARawId
      }
    ];
    const preliminary = normalizePreflightCandidates({
      ...fixed,
      task: "Review security changes",
      report: report(groupA),
      harness: "codex"
    });
    const groupARawReplacement = sha256([
      "skill-steward:preflight-finding-reference:v1",
      ...preliminary.map(({ candidateId }) => candidateId).sort()
    ].join("\0"));
    const groupB = [
      {
        ...skill(
          "collision-b-record-1",
          "security-review-b1",
          "Review security changes",
          102,
          "global",
          hash("5")
        ),
        id: groupARawReplacement
      },
      {
        ...skill(
          "collision-b-record-2",
          "security-review-b2",
          "Review security changes",
          103,
          "global",
          hash("6")
        ),
        id: groupARawReplacement
      }
    ];
    const collisionFinding: Finding = {
      id: "finding-reference-collision",
      code: "PORTFOLIO_RISK",
      severity: "warning",
      skillIds: [groupARawId, groupARawReplacement],
      summary: `A ${groupARawId}; B ${groupARawReplacement}`,
      evidence: [groupARawId, groupARawReplacement],
      recommendation: `Review ${groupARawId} and ${groupARawReplacement}`,
      confidence: 1
    };
    const input = {
      ...fixed,
      task: "Review security changes",
      report: report([...groupA, ...groupB], [collisionFinding]),
      harness: "codex" as const
    };
    const result = analyzePreflight(input);
    const conflict = result.conflicts[0]!;
    const replacements = conflict.evidence;
    const candidateIds = result.candidates.map(({ candidateId }) => candidateId);

    expect(replacements).toHaveLength(2);
    expect(new Set(replacements).size).toBe(2);
    expect(replacements.every((replacement) =>
      /^sha256:[a-f0-9]{64}$/u.test(replacement)
    )).toBe(true);
    expect(replacements.every((replacement) => !candidateIds.includes(replacement)))
      .toBe(true);
    expect(conflict.skillIds.some((candidateId) => replacements.includes(candidateId)))
      .toBe(false);
    expect(JSON.stringify(result)).not.toContain(groupARawId);
    expect(JSON.stringify(result)).not.toContain(groupARawReplacement);

    const reorderedFinding = {
      ...collisionFinding,
      skillIds: [...collisionFinding.skillIds].reverse()
    };
    const reordered = analyzePreflight({
      ...input,
      report: report([...groupB].reverse().concat([...groupA].reverse()), [reorderedFinding])
    });
    expect(reordered.conflicts[0]).toEqual(conflict);
    expect(JSON.stringify(reordered)).not.toContain(groupARawId);
    expect(JSON.stringify(reordered)).not.toContain(groupARawReplacement);
  });

  it("reserves only catalog candidate IDs that reach the presented candidate set", () => {
    const rawId = "/private/native/cache/available-collision";
    const installed = [
      {
        ...skill(
          "available-collision-record-1",
          "security-review-one",
          "Review security changes",
          100,
          "global",
          hash("7")
        ),
        id: rawId
      },
      {
        ...skill(
          "available-collision-record-2",
          "security-review-two",
          "Review security changes",
          101,
          "global",
          hash("8")
        ),
        id: rawId
      }
    ];
    const preliminary = normalizePreflightCandidates({
      ...fixed,
      task: "Review security changes and missing tests",
      report: report(installed),
      harness: "codex"
    });
    const baseReplacement = sha256([
      "skill-steward:preflight-finding-reference:v1",
      ...preliminary.map(({ candidateId }) => candidateId).sort()
    ].join("\0"));
    const collisionCatalog = catalogSkill(
      baseReplacement,
      "testing-review",
      "Find missing tests",
      { fingerprint: hash("9"), compatibleHarnesses: ["codex"] }
    );
    const otherCatalog = catalogSkill(
      "catalog-observability",
      "observability-review",
      "Review observability changes",
      { fingerprint: hash("0"), compatibleHarnesses: ["codex"] }
    );
    const unsafeFinding: Finding = {
      id: "available-candidate-reference-collision",
      code: "PORTFOLIO_RISK",
      severity: "warning",
      skillIds: [rawId],
      summary: `Affected ${rawId}`,
      evidence: [rawId],
      recommendation: `Review ${rawId}`,
      confidence: 1
    };
    const input = {
      ...fixed,
      task: "Review security changes and missing tests",
      report: report(installed, [unsafeFinding]),
      catalogSkills: [collisionCatalog, otherCatalog],
      harness: "codex" as const
    };
    const result = analyzePreflight(input);
    const replacement = result.conflicts[0]!.evidence[0]!;
    const candidateIds = result.candidates.map(({ candidateId }) => candidateId);

    expect(candidateIds).toContain(baseReplacement);
    expect(replacement).not.toBe(baseReplacement);
    expect(candidateIds).not.toContain(replacement);
    expect(result.conflicts[0]?.skillIds).not.toContain(replacement);
    expect(JSON.stringify(result)).not.toContain(rawId);

    const reordered = analyzePreflight({
      ...input,
      report: report([...installed].reverse(), [unsafeFinding]),
      catalogSkills: [...input.catalogSkills].reverse()
    });
    expect(reordered.conflicts[0]).toEqual(result.conflicts[0]);

    const installedOnly = analyzePreflight({
      ...input,
      includeAvailable: false
    });
    expect(installedOnly.candidates.map(({ candidateId }) => candidateId))
      .not.toContain(baseReplacement);
    expect(installedOnly.conflicts[0]?.evidence[0]).toBe(baseReplacement);

    const filtered = analyzePreflight({
      ...input,
      catalogSkills: [{
        ...collisionCatalog,
        fingerprint: installed[0]!.fingerprint
      }]
    });
    expect(filtered.candidates.map(({ candidateId }) => candidateId))
      .not.toContain(baseReplacement);
    expect(filtered.conflicts[0]?.evidence[0]).toBe(baseReplacement);
  });

  it("warns compactly when every matching installed instance is ambiguous", () => {
    const ambiguous = withExposure(skill(
      "ambiguous-security",
      "security-review",
      "Review security changes",
      180
    ), "ambiguous", { reason: "PRIVATE_PRECEDENCE_DETAIL" });
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([ambiguous]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.inventoryWarnings).toEqual([{
      code: "HARNESS_AMBIGUOUS",
      harness: "codex",
      detail: "Visibility is ambiguous for every matching installed candidate."
    }]);
    expect(JSON.stringify(result.inventoryWarnings)).not.toMatch(/PRIVATE|\/roots\//u);
  });

  it("does not let another Harness's matching Skill hide an ambiguity warning", () => {
    const ambiguous = withExposure(skill(
      "ambiguous-codex",
      "security-review",
      "Review security changes",
      180
    ), "ambiguous");
    const otherHarness = skill(
      "effective-claude",
      "security-review",
      "Review security changes",
      180
    );
    otherHarness.visibleTo = ["claude"];
    otherHarness.exposures = otherHarness.exposures.map((exposure) => ({
      ...exposure,
      harness: "claude"
    }));
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([ambiguous, otherHarness]),
      harness: "codex"
    });

    expect(result.inventoryWarnings).toEqual([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS", harness: "codex" })
    ]);
  });

  it("never copies a path-shaped unverified shadow target into explanations", () => {
    const shadowed = withExposure(skill(
      "shadowed-private",
      "security-review",
      "Review security changes",
      180
    ), "shadowed", { shadowedBy: "/private/native/cache/effective" });
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([shadowed]),
      harness: "codex"
    });
    const reasons = result.candidates[0]?.reasons ?? [];

    expect(reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HARNESS_AMBIGUOUS" })
    ]));
    expect(reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HARNESS_SHADOWED" })
    ]));
    expect(JSON.stringify(reasons)).not.toContain("/private/native/cache");
  });

  it("keeps a catalog candidate available when only an inactive copy is installed", () => {
    const fingerprint = hash("9");
    const inactive = withExposure(skill(
      "inactive-native-security",
      "security-review",
      "Review security changes",
      180,
      "global",
      fingerprint
    ), "inactive");
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([inactive]),
      catalogSkills: [catalogSkill(
        "catalog-security",
        "security-review",
        "Review security changes",
        { fingerprint, compatibleHarnesses: ["codex"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.installCandidateIds).toEqual(["catalog-security"]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateId: inactive.id,
        availability: "installed",
        decision: "excluded"
      }),
      expect.objectContaining({
        candidateId: "catalog-security",
        availability: "available",
        decision: "install"
      })
    ]));
  });

  it("does not duplicate candidate identity when an inactive copy shares a catalog ID", () => {
    const inactive = withExposure(skill(
      "shared-security-id",
      "security-review",
      "Review security changes",
      180,
      "global",
      hash("7")
    ), "inactive");
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([inactive]),
      catalogSkills: [catalogSkill(
        inactive.id,
        "security-review",
        "Review security changes",
        { fingerprint: hash("8"), compatibleHarnesses: ["codex"] }
      )],
      harness: "codex"
    });

    expect(result.candidates.map(({ candidateId }) => candidateId)).toEqual([inactive.id]);
  });

  it("bounds generated explanation details for adversarial metadata", () => {
    const longName = "x".repeat(500);
    const result = analyzePreflight({
      ...fixed,
      task: longName,
      report: report([skill("long-name", longName, "Review security changes", 100)]),
      harness: "codex"
    });

    expect(result.candidates.flatMap(({ reasons }) => reasons)
      .every(({ detail }) => [...detail].length <= 200)).toBe(true);
  });

  it("bounds emoji-heavy explanation details by UTF-16 units without broken surrogates", () => {
    const longName = `${"😀".repeat(150)}-security-review`;
    const result = analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([skill("emoji-name", longName, "Review security changes", 100)]),
      harness: "codex"
    });
    const details = result.candidates.flatMap(({ reasons }) => reasons)
      .map(({ detail }) => detail);

    expect(details.length).toBeGreaterThan(0);
    expect(details.every((detail) => detail.length <= 200)).toBe(true);
    for (const detail of details) {
      for (let index = 0; index < detail.length; index += 1) {
        const unit = detail.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = detail.charCodeAt(index + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
          index += 1;
        } else {
          expect(unit < 0xdc00 || unit > 0xdfff).toBe(true);
        }
      }
    }
  });

  it("does not mutate persisted exposure ordering while normalizing", () => {
    const value = skill("immutable", "security-review", "Review security changes", 100);
    const exposure = value.exposures[0]!;
    value.exposures = [
      { ...exposure, harness: "claude", state: "ambiguous" },
      exposure
    ];
    Object.freeze(value.exposures);

    expect(() => analyzePreflight({
      ...fixed,
      task: "Review security changes",
      report: report([value])
    })).not.toThrow();
  });
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

    expect(result.schemaVersion).toBe(4);
    expect(result.algorithmVersion).toBe(PREFLIGHT_ALGORITHM_VERSION);
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

  it.each([
    "在长对话中持续整理并维护不断变化的需求，避免上下文压缩后丢失意图",
    "在長對話中持續整理並維護不斷變化的需求，避免上下文壓縮後丟失意圖",
    "在长会话中维护不断变化的需求，避免上下文压缩后丢失意图",
    "在長會話中維護不斷變化的需求，避免上下文壓縮後丟失意圖",
    "维护长期会话中持续演进的需求，在上下文压缩后保留用户意图",
    "Maintain evolving requirements across a long session after context compaction and preserve user intent"
  ])("selects the English session-requirements Skill for multilingual intent: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        sessionRequirementsSkill(),
        skill("resume", "resume-analyzer", "Review resumes and job applications", 400),
        skill("pdf", "pdf", "Create, edit, and inspect PDF files", 400)
      ])
    });

    expect(result.useCandidateIds).toContain("maintaining-session-requirements");
    expect(result.candidates.find(
      ({ candidateId }) => candidateId === "maintaining-session-requirements"
    )).toMatchObject({ decision: "use" });
  });

  it.each([
    {
      label: "Chinese dogfood task",
      task: "我们正在进行一个持续数周、需求会不断澄清的长对话开发项目。请在上下文压缩后仍然维护所有需求、竞争力判断、决策和未完成事项，并在实现前检查有没有遗漏。"
    },
    {
      label: "English dogfood task",
      task: "Keep every evolving requirement, product decision, competitive assumption, and unfinished item accurate across a multi-week development session, including after context compaction."
    },
    {
      label: "Chinese healthcare-project variation",
      task: "在跨季度医疗系统迭代中持续维护已确认的需求和业务假设，上下文压缩后继续保留记录。"
    },
    {
      label: "English robotics-program variation",
      task: "Preserve changing requirements and design choices throughout a long robotics program after context compaction."
    }
  ])("keeps diffuse project context out of searchable gaps: $label", ({ task }) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([sessionRequirementsSkill()]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("keeps candidate-corroborated uncovered concepts as actionable search hints", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Maintain evolving requirements across a long development session and safely migrate PostgreSQL schemas with transactional rollback",
      report: report([sessionRequirementsSkill()]),
      catalogSkills: [catalogSkill(
        "postgres-migration",
        "database-helper",
        "Safely migrate PostgreSQL schemas with transactional rollback",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(expect.arrayContaining([
      "migrate",
      "postgresql",
      "schemas"
    ]));
  });

  it("does not let a low-relevance candidate corroborate a shared project token", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Preserve evolving requirements across a long development session for a product project after context compaction",
      report: report([
        sessionRequirementsSkill(),
        skill(
          "resume-project",
          "resume-project",
          "Review resume project portfolios and job applications",
          400
        )
      ]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "resume-project"))
      .toMatchObject({
        decision: "excluded",
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "LOW_RELEVANCE" })
        ])
      });
    expect(result.capabilityGaps).toEqual([]);
  });

  it("does not let an incompatible one-term candidate corroborate a shared project token", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Preserve evolving requirements across a long development session for a product project after context compaction",
      report: report([sessionRequirementsSkill()]),
      catalogSkills: [catalogSkill(
        "resume-project",
        "resume-project",
        "Review resume project portfolios and job applications",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "resume-project"))
      .toMatchObject({
        decision: "excluded",
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "HARNESS_INCOMPATIBLE" })
        ])
      });
    expect(result.capabilityGaps).toEqual([]);
  });

  it("does not let a generic exact candidate name bypass gap evidence strength", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Keep every evolving requirement, product decision, project assumption, and unfinished item accurate across a multi-week development session after context compaction",
      report: report([sessionRequirementsSkill()]),
      catalogSkills: [catalogSkill(
        "resume-project",
        "project",
        "Review resume portfolios and job applications",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("applies the same generic-name gate to an incompatible installed variant", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Keep every evolving requirement, product decision, project assumption, and unfinished item accurate across a multi-week development session after context compaction",
      report: report([
        sessionRequirementsSkill(),
        withExposure(skill(
          "inactive-product",
          "product",
          "Review resume portfolios and job applications",
          300
        ), "inactive")
      ]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("does not count two generic concepts as alternate corroboration evidence", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Keep evolving requirements across a long session after context compaction for a product project and 开发",
      report: report([skill(
        "requirements-session",
        "requirements-session",
        "Maintain evolving requirements across a long session after context compaction",
        300
      )]),
      catalogSkills: [catalogSkill(
        "generic-development",
        "product-project",
        "Product project development guidance",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["requirements-session"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("filters generic alternate evidence for an inactive installed candidate", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Keep evolving requirements across a long session after context compaction for a product project and 开发",
      report: report([
        skill(
          "requirements-session",
          "requirements-session",
          "Maintain evolving requirements across a long session after context compaction",
          300
        ),
        withExposure(skill(
          "inactive-generic-development",
          "product-project",
          "Product project development guidance",
          300
        ), "inactive")
      ]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["requirements-session"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "postgresql",
    "cryptography"
  ])("keeps a specialized exact single-token name as gap evidence: %s", (name) => {
    const result = analyzePreflight({
      ...fixed,
      task: `Maintain evolving requirements across a long session after context compaction and add ${name}`,
      report: report([sessionRequirementsSkill()]),
      catalogSkills: [catalogSkill(
        `${name}-helper`,
        name,
        "Specialized domain guidance",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toContain(name);
  });

  it("keeps a specialized exact multiword name as gap evidence", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Maintain evolving requirements across a long session after context compaction and add quantum cryptography",
      report: report([sessionRequirementsSkill()]),
      catalogSkills: [catalogSkill(
        "quantum-cryptography-helper",
        "quantum-cryptography",
        "Design quantum-safe encryption protocols",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(expect.arrayContaining([
      "quantum",
      "cryptography"
    ]));
  });

  it("does not corroborate a capability that appears only in a negative clause", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Run a security audit and clarification",
      report: report([]),
      catalogSkills: [catalogSkill(
        "security-audit",
        "security-audit",
        "Run a security audit. Do not use this skill for clarification.",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).not.toContain("clarification");
  });

  it("does not let selected negative clauses cover a corroborated gap", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review security incidents and 保持",
      report: report([skill(
        "security-review",
        "security-review",
        "Review security incidents. Do not use this skill for preserve.",
        300
      )]),
      catalogSkills: [catalogSkill(
        "preservation-helper",
        "incident-helper",
        "Preserve security incident evidence",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["security-review"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(["保持"]);
  });

  it("canonicalizes strong positive candidate concepts into task display aliases", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Maintain requirements and 保持 PostgreSQL schemas with transactional rollback",
      report: report([skill(
        "requirements-session",
        "requirements-session",
        "Maintain requirements and session context",
        300
      )]),
      catalogSkills: [catalogSkill(
        "postgres-preservation",
        "database-helper",
        "Preserve PostgreSQL schemas with transactional rollback",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["requirements-session"]);
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(expect.arrayContaining([
      "保持",
      "postgresql",
      "schemas"
    ]));
  });

  it("canonicalizes selected positive coverage without changing scoring terms", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Maintain requirements and 保留 records",
      report: report([skill(
        "requirements-records",
        "requirements-records",
        "Maintain requirements by preserving records",
        300
      )]),
      catalogSkills: [catalogSkill(
        "preservation-helper",
        "preservation-helper",
        "Preserve records safely",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual(["requirements-records"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("keeps gap-only creation aliases recommendation-neutral", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "制作文件并润色布局",
      report: report([skill(
        "file-generation",
        "file-generation",
        "Generate files and file layouts",
        300
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "file-generation"))
      .toMatchObject({ decision: "excluded", relevance: 0 });
    expect(result.capabilityGaps).toEqual(["润色", "布局"]);
  });

  it.each([
    "中和",
    "的和",
    "和中",
    "在中",
    "与中"
  ])("does not turn a low-confidence two-character fragment into routing or a gap: %s", (fragment) => {
    const task = [fragment, fragment, fragment, fragment].join(" ");
    const withoutCandidates = analyzePreflight({
      ...fixed,
      task,
      report: report([])
    });
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill("two-character", fragment, fragment, 200)])
    });

    expect(withoutCandidates.capabilityGaps).toEqual([]);
    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      relevance: 0,
      features: { nameMatch: false }
    });
  });

  it("returns no speculative gaps for a long narrative without candidate evidence", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Coordinate a multi-quarter retail program with changing product choices, market assumptions, stakeholder notes, and unfinished follow-ups after each planning cycle",
      report: report([])
    });

    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "在长对话中维护不断变化的需求并保留意图",
    "在長對話中維護不斷變化的需求並保留意圖"
  ])("does not report a covered long-conversation concept as a gap: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task: `${task}，还要整理记录`,
      report: report([skill(
        "maintaining-session-requirements",
        "maintaining-session-requirements",
        "Maintain evolving requirements, preserve intent, and manage context across a long session",
        500
      )])
    });

    expect(result.useCandidateIds).toEqual(["maintaining-session-requirements"]);
    expect(result.capabilityGaps).toEqual([]);
    for (const coveredDisplayTerm of [
      "长对话",
      "長對話",
      "对话",
      "對話",
      "会话",
      "會話"
    ]) {
      expect(result.capabilityGaps).not.toContain(coveredDisplayTerm);
    }
  });

  it("does not route broad Chinese workflow prose to unrelated domain Skills", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "请帮我处理这个任务并继续完成相关工作，从用户角度评估整体质量",
      report: report([
        skill("resume", "简历分析", "分析用户简历并评估整体质量", 400),
        skill("pdf", "PDF 文档", "创建并编辑 PDF 文件", 400),
        skill("finance", "财务分析", "评估公司财务质量和投资风险", 400)
      ])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).not.toEqual(expect.arrayContaining([
      "请",
      "帮",
      "处理",
      "任务",
      "继续",
      "完成",
      "相关",
      "工作",
      "用户",
      "整体"
    ]));
  });

  it("does not route Chinese tasks through common single-character matches", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "继续推进 Skill Steward 的当前阶段：完成 CLI 和 Dashboard 的真实测试，从用户角度评估产品是否好理解、好用、值得持续使用，修复所有 P0/P1 问题，并重新评估竞争力。",
      report: report([
        skill(
          "product-review",
          "产品体验审查",
          "测试 CLI 和 Dashboard，评估产品易用性、可靠性和竞争力",
          500
        ),
        skill(
          "resume",
          "简历分析",
          "以直接、坦诚、可执行、可视化的方式分析并改进用户简历，评审整体质量",
          600
        )
      ])
    });

    expect(result.taskTermCount).toBeLessThan(30);
    expect(result.useCandidateIds).toEqual(["product-review"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "resume"))
      .toMatchObject({ decision: "excluded", relevance: 0 });
    expect(result.candidates.find(({ candidateId }) => candidateId === "resume")?.reasons)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TASK_TERM_MATCH" })
      ]));
    expect(result.capabilityGaps).not.toEqual(expect.arrayContaining([
      "继续",
      "推进",
      "阶段",
      "完成"
    ]));
    expect(result.candidates.flatMap(({ reasons }) => reasons)
      .filter(({ code }) => code === "TASK_TERM_MATCH")
      .every(({ detail }) => detail.split(", ").every((term) => [...term].length >= 2)))
      .toBe(true);
  });

  it("keeps Skill as a routing term when it combines with specific intent", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Manage my Skills",
      report: report([
        skill("skill-manager", "skill-manager", "Manage installed Agent Skills", 240),
        skill("resume", "resume", "Improve resumes and job applications", 400)
      ])
    });

    expect(result.useCandidateIds).toEqual(["skill-manager"]);
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
      task: "cryptography migration",
      report: report([]),
      includeAvailable: false
    });
    expect(result.installCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual(["cryptography", "migration"]);
  });

  it("deduplicates display variants by canonical concept before bounding gaps", () => {
    const synonyms = analyzePreflight({
      ...fixed,
      task: "preserve preserving preserved keeping preservation 保留 保存 保持",
      report: report([])
    });
    expect(synonyms.capabilityGaps).toEqual(["preserve"]);

    const boundedVerbInflections = analyzePreflight({
      ...fixed,
      task: "plan planning planned development developing developed 开发",
      report: report([])
    });
    expect(boundedVerbInflections.capabilityGaps).toEqual([
      "plan",
      "development"
    ]);

    const inflections = analyzePreflight({
      ...fixed,
      task: "cryptography cryptographies migration migrations deployment deployments",
      report: report([])
    });
    expect(inflections.capabilityGaps).toEqual([
      "cryptography",
      "migration",
      "deployment"
    ]);

    const bounded = analyzePreflight({
      ...fixed,
      task: "cryptography cryptographies migration migrations deployment deployments observability orchestration compliance encryption",
      report: report([]),
      catalogSkills: [catalogSkill(
        "domain-suite",
        "domain-suite",
        "Cryptography migration deployment observability orchestration compliance encryption",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });
    expect(bounded.capabilityGaps).toEqual([
      "cryptography",
      "migration",
      "deployment",
      "observability",
      "orchestration",
      "compliance"
    ]);
  });

  it("presents readable Chinese capability gaps instead of tokenizer fragments", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "制作文件并润色布局",
      report: report([])
    });

    expect(result.capabilityGaps).toEqual(["润色", "布局"]);
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

  it("selects only the corroborated review Skill for the Phase 2 long-task dogfood prompt", () => {
    const candidates = [
      skill(
        "request",
        "requesting-code-review",
        "Use when completing tasks, implementing major features, or before merging to verify work meets requirements",
        729
      ),
      skill(
        "receive",
        "receiving-code-review",
        "Use when receiving code review feedback before implementing suggestions",
        1_628
      ),
      skill(
        "finish",
        "finishing-a-development-branch",
        "Integrate completed work through merge or cleanup",
        1_811
      ),
      skill(
        "api",
        "api-documentation",
        "Document API endpoints after release",
        900
      ),
      skill(
        "phase",
        "phase-checklist",
        "Use before merge to verify deployment readiness",
        600
      ),
      skill(
        "documentation",
        "documentation-review",
        "Use before merging to review documentation changes",
        600
      )
    ];
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report(candidates)
    });
    const reordered = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([...candidates].reverse())
    });

    expect(result.useCandidateIds).toEqual(["request"]);
    expect(result.selectedContextTokens).toBe(729);
    expect(result.candidates.find(({ candidateId }) => candidateId === "request")?.reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "HIGH_CONFIDENCE_TRIGGER" })
      ]));
    expect(result.candidates.filter(({ decision }) => decision === "use"))
      .toHaveLength(1);
    expect(reordered.useCandidateIds).toEqual(result.useCandidateIds);
    expect(reordered.selectedContextTokens).toBe(result.selectedContextTokens);
    expect(reordered.candidates.find(({ candidateId }) => candidateId === "request")?.relevance)
      .toBe(result.candidates.find(({ candidateId }) => candidateId === "request")?.relevance);
  });

  it("retains an independently relevant specialist beside the lifecycle-trigger Skill", () => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([
        skill(
          "request",
          "requesting-code-review",
          "Use before merge to review completed code and verify requirements",
          729
        ),
        skill(
          "api",
          "api-privacy-review",
          "Review API privacy boundaries after release",
          900
        )
      ])
    });

    expect(result.useCandidateIds).toEqual(expect.arrayContaining([
      "api",
      "request"
    ]));
    expect(result.useCandidateIds).toHaveLength(2);
    expect(result.selectedContextTokens).toBe(1_629);
  });

  it("keeps a corroborated available review Skill behind explicit installation approval", () => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([]),
      catalogSkills: [catalogSkill(
        "request-catalog",
        "requesting-code-review",
        "Use when completing tasks or before merging to verify work meets requirements",
        { compatibleHarnesses: ["codex"], estimatedTokens: 729 }
      )],
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.installCandidateIds).toEqual(["request-catalog"]);
    expect(result.candidates[0]).toMatchObject({
      availability: "available",
      decision: "install",
      contextTokens: 729,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "HIGH_CONFIDENCE_TRIGGER" }),
        expect.objectContaining({ code: "INSTALL_REQUIRED" })
      ])
    });
  });

  it.each([
    {
      label: "name evidence without the lifecycle phrase",
      name: "requesting-code-review",
      description: "Use after implementation to verify requirements"
    },
    {
      label: "lifecycle phrase without name evidence",
      name: "release-gate",
      description: "Use before merging to verify work"
    },
    {
      label: "name evidence with a different lifecycle phrase",
      name: "requesting-code-review",
      description: "Use before release to review work"
    },
    {
      label: "matching terms that are not an adjacent phrase",
      name: "requesting-code-review",
      description: "Use before a carefully staged and independently verified merge to review completed engineering work"
    },
    {
      label: "a nearby code-review workflow",
      name: "receiving-code-review",
      description: "Use when receiving code review feedback before implementing suggestions"
    },
    {
      label: "a phrase split across sentence boundaries",
      name: "requesting-code-review",
      description: "Use before. Merge after review is complete"
    },
    {
      label: "a phrase split by a slash",
      name: "requesting-code-review",
      description: "Use before / merge to review completed work"
    },
    {
      label: "a phrase split by an em dash",
      name: "requesting-code-review",
      description: "Use before — merge to review completed work"
    }
  ])("does not promote partial high-confidence evidence: $label", ({ name, description }) => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([skill("partial", name, description, 700)])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ decision: "excluded" });
  });

  it.each([
    "before / merge",
    "before — merge"
  ])("does not join a task trigger across punctuation: %s", (phrase) => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK.replace("before merge", phrase),
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HIGH_CONFIDENCE_TRIGGER" })
    ]));
  });

  it("does not let corroborated trigger evidence bypass critical risk", () => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([
        skill(
          "critical-review",
          "requesting-code-review",
          "Use before merging to review completed work",
          700
        )
      ], [finding("critical-trigger", ["critical-review"], "critical")])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      highestSeverity: "critical"
    });
  });

  it("does not let corroborated trigger evidence bypass Harness visibility", () => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([withExposure(skill(
        "inactive-review",
        "requesting-code-review",
        "Use before merging to review completed work",
        700
      ), "inactive")]),
      harness: "codex"
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "HARNESS_INACTIVE" })
      ])
    });
  });

  it.each([
    "Never use before merge. Use after release to verify completed work.",
    "Avoid using this skill before merge. Use after release instead.",
    "Do not invoke this skill before merge. Invoke it after release instead.",
    "Don't call this skill before merge. Call it after release instead.",
    "Don’t use this skill before merge. Use it after release instead.",
    "Never run this skill before merge. Run it after release instead.",
    "Do not apply this skill before merge. Apply it after release instead.",
    "Do not use this skill for code-review before merge. Use it after release instead.",
    "Do not use this skill for code/review before merge. Use it after release instead.",
    "Do not use this skill for code—review before merge. Use it after release instead.",
    "Do not use this skill for code©review before merge. Use it after release instead.",
    "Do not use this skill for code💡review before merge. Use it after release instead."
  ])("does not let corroborated trigger evidence bypass a negative route: %s", (description) => {
    const result = analyzePreflight({
      ...fixed,
      task: PHASE_2_REVIEW_TASK,
      report: report([skill(
        "negative-review",
        "requesting-code-review",
        description,
        700
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).not.toEqual(expect.arrayContaining([
      "before",
      "merge"
    ]));
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
      ])
    });
  });

  it.each([
    "Do not review before merge. Update the release notes only.",
    "Don't review before merge. Update the release notes only.",
    "Don’t review before merge. Update the release notes only.",
    "Never review before merge. Update the release notes only.",
    "Avoid review before merge. Update the release notes only.",
    "Without review before merge, update the release notes only."
  ])("does not treat explicitly negated task intent as positive: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use when completing tasks or before merging to verify work meets requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.selectedContextTokens).toBe(0);
    expect(result.capabilityGaps).not.toContain("before");
    expect(result.capabilityGaps).not.toContain("merge");
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
      ])
    });
  });

  it("does not match the never negation inside whenever", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Whenever reviewing code before merge, verify API privacy and lifecycle compatibility.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual(["request"]);
    expect(result.capabilityGaps).not.toContain("whe");
    expect(result.candidates[0]).toMatchObject({
      decision: "use",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "HIGH_CONFIDENCE_TRIGGER" })
      ])
    });
  });

  it("preserves positive task intent after a negated semicolon clause", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not review before merge; add PostgreSQL support.",
      report: report([])
    });

    expect(result.capabilityGaps).toEqual(expect.arrayContaining([
      "add",
      "postgresql",
      "support"
    ]));
    expect(result.capabilityGaps).not.toEqual(expect.arrayContaining([
      "before",
      "merge"
    ]));
  });

  it.each([
    "Do not use requesting-code-review before merge.",
    "Do not request code-review before merge.",
    "Do not request code/review before merge.",
    "Do not request code—review before merge.",
    "Do not request code©review before merge.",
    "Do not request code💡review before merge."
  ])("keeps hyphenated Skill intent inside the negated task clause: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("keeps hyphenated words out of gaps when their clause is negated", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not auto-merge this deployment.",
      report: report([])
    });

    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "Do not create PDF, DOCX, or HTML files.",
    "Do not use: PDF, DOCX, or HTML files."
  ])("keeps comma and colon lists inside a negated task clause: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        skill("pdf", "pdf", "Create PDF files", 300),
        skill("docx", "docx", "Create DOCX files", 300),
        skill("html", "html", "Create HTML files", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    {
      task: "Do not use: Run tools.",
      names: ["run"]
    },
    {
      task: "Do not use these tools: Build.",
      names: ["build"]
    },
    {
      task: "Avoid using the following tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Without using these tools: Build.",
      names: ["build"]
    },
    {
      task: "Avoid calling workflows: Test.",
      names: ["test"]
    },
    {
      task: "Avoid using any of the following tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Without calling any of these workflows: Build workflows.",
      names: ["build"]
    },
    {
      task: "Do not use the tools: Test tools.",
      names: ["test"]
    },
    {
      task: "Avoid using any of the tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Do not use all of the locally installed tools: Test tools.",
      names: ["test"]
    },
    {
      task: "Avoid using CI/CD tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Without using team’s tools: Build tools.",
      names: ["build"]
    },
    {
      task: "Avoid using AI🚀 tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Avoid using AI⚙️ tools: Run tools.",
      names: ["run"]
    },
    {
      task: "Avoid using AI👩‍💻 tools: Build tools.",
      names: ["build"]
    },
    {
      task: "Do not use: Run, Test, or Build skills.",
      names: ["run", "test", "build"]
    },
    {
      task: "Do not use: create, edit, or review skills.",
      names: ["create", "edit", "review"]
    },
    {
      task: "Do not use: Run, or Test tools.",
      names: ["run", "test"]
    },
    {
      task: "Do not use: Run, and Test tools.",
      names: ["run", "test"]
    },
    {
      task: "Do not use: Run, and/or Test tools.",
      names: ["run", "test"]
    },
    {
      task: "Do not use: Run/Test/Build skills.",
      names: ["run", "test", "build"]
    },
    {
      task: "Do not use: Run & Test tools.",
      names: ["run", "test"]
    },
    {
      task: "Do not use these tools: Run and Test instead of Build.",
      names: ["run", "test", "build"]
    },
    {
      task: "Do not use: Run and Test tools instead of Build.",
      names: ["run", "test", "build"]
    },
    {
      task: "Do not use these tools: Run instead of Build.",
      names: ["run", "build"]
    },
    {
      task: "Do not use: Run tools instead of Build.",
      names: ["run", "build"]
    },
    {
      task: "Do not use: Run instead of Build tools.",
      names: ["run", "build"]
    },
    {
      task: "Do not use: Run tools, instead of Build tools.",
      names: ["run", "build"]
    }
  ])("keeps action-named colon lists negative: $task", ({ task, names }) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report(names.map((name) => skill(
        name,
        name,
        `${name} skills`,
        300
      )))
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    { task: "Do not use: Run-v2 tools.", name: "run-v2" },
    { task: "Do not use: Run/v2 tools.", name: "run/v2" },
    { task: "Do not use: Run🚀 tools.", name: "run🚀" }
  ])("keeps punctuation-rich action names negative: $task", ({ task, name }) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill(name, name, `${name} tools`, 300)])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("preserves an instead-marked multi-action colon contrast", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not create PDF: build and test DOCX instead.",
      report: report([
        skill("pdf", "pdf", "Create PDF files", 300),
        skill("docx", "docx", "Build and test DOCX files", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["docx"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "Do not create PDF: build/test DOCX instead.",
    "Do not create PDF: create, edit DOCX instead.",
    "Do not create PDF: create, edit, and test DOCX instead.",
    "Do not create PDF: instead build/test DOCX.",
    "Do not create PDF: instead create, edit DOCX."
  ])("preserves a punctuation-separated colon contrast marked by instead: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        skill("pdf", "pdf", "Create PDF files", 300),
        skill("docx", "docx", "Build, create, edit, and test DOCX files", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["docx"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    { task: "Do not create PDF: instead Run-v2 tools.", name: "run-v2" },
    { task: "Do not create PDF: Run-v2 tools instead.", name: "run-v2" },
    { task: "Do not create PDF: instead Run/v2 tools.", name: "run/v2" },
    { task: "Do not create PDF: Run/v2 tools instead.", name: "run/v2" },
    { task: "Do not create PDF: instead Run🚀 tools.", name: "run🚀" },
    { task: "Do not create PDF: Run🚀 tools instead.", name: "run🚀" }
  ])("preserves an explicit technical-name contrast: $task", ({ task, name }) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        skill("pdf", "pdf", "Create PDF files", 300),
        skill(name, name, `${name} tools`, 300)
      ])
    });

    expect(result.candidates
      .filter(({ decision }) => decision === "use")
      .map(({ name: candidateName }) => candidateName))
      .toEqual([name]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    { task: "Do not use legacy tools: Build new tools instead.", name: "build" },
    { task: "Do not use outdated workflows: Run-v2 instead.", name: "run-v2" },
    { task: "Do not use old project tools: instead Build new tools.", name: "build" },
    { task: "Do not use legacy tools: create, edit, and test DOCX instead.", name: "docx" }
  ])("lets an explicit alternative override a natural rejected object: $task", ({ task, name }) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill(name, name, `${name} tools and workflows`, 300)])
    });

    expect(result.candidates
      .filter(({ decision }) => decision === "use")
      .map(({ name: candidateName }) => candidateName))
      .toEqual([name]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "Do not use: Run-v2 tools, use Build instead.",
    "Do not use these tools: Run-v2, but use Build instead.",
    "Do not use these tools: Run-v2 tools, use Build instead.",
    "Do not use legacy tools: Run-v2 tools, use Build instead."
  ])("keeps a technical name negative before a later explicit contrast: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        skill("run-v2", "run-v2", "Run-v2 tools", 300),
        skill("build", "build", "Build tools", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["build"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each(["Run/Test", "Run&Test", "Run-test"])(
    "keeps task-adjacent action name %s negative before a later comma alternative",
    (negativePhrase) => {
      const result = analyzePreflight({
        ...fixed,
        task: `Do not use legacy tools: ${negativePhrase} tools, use Build instead.`,
        report: report([
          skill("run-test", "run-test", `${negativePhrase} tools`, 300),
          skill("build", "build", "Build tools", 300)
        ])
      });

      expect(result.useCandidateIds).toEqual(["build"]);
      expect(result.capabilityGaps).toEqual([]);
    }
  );

  it("keeps every earlier comma-list item negative before a later alternative", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not use: Run-v2 tools, Test tools, use Build instead.",
      report: report([
        skill("run-v2", "run-v2", "Run-v2 tools", 300),
        skill("test", "test", "Test tools", 300),
        skill("build", "build", "Build tools", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["build"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it.each([
    "Do not create PDF, but create DOCX instead.",
    "Do not create PDF: create DOCX instead."
  ])("preserves an explicit positive contrast after a negated clause: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([
        skill("pdf", "pdf", "Create PDF files", 300),
        skill("docx", "docx", "Create DOCX files", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["docx"]);
    expect(result.capabilityGaps).toEqual([]);
  });

  it("keeps a positive lifecycle request after a negated semicolon clause", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not auto-merge; review Phase 2 code before merge.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual(["request"]);
    expect(result.candidates[0]?.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HIGH_CONFIDENCE_TRIGGER" })
    ]));
  });

  it.each([
    "Do not use old tools.\nUse tools: Run tools.",
    "Do not use old tools. Use tools: Run tools.",
    "Do not use old tools! Use tools: Run tools.",
    "Do not use old tools\rRun tools for this task.",
    "Do not use old tools\u2028Run tools for this task.",
    "Do not use old tools\u2029Run tools for this task."
  ])("does not carry a task list header across a sentence boundary: %s", (task) => {
    const result = analyzePreflight({
      ...fixed,
      task,
      report: report([skill("run", "run", "Run tools", 300)])
    });

    expect(result.useCandidateIds).toEqual(["run"]);
  });

  it("keeps negated task terms out of ordinary relevance and name matching", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not create PDF files. Create a DOCX document.",
      report: report([
        skill("pdf", "pdf", "Create and edit PDF files", 300),
        skill("docx", "docx", "Create and edit DOCX documents", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["docx"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "pdf"))
      .toMatchObject({ decision: "excluded", features: { nameMatch: false } });
  });

  it("allows a positively requested Skill despite a different negated use of its name", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not edit PDF metadata. Create a PDF report.",
      report: report([skill(
        "pdf",
        "pdf",
        "Create and review PDF reports",
        300
      )])
    });

    expect(result.useCandidateIds).toEqual(["pdf"]);
    expect(result.capabilityGaps).toEqual([]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it("keeps positive code review eligible beside a different negated review object", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not review documentation before merge. Review Phase 2 code before merge.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual(["request"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it("keeps every code-review workflow excluded when code review is negated", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not review code before merge. Review documentation before merge.",
      report: report([
        skill(
          "request",
          "requesting-code-review",
          "Use before merge to review completed code and verify requirements",
          729
        ),
        skill(
          "receive",
          "receiving-code-review",
          "Use when receiving code review feedback before implementing suggestions",
          1_628
        )
      ])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "request", decision: "excluded" }),
      expect.objectContaining({ candidateId: "receive", decision: "excluded" })
    ]));
  });

  it("keeps a positive route eligible beside a different negated routing object", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review Phase 2 code before merge.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review code. Do not use before merge to review documentation.",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual(["request"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it.each([
    "Avoid using this skill for the following tools: Run tools.",
    "Avoid using the following tools: Run tools.",
    "Avoid calling any of these workflows: Run tools.",
    "Avoid using this skill for any of the tools: Run tools.",
    "Avoid calling all of the locally installed workflows: Run tools.",
    "Avoid using this skill for CI/CD tools: Run tools.",
    "Avoid using this skill for team’s tools: Run tools.",
    "Avoid using this skill for AI🚀 tools: Run tools.",
    "Avoid using this skill for AI⚙️ tools: Run tools.",
    "Avoid using this skill for AI👩‍💻 tools: Run tools."
  ])("keeps routing colon lists negative: %s", (description) => {
    const result = analyzePreflight({
      ...fixed,
      task: "Run tools for this task.",
      report: report([skill("run", "run", description, 300)])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]?.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it("lets an explicit routing alternative override a natural rejected object", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Build new tools for this task.",
      report: report([skill(
        "build",
        "build",
        "Do not use this skill for legacy tools: Build new tools instead.",
        300
      )])
    });

    expect(result.useCandidateIds).toEqual(["build"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
  });

  it.each(["\r", "\u2028", "\u2029"])(
    "does not carry a routing list header across line boundary %j",
    (lineBoundary) => {
    const result = analyzePreflight({
      ...fixed,
      task: "Run tools for this task.",
      report: report([skill(
        "run",
        "run",
        `Avoid using this skill for old tools${lineBoundary}Run tools for this task.`,
        300
      )])
    });

    expect(result.useCandidateIds).toEqual(["run"]);
    expect(result.candidates[0]?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
    ]));
    }
  );

  it("keeps a routed technical item negative before a later comma alternative", () => {
    const description =
      "Avoid using this skill for legacy tools: Run-v2 tools, use Build instead.";
    const result = analyzePreflight({
      ...fixed,
      task: "Run-v2 tools and Build tools for this task.",
      report: report([
        skill("run-v2", "run-v2", description, 300),
        skill("build", "build", "Use Build tools instead.", 300)
      ])
    });

    expect(result.useCandidateIds).toEqual(["build"]);
    expect(result.candidates.find(({ candidateId }) => candidateId === "run-v2"))
      .toMatchObject({ decision: "excluded" });
  });

  it.each(["Run/Test", "Run&Test", "Run-test"])(
    "keeps routed adjacent action name %s negative before a later comma alternative",
    (negativePhrase) => {
      const description =
        `Avoid using this skill for legacy tools: ${negativePhrase} tools, use Build instead.`;
      const result = analyzePreflight({
        ...fixed,
        task: `${negativePhrase} tools and Build tools for this task.`,
        report: report([
          skill("run-test", "run-test", description, 300),
          skill("build", "build", "Use Build tools instead.", 300)
        ])
      });

      expect(result.useCandidateIds).toEqual(["build"]);
      expect(result.candidates.find(({ candidateId }) => candidateId === "run-test"))
        .toMatchObject({ decision: "excluded" });
    }
  );

  it("keeps a negative code route as a veto beside positive documentation routing", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Review Phase 2 code before merge.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review documentation. Do not use before merge to review code.",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "NEGATIVE_TRIGGER" })
      ])
    });
  });

  it("keeps negative candidate terms out of capability-gap corroboration", () => {
    const baseline = analyzePreflight({
      ...fixed,
      task: "Add PostgreSQL support",
      report: report([skill(
        "postgres",
        "postgresql-helper",
        "General database advice.",
        300
      )])
    });
    const negative = analyzePreflight({
      ...fixed,
      task: "Add PostgreSQL support",
      report: report([skill(
        "postgres",
        "postgresql-helper",
        "Do not use this skill for support.",
        300
      )])
    });
    const negativeOnly = analyzePreflight({
      ...fixed,
      task: "Add PostgreSQL support",
      report: report([skill(
        "release",
        "release-helper",
        "Do not use this skill for PostgreSQL support.",
        300
      )])
    });

    expect(baseline.capabilityGaps).toEqual(["add", "postgresql", "support"]);
    expect(negative.capabilityGaps).toEqual(baseline.capabilityGaps);
    expect(negativeOnly.capabilityGaps).toEqual(baseline.capabilityGaps);
  });

  it("does not let negative metadata push positive gap evidence over the relevance gate", () => {
    const task = "Plan PostgreSQL schemas cryptography migration rollback validation deployment";
    const baseline = analyzePreflight({
      ...fixed,
      task,
      report: report([]),
      catalogSkills: [catalogSkill(
        "database",
        "database-helper",
        "PostgreSQL schemas",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });
    const negative = analyzePreflight({
      ...fixed,
      task,
      report: report([]),
      catalogSkills: [catalogSkill(
        "database",
        "database-helper",
        "PostgreSQL schemas. Do not use this skill for cryptography migration.",
        { compatibleHarnesses: ["claude"] }
      )],
      harness: "codex"
    });

    expect(baseline.capabilityGaps).toEqual([]);
    expect(negative.capabilityGaps).toEqual(baseline.capabilityGaps);
  });

  it("does not select an exact Skill name that appears only in a negated clause", () => {
    const result = analyzePreflight({
      ...fixed,
      task: "Do not request code review. Prepare release notes before merge.",
      report: report([skill(
        "request",
        "requesting-code-review",
        "Use before merge to review completed code and verify requirements",
        729
      )])
    });

    expect(result.useCandidateIds).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      decision: "excluded",
      features: { nameMatch: false }
    });
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
