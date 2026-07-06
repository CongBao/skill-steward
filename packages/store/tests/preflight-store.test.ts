import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePreflight,
  PREFLIGHT_ALGORITHM_VERSION,
  type PreflightResult
} from "@skill-steward/preflight";
import type { PortfolioReportV2, SkillRecordV2 } from "@skill-steward/engine";
import { describe, expect, it } from "vitest";
import {
  appendPreflightEvidence,
  assertPreflightInstallationRecommendation,
  PreflightEvidenceError,
  readPreflightEvidence,
  recordPreflightFeedback
} from "../src/preflight-store.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const rawTask = "PRIVATE migrate cryptography customer data";
const sourceUrl = "https://example.com/private-skills.git";

function result(id: string, createdAt: string): PreflightResult {
  return {
    schemaVersion: 5,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id,
    generatedAt: createdAt,
    portfolioFingerprint: hash("a"),
    taskHash: hash("c"),
    taskCharacterCount: rawTask.length,
    taskTermCount: 4,
    useCandidateIds: ["security-review"],
    installCandidateIds: ["catalog-testing"],
    candidates: [
      {
        candidateId: "security-review",
        availability: "installed",
        installedSkillId: "security-review",
        name: "security-review",
        description: "PRIVATE customer migration plan",
        scope: "project",
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
        contextTokens: 240,
        features: {
          taskCoverage: 0.75,
          skillPrecision: 0.5,
          nameMatch: true,
          projectScopeFit: true,
          capabilityCoverage: 0.5,
          capabilityPrecision: 0.5,
          triggerConfidence: "exact"
        },
        decision: "use",
        reasons: [{
          code: "HARNESS_SHADOWED",
          detail: "private-plugin-id at /private/native/cache and /private/plugin.json is shadowed by security-review"
        }]
      },
      {
        candidateId: "catalog-testing",
        availability: "available",
        catalogSkillId: "catalog-testing",
        name: "testing",
        description: "Review available Skill",
        scope: "unknown",
        compatibleHarnesses: [],
        compatibility: "unknown",
        scripts: ["scripts/private.sh"],
        executables: ["scripts/private.sh"],
        highestSeverity: "warning",
        relevance: 0.7,
        uniqueCoverage: 0.25,
        riskPenalty: 0.07,
        redundancyPenalty: 0,
        installPenalty: 0.08,
        contextTokens: 180,
        features: {
          taskCoverage: 0.5,
          skillPrecision: 0.4,
          nameMatch: false,
          projectScopeFit: false,
          capabilityCoverage: 0.25,
          capabilityPrecision: 0.25,
          triggerConfidence: "partial"
        },
        decision: "install",
        source: {
          sourceId: "private-source",
          trust: "user",
          url: sourceUrl,
          revision: "d".repeat(40),
          relativePath: "secret/testing"
        },
        reasons: [{ code: "INSTALL_REQUIRED", detail: "Review available Skill" }]
      }
    ],
    conflicts: [],
    inventoryWarnings: [{
      code: "HARNESS_AMBIGUOUS",
      harness: "codex",
      detail: "workspace-identity-secret plugin-version-9 cache-version-7"
    }],
    capabilityGaps: ["customer"],
    installedCoverage: 0.5,
    projectedCoverage: 0.75,
    selectedContextTokens: 420,
    plausibleContextTokens: 600,
    estimatedContextSaved: 180
  };
}

function legacyFile() {
  return {
    schemaVersion: 1,
    records: [{
      id: "legacy-run",
      createdAt: "2026-07-02T00:00:00.000Z",
      algorithmVersion: 1,
      portfolioFingerprint: hash("a"),
      taskHash: hash("b"),
      taskCharacterCount: 20,
      taskTermCount: 3,
      selectedSkillIds: ["legacy-skill"],
      candidates: [{
        skillId: "legacy-skill",
        relevance: 0.8,
        uniqueCoverage: 0.5,
        riskPenalty: 0,
        redundancyPenalty: 0,
        contextTokens: 200,
        decision: "selected"
      }],
      selectedContextTokens: 200,
      plausibleContextTokens: 200,
      estimatedContextSaved: 0
    }]
  };
}

function legacyV2File() {
  return {
    schemaVersion: 2,
    records: [{
      schemaVersion: 2,
      id: "legacy-v2",
      createdAt: "2026-07-02T12:00:00.000Z",
      algorithmVersion: 2,
      portfolioFingerprint: hash("a"),
      taskHash: hash("b"),
      taskCharacterCount: 20,
      taskTermCount: 3,
      useCandidateIds: ["legacy-skill"],
      installCandidateIds: [],
      candidates: [{
        candidateId: "legacy-skill",
        availability: "installed",
        relevance: 0.8,
        uniqueCoverage: 0.5,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: 200,
        decision: "use"
      }],
      installedCoverage: 0.5,
      projectedCoverage: 0.5,
      selectedContextTokens: 200,
      estimatedContextSaved: 0
    }]
  };
}

describe("preflight evidence store", () => {
  it("stores unique pseudonymous candidate IDs from unsafe duplicate installed records", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-unsafe-ids-"));
    const rawId = "/private/native/cache/duplicate-skill";
    const sourceIds = ["codex:unsafe-a", "codex:unsafe-b"];
    const skills: SkillRecordV2[] = sourceIds.map((sourceId, index) => ({
      id: rawId,
      name: `security-review-${index}`,
      description: "Review security changes",
      path: `/private/native/cache/record-${index}`,
      root: `record-${index}`,
      scope: "global",
      visibleTo: ["codex"],
      fingerprint: hash(String(index + 1)),
      files: [],
      estimatedTokens: 100 + index,
      ownership: "direct",
      sourceIds: [sourceId],
      exposures: [{
        harness: "codex",
        effectiveName: `security-review-${index}`,
        state: "effective",
        sourceId,
        reason: "TEST_EFFECTIVE"
      }]
    }));
    const report: PortfolioReportV2 = {
      schemaVersion: 2,
      generatedAt: "2026-07-04T00:00:00.000Z",
      portfolioFingerprint: hash("f"),
      workspace: { path: "/private/workspace", identity: hash("e") },
      skills,
      findings: [{
        id: "unsafe-duplicate-finding",
        code: "PORTFOLIO_RISK",
        severity: "warning",
        skillIds: [rawId],
        summary: `Finding for ${rawId}`,
        evidence: [`Observed ${rawId}`],
        recommendation: `Review ${rawId}`,
        confidence: 1
      }],
      inventory: {
        sources: sourceIds.map((sourceId, index) => ({
          id: sourceId,
          harness: "codex",
          scope: "global",
          kind: "direct-root",
          path: `/private/native/cache/source-${index}`,
          status: "scanned",
          skillCount: 1,
          effectiveSkillCount: 1
        })),
        harnesses: [{
          harness: "codex",
          status: "verified",
          sourceIds,
          skillCount: 2,
          effectiveSkillCount: 2
        }]
      }
    };
    const preflight = analyzePreflight({
      task: "Review security changes",
      report,
      catalogSkills: [],
      catalogSources: [],
      harness: "codex",
      id: "unsafe-duplicate-run",
      now: new Date("2026-07-04T00:01:00.000Z")
    });

    await appendPreflightEvidence(state, preflight, {
      harness: "codex",
      delivery: "hook"
    });
    const disk = await readFile(join(state, "preflights.json"), "utf8");
    const [record] = JSON.parse(disk).records as Array<{ candidateIds: string[] }>;

    expect(record?.candidateIds).toHaveLength(2);
    expect(new Set(record?.candidateIds).size).toBe(2);
    expect(JSON.stringify(preflight)).not.toContain(rawId);
    expect(disk).not.toContain(rawId);
    expect(disk).not.toContain("/private/native/cache");
  });

  it("reads legacy evidence and appends sanitized version-3 evidence", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-migrate-"));
    await writeFile(
      join(state, "preflights.json"),
      `${JSON.stringify(legacyFile(), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await appendPreflightEvidence(state, result("run-2", "2026-07-03T01:00:00.000Z"));

    const records = await readPreflightEvidence(state);
    expect(records).toHaveLength(2);
    expect(records.map(({ schemaVersion }) => schemaVersion)).toEqual([3, 1]);
    const disk = await readFile(join(state, "preflights.json"), "utf8");
    for (const secret of [
      rawTask,
      sourceUrl,
      "secret/testing",
      "scripts/private.sh",
      "TASK_TERM_MATCH",
      "Review available Skill",
      "cryptography customer",
      "private-plugin-id",
      "/private/native/cache",
      "workspace-identity-secret",
      "/private/plugin.json",
      "plugin-version-9",
      "cache-version-7",
      "HARNESS_SHADOWED",
      "HARNESS_AMBIGUOUS"
    ]) {
      expect(disk).not.toContain(secret);
    }
    expect(JSON.parse(disk).records[0]).toMatchObject({
      schemaVersion: 3,
      useCandidateIds: ["security-review"],
      installCandidateIds: ["catalog-testing"]
    });
    expect((await stat(join(state, "preflights.json"))).mode & 0o777).toBe(0o600);
  });

  it("persists attribution while keeping version-3 records without it readable", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-attribution-"));
    await appendPreflightEvidence(state, result("old-run", "2026-07-03T00:00:00.000Z"));
    await appendPreflightEvidence(state, result("new-run", "2026-07-03T01:00:00.000Z"), {
      harness: "claude-code",
      delivery: "dashboard"
    });

    const records = await readPreflightEvidence(state);
    expect(records[0]).toMatchObject({
      schemaVersion: 3,
      id: "new-run",
      harness: "claude-code",
      delivery: "dashboard"
    });
    expect(records[1]).toMatchObject({ schemaVersion: 3, id: "old-run" });
    expect(records[1]).not.toHaveProperty("delivery");
  });

  it("persists bounded version-3 evidence", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-bound-"));
    await appendPreflightEvidence(state, result("run-1", "2026-07-03T00:00:00.000Z"), { limit: 2 });
    await appendPreflightEvidence(state, result("run-2", "2026-07-03T01:00:00.000Z"), { limit: 2 });
    await appendPreflightEvidence(state, result("run-3", "2026-07-03T02:00:00.000Z"), { limit: 2 });
    expect((await readPreflightEvidence(state)).map(({ id }) => id)).toEqual([
      "run-3",
      "run-2"
    ]);
    await expect(appendPreflightEvidence(state, result("run-4", "2026-07-03T03:00:00.000Z"), {
      limit: 201
    })).rejects.toThrow("between 1 and 200");
  });

  it("reads version-2 evidence and stores candidate features only in learning mode", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-evidence-v3-"));
    await writeFile(join(state, "preflights.json"), `${JSON.stringify(legacyV2File())}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    expect((await readPreflightEvidence(state))[0]?.schemaVersion).toBe(2);

    await appendPreflightEvidence(state, result("minimal-run", "2026-07-03T00:00:00.000Z"), {
      policy: { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 },
      harness: "codex"
    });
    expect((await readPreflightEvidence(state))[0]).not.toHaveProperty("candidateFeatures");

    await appendPreflightEvidence(state, result("learning-run", "2026-07-03T01:00:00.000Z"), {
      policy: { schemaVersion: 1, mode: "learning", retentionDays: 30, maxEvents: 5_000 },
      harness: "codex"
    });
    expect((await readPreflightEvidence(state))[0]).toMatchObject({
      schemaVersion: 3,
      harness: "codex",
      candidateFeatures: expect.arrayContaining([
        expect.objectContaining({
          candidateId: "security-review",
          taskCoverage: 0.75,
          capabilityCoverage: 0.5,
          capabilityPrecision: 0.5,
          triggerConfidence: "exact"
        })
      ])
    });
  });

  it("records candidate feedback for new and legacy evidence", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-feedback-"));
    await writeFile(join(state, "preflights.json"), `${JSON.stringify(legacyFile())}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await appendPreflightEvidence(state, result("run-1", "2026-07-03T00:00:00.000Z"));
    await recordPreflightFeedback(
      state,
      "run-1",
      { label: "incomplete", candidateIds: ["catalog-testing"] },
      new Date("2026-07-03T01:00:00.000Z")
    );
    await recordPreflightFeedback(
      state,
      "legacy-run",
      { label: "useful", candidateIds: ["legacy-skill"] },
      new Date("2026-07-03T02:00:00.000Z")
    );
    const records = await readPreflightEvidence(state);
    expect(records[0]?.feedback).toMatchObject({ candidateIds: ["catalog-testing"] });
    expect(records[1]?.feedback).toMatchObject({ selectedSkillIds: ["legacy-skill"] });
  });

  it("records complete feedback sets for readable legacy identifiers and rejects unknown IDs", async () => {
    const legacyIds = ["legacy/skill", "legacy skill", "x".repeat(97)];
    const fixtures = [
      {
        file: (() => {
          const file = legacyFile();
          file.records[0]!.selectedSkillIds = legacyIds;
          file.records[0]!.candidates = legacyIds.map((skillId) => ({
            skillId,
            relevance: 0.8,
            uniqueCoverage: 0.5,
            riskPenalty: 0,
            redundancyPenalty: 0,
            contextTokens: 200,
            decision: "selected"
          }));
          return file;
        })(),
        id: "legacy-run",
        feedbackKey: "selectedSkillIds"
      },
      {
        file: (() => {
          const file = legacyV2File();
          file.records[0]!.useCandidateIds = legacyIds;
          file.records[0]!.candidates = legacyIds.map((candidateId) => ({
            candidateId,
            availability: "installed",
            relevance: 0.8,
            uniqueCoverage: 0.5,
            riskPenalty: 0,
            redundancyPenalty: 0,
            installPenalty: 0,
            contextTokens: 200,
            decision: "use"
          }));
          return file;
        })(),
        id: "legacy-v2",
        feedbackKey: "candidateIds"
      }
    ];

    for (const fixture of fixtures) {
      const state = await mkdtemp(join(tmpdir(), "steward-legacy-feedback-"));
      await writeFile(join(state, "preflights.json"), `${JSON.stringify(fixture.file)}\n`);
      await recordPreflightFeedback(
        state,
        fixture.id,
        { label: "incomplete", candidateIds: legacyIds },
        new Date("2026-07-03T02:00:00.000Z")
      );
      expect((await readPreflightEvidence(state))[0]?.feedback).toMatchObject({
        [fixture.feedbackKey]: legacyIds
      });
      await expect(recordPreflightFeedback(
        state,
        fixture.id,
        { label: "incorrect", candidateIds: ["unknown legacy/id"] },
        new Date("2026-07-03T03:00:00.000Z")
      )).rejects.toMatchObject({ code: "INVALID_FEEDBACK_CANDIDATE" });
    }
  });

  it("rejects unknown runs and candidate IDs without changing the file", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-invalid-"));
    await appendPreflightEvidence(state, result("run-1", "2026-07-03T00:00:00.000Z"));
    const path = join(state, "preflights.json");
    const before = await readFile(path, "utf8");
    await expect(recordPreflightFeedback(
      state,
      "missing",
      { label: "useful", candidateIds: [] },
      new Date()
    )).rejects.toMatchObject({ code: "PREFLIGHT_NOT_FOUND" });
    await expect(recordPreflightFeedback(
      state,
      "run-1",
      { label: "incorrect", candidateIds: ["unknown/current skill"] },
      new Date()
    )).rejects.toBeInstanceOf(PreflightEvidenceError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("validates only explicit installation recommendations for provenance", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-preflight-provenance-"));
    await appendPreflightEvidence(state, result("run-1", "2026-07-03T00:00:00.000Z"));
    await expect(assertPreflightInstallationRecommendation(
      state,
      "run-1",
      "catalog-testing"
    )).resolves.toBeUndefined();
    await expect(assertPreflightInstallationRecommendation(
      state,
      "run-1",
      "security-review"
    )).rejects.toMatchObject({ code: "INVALID_INSTALL_PROVENANCE" });
    await expect(assertPreflightInstallationRecommendation(
      state,
      "missing",
      "catalog-testing"
    )).rejects.toMatchObject({ code: "PREFLIGHT_NOT_FOUND" });
  });
});
