import { describe, expect, it } from "vitest";
import {
  COMPACT_PREFLIGHT_MAX_BYTES,
  COMPACT_PREFLIGHT_SCHEMA_VERSION,
  compactPreflightResultSchema,
  PREFLIGHT_ALGORITHM_VERSION,
  preflightResultSchema,
  toCompactPreflight,
  type PreflightResult
} from "../src/index.js";

const rawTask = "PRIVATE customer task";

function result(): PreflightResult {
  return {
    schemaVersion: 5,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id: "run-1",
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    taskHash: `sha256:${"b".repeat(64)}`,
    taskCharacterCount: rawTask.length,
    taskTermCount: 3,
    useCandidateIds: ["security"],
    installCandidateIds: ["testing"],
    candidates: [
      {
        candidateId: "security",
        availability: "installed",
        installedSkillId: "security",
        name: "security-review",
        description: rawTask,
        scope: "global",
        compatibleHarnesses: ["codex"],
        compatibility: "declared",
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.8,
        uniqueCoverage: 0.5,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: 200,
        features: {
          taskCoverage: 0.8,
          skillPrecision: 0.6,
          nameMatch: true,
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "use",
        reasons: [
          { code: "TASK_TERM_MATCH", detail: rawTask },
          { code: "UNIQUE_COVERAGE", detail: "Covers security" }
        ]
      },
      {
        candidateId: "testing",
        availability: "available",
        catalogSkillId: "testing",
        name: "testing-review",
        description: "Find missing tests",
        scope: "unknown",
        compatibleHarnesses: [],
        compatibility: "unknown",
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.7,
        uniqueCoverage: 0.25,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0.08,
        contextTokens: 180,
        features: {
          taskCoverage: 0.5,
          skillPrecision: 0.4,
          nameMatch: false,
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "install",
        source: {
          sourceId: "private-catalog",
          trust: "user",
          url: "https://example.com/private.git",
          revision: "c".repeat(40),
          relativePath: "private/testing"
        },
        reasons: [
          { code: "INSTALL_REQUIRED", detail: "Approval required" },
          { code: "UNIQUE_COVERAGE", detail: "Covers testing" }
        ]
      },
      {
        candidateId: "excluded-private",
        availability: "installed",
        installedSkillId: "excluded-private",
        name: "excluded-private",
        description: "PRIVATE excluded candidate description",
        scope: "global",
        compatibleHarnesses: ["codex"],
        compatibility: "declared",
        scripts: ["/private/native/script"],
        executables: ["private-tool"],
        highestSeverity: null,
        relevance: 0,
        uniqueCoverage: 0,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: 900,
        features: {
          taskCoverage: 0,
          skillPrecision: 0,
          nameMatch: false,
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "excluded",
        reasons: [{ code: "LOW_RELEVANCE", detail: "PRIVATE exclusion detail" }]
      }
    ],
    conflicts: [{
      id: "private-conflict",
      code: "OVERLAPPING_TRIGGER",
      severity: "warning",
      skillIds: ["security"],
      summary: "PRIVATE conflict summary",
      evidence: ["/private/native/evidence"],
      recommendation: "PRIVATE recommendation",
      confidence: 1
    }],
    inventoryWarnings: [{
      code: "HARNESS_AMBIGUOUS",
      harness: "codex",
      detail: "PRIVATE warning detail"
    }],
    capabilityGaps: ["deployment"],
    installedCoverage: 0.5,
    projectedCoverage: 0.75,
    selectedContextTokens: 380,
    plausibleContextTokens: 1_280,
    estimatedContextSaved: 900
  };
}

describe("compact preflight contract", () => {
  it("keeps only bounded actionable recommendations, codes, coverage, and feedback", () => {
    const compact = toCompactPreflight(result());

    expect(COMPACT_PREFLIGHT_SCHEMA_VERSION).toBe(4);

    expect(compact).toEqual({
      schemaVersion: COMPACT_PREFLIGHT_SCHEMA_VERSION,
      preflightId: "run-1",
      algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
      use: [{
        candidateId: "security",
        name: "security-review",
        contextTokens: 200,
        reasonCodes: ["TASK_TERM_MATCH", "UNIQUE_COVERAGE"]
      }],
      install: [{
        candidateId: "testing",
        name: "testing-review",
        contextTokens: 180,
        reasonCodes: ["INSTALL_REQUIRED", "UNIQUE_COVERAGE"]
      }],
      inventoryWarningCodes: ["HARNESS_AMBIGUOUS"],
      conflictWarningCodes: ["OVERLAPPING_TRIGGER"],
      capabilityGaps: ["deployment"],
      installedCoverage: 0.5,
      projectedCoverage: 0.75,
      selectedContextTokens: 380,
      feedbackCommand: "skill-steward evidence feedback --preflight run-1 --label useful"
    });
    expect(compactPreflightResultSchema.parse(compact)).toEqual(compact);
    expect(() => compactPreflightResultSchema.parse({
      ...compact,
      description: "not allowed"
    })).toThrow();
    expect(() => compactPreflightResultSchema.parse({
      ...compact,
      feedbackCommand: "skill-steward evidence feedback --preflight different --label useful"
    })).toThrow();

    const serialized = JSON.stringify(compact);
    expect(serialized).not.toMatch(/PRIVATE|excluded-private|example\.com|native\/|private\/testing/i);
    expect(Object.keys(compact)).not.toEqual(expect.arrayContaining([
      "candidates",
      "descriptions",
      "taskHash",
      "portfolioFingerprint",
      "sources",
      "details",
      "evidence",
      "recommendations",
      "catalogProvenance"
    ]));
  });

  it("keeps the exact stored Preflight ID in the feedback locator or rejects it", () => {
    const exact = result();
    exact.id = "stored-preflight-123";
    const compact = toCompactPreflight(exact);
    expect(compact.preflightId).toBe(exact.id);
    expect(compact.feedbackCommand).toContain(`--preflight ${exact.id} `);

    exact.id = "unsafe preflight id";
    expect(() => toCompactPreflight(exact)).toThrow();
  });

  it("allows a null feedback command only with the persistence warning", () => {
    const compact = toCompactPreflight(result());
    expect(() => compactPreflightResultSchema.parse({
      ...compact,
      feedbackCommand: null
    })).toThrow();

    const unavailable = toCompactPreflight(result(), {
      additionalConflictWarningCodes: ["PREFLIGHT_PERSISTENCE_UNAVAILABLE"],
      feedbackAvailable: false
    });
    expect(unavailable.feedbackCommand).toBeNull();
    expect(unavailable.conflictWarningCodes)
      .toContain("PREFLIGHT_PERSISTENCE_UNAVAILABLE");
    expect(compactPreflightResultSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("keeps high-confidence trigger details private and the compact response bounded", () => {
    const full = result();
    full.candidates[0]!.reasons.unshift({
      code: "HIGH_CONFIDENCE_TRIGGER",
      detail: "PRIVATE before merge trigger detail"
    });

    const compact = toCompactPreflight(full);
    const serialized = JSON.stringify(compact);

    expect(compact.use[0]?.reasonCodes).toContain("HIGH_CONFIDENCE_TRIGGER");
    expect(serialized).not.toContain("before merge");
    expect(serialized).not.toContain("PRIVATE");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      COMPACT_PREFLIGHT_MAX_BYTES
    );
  });

  it("carries capability reason codes without capability details", () => {
    const full = result();
    full.candidates[0]!.reasons = [{
      code: "CAPABILITY_MATCH",
      detail: "PRIVATE plan:requirement"
    }, {
      code: "EXACT_TRIGGER_MATCH",
      detail: "PRIVATE implement:feature"
    }, {
      code: "MARGINAL_CAPABILITY",
      detail: "PRIVATE publish:release"
    }];

    const compact = toCompactPreflight(full);
    expect(compact.use[0]?.reasonCodes).toEqual([
      "CAPABILITY_MATCH",
      "EXACT_TRIGGER_MATCH",
      "MARGINAL_CAPABILITY"
    ]);
    expect(JSON.stringify(compact)).not.toContain("PRIVATE");
    expect(JSON.stringify(compact)).not.toContain("requirement");
  });

  it("stays within the byte cap for hostile multibyte valid fields", () => {
    const hostile = result();
    hostile.candidates[0]!.name = `私密\n\"\\${"界".repeat(20_000)}`;
    hostile.candidates[1]!.name = `安装\t${"测".repeat(20_000)}`;
    hostile.capabilityGaps = Array.from(
      { length: 6 },
      (_, index) => `${index}${"隙".repeat(20_000)}`
    );
    hostile.conflicts = Array.from({ length: 100 }, (_, index) => ({
      ...hostile.conflicts[0]!,
      id: `conflict-${index}`,
      code: `HOSTILE_${"A".repeat(10_000)}_${index}`
    }));

    const compact = toCompactPreflight(hostile);
    const serialized = JSON.stringify(compact);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      COMPACT_PREFLIGHT_MAX_BYTES
    );
    expect(Buffer.from(serialized, "utf8").toString("utf8")).toBe(serialized);
    expect(serialized).not.toContain("�");
    expect(compactPreflightResultSchema.parse(compact)).toEqual(compact);
  });

  it("converts a maximum full-schema-valid recommendation shape within 4096 bytes", () => {
    const maximumId = (prefix: string, index: number) =>
      `${prefix}${index}${"x".repeat(94)}`;
    const reasonCodes = [
      "INVENTORY_RESCAN_REQUIRED",
      "REDUNDANT_WITH_SELECTED",
      "HARNESS_INCOMPATIBLE"
    ] as const;
    const selected = [
      ...Array.from({ length: 5 }, (_, index) => ({
        candidateId: maximumId("u", index),
        availability: "installed" as const,
        installedSkillId: maximumId("u", index),
        name: "界".repeat(16),
        description: `PRIVATE use description ${index}`,
        scope: "global" as const,
        compatibleHarnesses: ["codex" as const],
        compatibility: "declared" as const,
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 1,
        uniqueCoverage: 1,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: Number.MAX_SAFE_INTEGER,
        features: {
          taskCoverage: 1,
          skillPrecision: 1,
          nameMatch: true,
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "use" as const,
        reasons: reasonCodes.map((code) => ({ code, detail: `PRIVATE ${code}` }))
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        candidateId: maximumId("i", index),
        availability: "available" as const,
        catalogSkillId: maximumId("i", index),
        name: "測".repeat(16),
        description: `PRIVATE install description ${index}`,
        scope: "unknown" as const,
        compatibleHarnesses: ["codex" as const],
        compatibility: "declared" as const,
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 1,
        uniqueCoverage: 1,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 1,
        contextTokens: Number.MAX_SAFE_INTEGER,
        features: {
          taskCoverage: 1,
          skillPrecision: 1,
          nameMatch: true,
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "install" as const,
        source: {
          sourceId: `PRIVATE-source-${index}`,
          trust: "user" as const,
          url: `https://example.com/private-${index}.git`,
          revision: String(index).repeat(40),
          relativePath: `PRIVATE/path/${index}`
        },
        reasons: reasonCodes.map((code) => ({ code, detail: `PRIVATE ${code}` }))
      }))
    ];
    const excluded = {
      ...selected[0]!,
      candidateId: "excluded-private",
      installedSkillId: "excluded-private",
      name: "PRIVATE excluded",
      description: "PRIVATE excluded description",
      decision: "excluded" as const
    };
    const maximum = {
      ...result(),
      id: `p${"z".repeat(95)}`,
      taskCharacterCount: Number.MAX_SAFE_INTEGER,
      taskTermCount: Number.MAX_SAFE_INTEGER,
      useCandidateIds: selected.slice(0, 5).map(({ candidateId }) => candidateId),
      installCandidateIds: selected.slice(5).map(({ candidateId }) => candidateId),
      candidates: [...selected, excluded],
      conflicts: Array.from({ length: 4 }, (_, index) => ({
        id: `PRIVATE-conflict-${index}`,
        code: `${String.fromCharCode(65 + index)}${"X".repeat(63)}`,
        severity: "critical" as const,
        skillIds: [selected[0]!.candidateId],
        summary: `PRIVATE summary ${index}`,
        evidence: [`/PRIVATE/evidence/${index}`],
        recommendation: `PRIVATE recommendation ${index}`,
        confidence: 1
      })),
      inventoryWarnings: ["codex", "claude", "github-copilot"].map((harness) => ({
        code: "HARNESS_AMBIGUOUS" as const,
        harness,
        detail: `PRIVATE warning for ${harness}`
      })),
      capabilityGaps: Array.from(
        { length: 6 },
        (_, index) => `${index}${"隙".repeat(10)}x`
      ),
      installedCoverage: 1,
      projectedCoverage: 1,
      selectedContextTokens: Number.MAX_SAFE_INTEGER,
      plausibleContextTokens: Number.MAX_SAFE_INTEGER,
      estimatedContextSaved: Number.MAX_SAFE_INTEGER
    };
    const full = preflightResultSchema.parse(maximum);

    const compact = toCompactPreflight(full);
    const serialized = JSON.stringify(compact);
    expect(compact.use).toHaveLength(5);
    expect(compact.install).toHaveLength(3);
    expect(compact.use.every(({ candidateId, name, reasonCodes: codes }) =>
      candidateId.length === 96 &&
      Buffer.byteLength(name, "utf8") === 48 &&
      codes.length === 3
    )).toBe(true);
    expect(compact.install.every(({ candidateId, name, reasonCodes: codes }) =>
      candidateId.length === 96 &&
      Buffer.byteLength(name, "utf8") === 48 &&
      codes.length === 3
    )).toBe(true);
    expect(compact.inventoryWarningCodes).toEqual(["HARNESS_AMBIGUOUS"]);
    expect(compact.conflictWarningCodes).toHaveLength(4);
    expect(compact.capabilityGaps).toHaveLength(6);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      COMPACT_PREFLIGHT_MAX_BYTES
    );
    expect(serialized).not.toMatch(
      /PRIVATE|excluded-private|description|example\.com|relativePath/i
    );

    const persistenceUnavailable = toCompactPreflight(full, {
      additionalConflictWarningCodes: ["PREFLIGHT_PERSISTENCE_UNAVAILABLE"]
    });
    expect(persistenceUnavailable.conflictWarningCodes)
      .toContain("PREFLIGHT_PERSISTENCE_UNAVAILABLE");
    expect(persistenceUnavailable.conflictWarningCodes).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(persistenceUnavailable), "utf8"))
      .toBeLessThanOrEqual(COMPACT_PREFLIGHT_MAX_BYTES);

    const maximumCompact = {
      ...compact,
      algorithmVersion: Number.MAX_SAFE_INTEGER,
      inventoryWarningCodes: Array.from(
        { length: 3 },
        (_, index) => `${String.fromCharCode(73 + index)}${"W".repeat(63)}`
      )
    };
    const structurallyMaximum = compactPreflightResultSchema.parse(maximumCompact);
    expect(structurallyMaximum.inventoryWarningCodes).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(structurallyMaximum), "utf8"))
      .toBeLessThanOrEqual(COMPACT_PREFLIGHT_MAX_BYTES);
  });
});
