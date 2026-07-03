import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PortfolioReport, SkillRecord } from "@skill-steward/engine";
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
