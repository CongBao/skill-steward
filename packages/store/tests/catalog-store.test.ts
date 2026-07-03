import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSourcePresets, type CatalogSource } from "@skill-steward/catalog";
import { describe, expect, it } from "vitest";
import {
  readCatalogSnapshot,
  readCatalogSources,
  writeCatalogSnapshot,
  writeCatalogSources
} from "../src/catalog-store.js";

describe("catalog store", () => {
  it("seeds disabled presets and writes private atomic state", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-catalog-store-"));
    expect(await readCatalogSources(state)).toEqual(catalogSourcePresets);
    const enabled = catalogSourcePresets.map((source, index) => ({
      ...source,
      enabled: index === 0
    }));
    await writeCatalogSources(state, enabled);
    expect(await readCatalogSources(state)).toEqual(enabled);
    expect((await stat(join(state, "catalog-sources.json"))).mode & 0o777).toBe(0o600);
  });

  it("round-trips a bounded metadata-only snapshot", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-catalog-index-"));
    const snapshot = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-03T00:00:00.000Z",
      sources: [],
      skills: []
    };
    expect(await readCatalogSnapshot(state)).toBeNull();
    await writeCatalogSnapshot(state, snapshot);
    expect(await readCatalogSnapshot(state)).toEqual(snapshot);
    expect(await readFile(join(state, "catalog-index.json"), "utf8")).not.toContain(
      "SKILL.md body"
    );
  });

  it("rejects duplicate IDs and more than five enabled sources", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-catalog-bounds-"));
    const custom = (index: number): CatalogSource => ({
      id: `custom-${index}`,
      name: `Custom ${index}`,
      kind: "git",
      url: `https://example.com/custom-${index}.git`,
      enabled: true,
      trust: "user",
      preset: false
    });
    await expect(writeCatalogSources(state, Array.from({ length: 6 }, (_, index) => custom(index))))
      .rejects.toThrow("At most five catalog sources may be enabled");
    await expect(writeCatalogSources(state, [custom(1), custom(1)]))
      .rejects.toThrow("Catalog source IDs must be unique");
  });

  it("rejects malformed persisted state", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-catalog-malformed-"));
    await writeFile(join(state, "catalog-sources.json"), "not-json", "utf8");
    await expect(readCatalogSources(state)).rejects.toBeInstanceOf(Error);
  });
});
