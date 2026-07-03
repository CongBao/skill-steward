import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
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

describe("report history", () => {
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
