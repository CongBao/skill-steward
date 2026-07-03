import type { CatalogSnapshot, CatalogSource } from "../src/domain.js";
import { describe, expect, it, vi } from "vitest";
import { refreshCatalog } from "../src/refresh.js";

function source(id: string, enabled = true): CatalogSource {
  return {
    id,
    name: id,
    kind: "git",
    url: `https://example.com/${id}.git`,
    enabled,
    trust: "user",
    preset: false
  };
}

function previousSnapshot(): CatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-02T00:00:00.000Z",
    sources: [{
      sourceId: "failed",
      status: "ready",
      commitSha: "c".repeat(40),
      refreshedAt: "2026-07-02T00:00:00.000Z",
      skillCount: 1
    }],
    skills: [{
      id: "catalog:failed:review",
      sourceId: "failed",
      sourceRevision: "c".repeat(40),
      relativePath: "review",
      name: "review",
      description: "Review source changes",
      fingerprint: `sha256:${"d".repeat(64)}`,
      estimatedTokens: 200,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: [],
      compatibility: "unknown"
    }]
  };
}

describe("catalog refresh", () => {
  it("replaces successful source records and preserves last-known-good failures", async () => {
    const inspect = vi.fn(async (sourceId: string) => {
      if (sourceId === "failed") {
        throw Object.assign(new Error("offline"), { code: "GIT_FAILED" });
      }
      return {
        commitSha: "a".repeat(40),
        candidates: [{
          id: "candidate",
          relativePath: "review",
          name: "review",
          description: "Review source changes",
          fingerprint: `sha256:${"b".repeat(64)}`,
          files: [],
          estimatedTokens: 200,
          scripts: [],
          executables: [],
          findings: []
        }]
      };
    });

    const result = await refreshCatalog({
      sources: [source("ready"), source("failed")],
      previous: previousSnapshot(),
      now: new Date("2026-07-03T00:00:00.000Z"),
      inspect
    });

    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "ready", status: "ready", skillCount: 1 }),
      expect.objectContaining({
        sourceId: "failed",
        status: "stale",
        errorCode: "GIT_FAILED",
        commitSha: "c".repeat(40),
        skillCount: 1
      })
    ]));
    expect(result.skills.some(({ sourceId }) => sourceId === "failed")).toBe(true);
    expect(result.skills.find(({ sourceId }) => sourceId === "ready")).toMatchObject({
      sourceRevision: "a".repeat(40),
      relativePath: "review"
    });
  });

  it("does not inspect disabled sources", async () => {
    const inspect = vi.fn();
    const result = await refreshCatalog({
      sources: [source("disabled", false)],
      previous: null,
      now: new Date("2026-07-03T00:00:00.000Z"),
      inspect
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(result.sources).toEqual([{
      sourceId: "disabled",
      status: "disabled",
      skillCount: 0
    }]);
    expect(result.skills).toEqual([]);
  });

  it("normalizes untrusted error codes", async () => {
    const result = await refreshCatalog({
      sources: [source("failed")],
      previous: null,
      now: new Date("2026-07-03T00:00:00.000Z"),
      inspect: async () => {
        throw Object.assign(new Error("bad"), { code: "secret/path" });
      }
    });
    expect(result.sources[0]).toMatchObject({
      status: "error",
      errorCode: "CATALOG_REFRESH_FAILED"
    });
  });
});
