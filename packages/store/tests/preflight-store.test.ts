import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreflightResult } from "@skill-steward/preflight";
import { describe, expect, it } from "vitest";
import {
  appendPreflightEvidence,
  PreflightEvidenceError,
  readPreflightEvidence,
  recordPreflightFeedback
} from "../src/preflight-store.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function result(id: string, createdAt: string): PreflightResult {
  return {
    schemaVersion: 1,
    algorithmVersion: 1,
    id,
    generatedAt: createdAt,
    portfolioFingerprint: hash("a"),
    taskHash: hash("c"),
    taskCharacterCount: 31,
    taskTermCount: 4,
    selectedSkillIds: ["security-review"],
    candidates: [
      {
        skillId: "security-review",
        name: "security-review",
        description: "PRIVATE customer migration plan",
        scope: "project",
        visibleTo: ["codex"],
        relevance: 0.8,
        uniqueCoverage: 0.5,
        riskPenalty: 0,
        redundancyPenalty: 0,
        contextTokens: 240,
        decision: "selected",
        reasons: [
          {
            code: "TASK_TERM_MATCH",
            detail: "PRIVATE customer migration plan"
          }
        ]
      },
      {
        skillId: "testing",
        name: "testing",
        description: "Test changes",
        scope: "global",
        visibleTo: ["claude"],
        relevance: 0.3,
        uniqueCoverage: 0,
        riskPenalty: 0.07,
        redundancyPenalty: 0.1,
        contextTokens: 180,
        decision: "excluded",
        reasons: [
          {
            code: "REDUNDANT_WITH_SELECTED",
            detail: "PRIVATE customer overlap"
          }
        ]
      }
    ],
    conflicts: [],
    selectedContextTokens: 240,
    plausibleContextTokens: 420,
    estimatedContextSaved: 180
  };
}

describe("preflight evidence store", () => {
  it("persists only sanitized bounded evidence with private permissions", async () => {
    expect(appendPreflightEvidence).toBeDefined();
    const stateDir = await mkdtemp(join(tmpdir(), "steward-preflight-store-"));
    await appendPreflightEvidence(
      stateDir,
      result("run-1", "2026-07-03T00:00:00.000Z"),
      { limit: 2 }
    );
    await appendPreflightEvidence(
      stateDir,
      result("run-2", "2026-07-03T01:00:00.000Z"),
      { limit: 2 }
    );
    await appendPreflightEvidence(
      stateDir,
      result("run-3", "2026-07-03T02:00:00.000Z"),
      { limit: 2 }
    );

    const path = join(stateDir, "preflights.json");
    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain("PRIVATE customer migration plan");
    expect(disk).not.toContain("customer");
    expect(disk).not.toContain("description");
    expect(JSON.parse(disk)).toMatchObject({ schemaVersion: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const records = await readPreflightEvidence(stateDir);
    expect(records.map(({ id }) => id)).toEqual(["run-3", "run-2"]);
    expect(records[0]?.candidates[0]).toEqual({
      skillId: "security-review",
      relevance: 0.8,
      uniqueCoverage: 0.5,
      riskPenalty: 0,
      redundancyPenalty: 0,
      contextTokens: 240,
      decision: "selected"
    });
  });

  it("records validated feedback without exposing task content", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-preflight-feedback-"));
    await appendPreflightEvidence(
      stateDir,
      result("run-1", "2026-07-03T00:00:00.000Z")
    );
    await recordPreflightFeedback(
      stateDir,
      "run-1",
      { label: "incomplete", selectedSkillIds: ["testing"] },
      new Date("2026-07-03T01:00:00.000Z")
    );

    expect((await readPreflightEvidence(stateDir))[0]?.feedback).toEqual({
      label: "incomplete",
      selectedSkillIds: ["testing"],
      createdAt: "2026-07-03T01:00:00.000Z"
    });
    expect(await readFile(join(stateDir, "preflights.json"), "utf8")).not.toContain(
      "PRIVATE"
    );
  });

  it("rejects unknown runs and Skill IDs without changing the file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-preflight-invalid-"));
    await appendPreflightEvidence(
      stateDir,
      result("run-1", "2026-07-03T00:00:00.000Z")
    );
    const path = join(stateDir, "preflights.json");
    const before = await readFile(path, "utf8");

    await expect(
      recordPreflightFeedback(
        stateDir,
        "missing",
        { label: "useful", selectedSkillIds: [] },
        new Date()
      )
    ).rejects.toMatchObject({ code: "PREFLIGHT_NOT_FOUND" });
    await expect(
      recordPreflightFeedback(
        stateDir,
        "run-1",
        { label: "incorrect", selectedSkillIds: ["unknown"] },
        new Date()
      )
    ).rejects.toBeInstanceOf(PreflightEvidenceError);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
