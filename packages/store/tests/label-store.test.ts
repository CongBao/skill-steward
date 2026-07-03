import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendFindingLabel } from "../src/label-store.js";

describe("appendFindingLabel", () => {
  it("appends one validated JSONL record", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-label-"));
    await appendFindingLabel(stateDir, {
      findingId: "finding-1",
      label: "useful",
      createdAt: "2026-07-02T00:00:00.000Z"
    });

    const lines = (await readFile(join(stateDir, "finding-labels.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      findingId: "finding-1",
      label: "useful"
    });
  });
});
