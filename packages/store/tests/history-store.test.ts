import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PortfolioReport,
  PortfolioReportV2
} from "@skill-steward/engine";
import {
  appendReportHistory,
  readReportHistory
} from "../src/history-store.js";

function report(character: string, hour: number): PortfolioReport {
  return {
    schemaVersion: 1,
    generatedAt: `2026-07-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    portfolioFingerprint: `sha256:${character.repeat(64)}`,
    skills: [],
    findings: []
  };
}

function visibilityReport(
  character: string,
  hour: number
): PortfolioReportV2 {
  const sourceId = "codex:project:/repo/.agents/skills";
  return {
    schemaVersion: 2 as const,
    generatedAt: `2026-07-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    portfolioFingerprint: `sha256:${character.repeat(64)}`,
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
  };
}

describe("report history", () => {
  it("preserves schema-v1 and schema-v2 reports together", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-mixed-history-"));
    const legacy = report("a", 10);
    const visibility = visibilityReport("b", 11);

    await appendReportHistory(stateDirectory, legacy);
    await appendReportHistory(stateDirectory, visibility);

    expect(
      (await readReportHistory(stateDirectory)).map(({ schemaVersion }) =>
        schemaVersion
      )
    ).toEqual([2, 1]);
  });

  it("keeps distinct reports newest first and suppresses duplicate fingerprints", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-history-"));
    const first = report("a", 10);
    const second = report("b", 11);

    await appendReportHistory(stateDirectory, first, { limit: 2 });
    await appendReportHistory(stateDirectory, first, { limit: 2 });
    await appendReportHistory(stateDirectory, second, { limit: 2 });

    expect(
      (await readReportHistory(stateDirectory)).map(
        ({ portfolioFingerprint }) => portfolioFingerprint
      )
    ).toEqual([second.portfolioFingerprint, first.portfolioFingerprint]);
  });

  it("prunes the oldest report after a successful bounded append", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-prune-"));
    const first = report("a", 10);
    const second = report("b", 11);
    const third = report("c", 12);

    await appendReportHistory(stateDirectory, first, { limit: 2 });
    await appendReportHistory(stateDirectory, second, { limit: 2 });
    await appendReportHistory(stateDirectory, third, { limit: 2 });

    expect(await readReportHistory(stateDirectory)).toEqual([third, second]);
  });

  it("rejects a malformed index instead of silently losing history", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-corrupt-"));
    const first = report("a", 10);
    await appendReportHistory(stateDirectory, first);
    const indexPath = join(stateDirectory, "history", "index.json");
    const current = await readFile(indexPath, "utf8");
    await writeFile(indexPath, current.replace("generatedAt", "badField"));

    await expect(readReportHistory(stateDirectory)).rejects.toThrow();
  });
});
