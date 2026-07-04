import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PortfolioReport,
  PortfolioReportV2,
  SkillRecord
} from "@skill-steward/engine";
import {
  diffReports,
  readLatestReport,
  readPreviousReport,
  writeLatestReport
} from "../src/manifest-store.js";
import { readReportHistory } from "../src/history-store.js";

const base: PortfolioReport = {
  schemaVersion: 1,
  generatedAt: "2026-07-02T00:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  skills: [],
  findings: []
};

const sourceId = "codex:project:/repo/.agents/skills";
const v2Report = {
  schemaVersion: 2 as const,
  generatedAt: "2026-07-02T01:00:00.000Z",
  portfolioFingerprint: `sha256:${"f".repeat(64)}`,
  workspace: {
    path: "/repo",
    identity: `sha256:${"1".repeat(64)}`
  },
  skills: [{
    id: "skill-v2",
    name: "review",
    description: "Review code",
    path: "/repo/.agents/skills/review",
    root: "review",
    scope: "project" as const,
    visibleTo: ["codex" as const],
    fingerprint: `sha256:${"e".repeat(64)}`,
    files: [],
    estimatedTokens: 10,
    ownership: "direct" as const,
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex" as const,
      effectiveName: "review",
      state: "effective" as const,
      sourceId,
      reason: "DIRECT_SKILL"
    }]
  }],
  findings: [],
  inventory: {
    sources: [{
      id: sourceId,
      harness: "codex" as const,
      scope: "project" as const,
      kind: "direct-root" as const,
      path: "/repo/.agents/skills",
      status: "scanned" as const,
      skillCount: 1,
      effectiveSkillCount: 1
    }],
    harnesses: [{
      harness: "codex" as const,
      status: "verified" as const,
      sourceIds: [sourceId],
      skillCount: 1,
      effectiveSkillCount: 1
    }]
  }
} satisfies PortfolioReportV2;

function skill(id: string, fingerprint: string): SkillRecord {
  return {
    id,
    name: id,
    description: id,
    path: `/${id}`,
    root: id,
    scope: "global",
    visibleTo: ["agents"],
    fingerprint,
    files: [],
    estimatedTokens: 1
  };
}

describe("manifest store", () => {
  it("atomically writes and reads a visibility-aware latest report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-v2-state-"));
    await writeLatestReport(stateDir, base);
    await writeLatestReport(stateDir, v2Report);

    expect(await readLatestReport(stateDir)).toEqual(v2Report);
    expect(await readPreviousReport(stateDir)).toEqual(base);
    expect(await readReportHistory(stateDir)).toEqual([v2Report, base]);
  });

  it("reads a preexisting schema-v1 latest report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-v1-state-"));
    await writeFile(
      join(stateDir, "latest-report.json"),
      `${JSON.stringify(base)}\n`,
      "utf8"
    );

    expect(await readLatestReport(stateDir)).toEqual(base);
  });

  it.each(["ownership", "sourceIds", "exposures"] as const)(
    "rejects a visibility report Skill missing %s",
    async (missingField) => {
      const stateDir = await mkdtemp(join(tmpdir(), "steward-invalid-v2-"));
      const invalidSkill: Record<string, unknown> = { ...v2Report.skills[0] };
      delete invalidSkill[missingField];

      await expect(writeLatestReport(
        stateDir,
        {
          ...v2Report,
          skills: [invalidSkill]
        } as unknown as PortfolioReport
      )).rejects.toThrow();
    }
  );

  it("atomically writes and reads the latest report", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-state-"));
    await writeLatestReport(stateDir, base);

    expect(await readLatestReport(stateDir)).toEqual(base);
    expect(await readReportHistory(stateDir)).toEqual([base]);
  });

  it("preserves the prior distinct scan", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-history-"));
    const next = { ...base, portfolioFingerprint: `sha256:${"f".repeat(64)}` };
    await writeLatestReport(stateDir, base);
    await writeLatestReport(stateDir, next);

    expect(await readPreviousReport(stateDir)).toEqual(base);
    expect(await readLatestReport(stateDir)).toEqual(next);
  });

  it("reports added, changed, and removed skills", () => {
    const before = {
      ...base,
      skills: [
        skill("removed", `sha256:${"b".repeat(64)}`),
        skill("changed", `sha256:${"c".repeat(64)}`)
      ]
    };
    const after = {
      ...base,
      skills: [
        skill("added", `sha256:${"d".repeat(64)}`),
        skill("changed", `sha256:${"e".repeat(64)}`)
      ]
    };

    expect(diffReports(before, after)).toEqual({
      added: ["added"],
      changed: ["changed"],
      removed: ["removed"]
    });
  });
});
