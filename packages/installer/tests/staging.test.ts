import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { installationSourceSchema } from "../src/domain.js";
import { StagingRegistry } from "../src/staging.js";

describe("installation source", () => {
  it("accepts folder, ZIP, and credential-free public HTTPS Git sources", () => {
    expect(installationSourceSchema.parse({ kind: "folder", label: "review" })).toEqual({
      kind: "folder",
      label: "review"
    });
    expect(installationSourceSchema.parse({ kind: "zip", fileName: "skills.zip" })).toEqual({
      kind: "zip",
      fileName: "skills.zip"
    });
    expect(
      installationSourceSchema.parse({
        kind: "git",
        url: "https://github.com/example/skills.git",
        ref: "v1",
        subdirectory: "skills/review"
      })
    ).toMatchObject({ kind: "git", ref: "v1" });
  });

  it("rejects SSH, embedded credentials, and traversal subdirectories", () => {
    for (const source of [
      { kind: "git", url: "ssh://git@example.com/repo" },
      { kind: "git", url: "https://token@example.com/repo" },
      { kind: "git", url: "https://example.com/repo", subdirectory: "../secret" }
    ]) {
      expect(() => installationSourceSchema.parse(source)).toThrow();
    }
  });
});

describe("StagingRegistry", () => {
  it("creates random contained preview directories and resolves them before expiry", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-staging-"));
    const registry = new StagingRegistry({ stateDirectory, now: () => 1_000 });
    const first = await registry.create({ ttlMs: 60_000 });
    const second = await registry.create({ ttlMs: 60_000 });

    expect(first.id).not.toBe(second.id);
    expect(isAbsolute(first.directory)).toBe(true);
    expect(relative(stateDirectory, first.directory)).not.toMatch(/^\.\./);
    await expect(registry.resolve(first.id)).resolves.toEqual(first);
  });

  it("expires and removes previews", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-expiry-"));
    let now = 1_000;
    const registry = new StagingRegistry({ stateDirectory, now: () => now });
    const preview = await registry.create({ ttlMs: 100 });
    now = 1_101;

    await expect(registry.resolve(preview.id)).rejects.toMatchObject({
      code: "PREVIEW_EXPIRED"
    });
  });
});
