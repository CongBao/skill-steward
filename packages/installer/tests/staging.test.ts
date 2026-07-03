import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
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
    await expect(access(preview.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists private strict metadata for another registry instance", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-persistent-staging-"));
    const first = new StagingRegistry({
      stateDirectory,
      now: () => 1_000,
      id: () => "preview-cross-process"
    });
    const preview = await first.create({ ttlMs: 60_000 });
    const metadataPath = join(preview.directory, "preview.json");

    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
      version: 1,
      id: "preview-cross-process",
      createdAt: 1_000,
      expiresAt: 61_000
    });
    expect((await stat(join(stateDirectory, "staging"))).mode & 0o777).toBe(0o700);
    expect((await stat(preview.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);

    const second = new StagingRegistry({ stateDirectory, now: () => 2_000 });
    await expect(second.resolve(preview.id)).resolves.toEqual(preview);
    await second.expire(preview.id);
    await expect(access(preview.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires a persisted preview from a new instance after its deadline", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-persistent-expiry-"));
    const preview = await new StagingRegistry({
      stateDirectory,
      now: () => 10,
      id: () => "preview-expired"
    }).create({ ttlMs: 10 });

    const later = new StagingRegistry({ stateDirectory, now: () => 21 });
    await expect(later.resolve(preview.id)).rejects.toMatchObject({
      code: "PREVIEW_EXPIRED"
    });
    await expect(access(preview.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe ids without touching paths outside staging", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-unsafe-staging-id-"));
    const outside = join(dirname(stateDirectory), "steward-staging-outside-sentinel");
    await writeFile(outside, "keep", "utf8");
    const registry = new StagingRegistry({
      stateDirectory,
      id: () => "../../steward-staging-outside-sentinel"
    });

    await expect(registry.create({ ttlMs: 100 })).rejects.toMatchObject({
      code: "INVALID_PREVIEW_ID"
    });
    await expect(registry.resolve("../steward-staging-outside-sentinel")).rejects.toMatchObject({
      code: "INVALID_PREVIEW_ID"
    });
    await expect(registry.expire("../steward-staging-outside-sentinel")).rejects.toMatchObject({
      code: "INVALID_PREVIEW_ID"
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
    await rm(outside);
  });

  it.each(["root", "preview", "metadata"] as const)(
    "refuses a symlinked %s path and preserves its target",
    async (kind) => {
      const base = await mkdtemp(join(tmpdir(), `steward-symlink-${kind}-`));
      const stateDirectory = join(base, "state");
      const stagingRoot = join(stateDirectory, "staging");
      const previewDirectory = join(stagingRoot, "preview-link");
      const target = join(base, "target");
      await mkdir(stateDirectory);
      await mkdir(target);
      await writeFile(join(target, "sentinel"), "keep", "utf8");

      if (kind === "root") {
        await symlink(target, stagingRoot);
      } else {
        await mkdir(stagingRoot);
        if (kind === "preview") {
          await symlink(target, previewDirectory);
        } else {
          await mkdir(previewDirectory);
          await writeFile(join(target, "metadata"), JSON.stringify({
            version: 1,
            id: "preview-link",
            createdAt: 1,
            expiresAt: 10
          }));
          await symlink(join(target, "metadata"), join(previewDirectory, "preview.json"));
        }
      }

      const registry = new StagingRegistry({ stateDirectory, now: () => 2 });
      await expect(registry.resolve("preview-link")).rejects.toMatchObject({
        code: "UNSAFE_PREVIEW_STATE"
      });
      await expect(registry.expire("preview-link")).rejects.toMatchObject({
        code: "UNSAFE_PREVIEW_STATE"
      });
      await expect(readFile(join(target, "sentinel"), "utf8")).resolves.toBe("keep");
    }
  );

  it("refuses tampered, non-file, and identity-mismatched metadata", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-tampered-staging-"));
    const registry = new StagingRegistry({
      stateDirectory,
      now: () => 1,
      id: () => "preview-tampered"
    });
    const preview = await registry.create({ ttlMs: 100 });
    const metadataPath = join(preview.directory, "preview.json");
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      id: "different-preview",
      createdAt: 1,
      expiresAt: 101,
      directory: "/tmp/untrusted"
    }), "utf8");

    const fresh = new StagingRegistry({ stateDirectory, now: () => 2 });
    await expect(fresh.resolve(preview.id)).rejects.toMatchObject({
      code: "INVALID_PREVIEW_METADATA"
    });
    await expect(fresh.expire(preview.id)).rejects.toMatchObject({
      code: "INVALID_PREVIEW_METADATA"
    });
    await expect(access(preview.directory)).resolves.toBeUndefined();

    await rm(metadataPath);
    await mkdir(metadataPath);
    expect((await lstat(metadataPath)).isDirectory()).toBe(true);
    await expect(fresh.resolve(preview.id)).rejects.toMatchObject({
      code: "UNSAFE_PREVIEW_STATE"
    });
  });

  it("bounded cleanup removes only expired strict previews across instances", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-staging-cleanup-"));
    const ids = ["preview-live", "preview-expired", "preview-invalid"];
    let now = 100;
    const writer = new StagingRegistry({
      stateDirectory,
      now: () => now,
      id: () => ids.shift() ?? "unexpected-preview"
    });
    const live = await writer.create({ ttlMs: 100 });
    const expired = await writer.create({ ttlMs: 10 });
    const invalid = await writer.create({ ttlMs: 100 });
    await writeFile(join(invalid.directory, "preview.json"), JSON.stringify({
      version: 1,
      id: invalid.id,
      createdAt: 100,
      expiresAt: 200,
      extra: true
    }));
    const unrelated = join(stateDirectory, "staging", "unrelated.folder");
    await mkdir(unrelated);
    now = 150;

    const cleaner = new StagingRegistry({ stateDirectory, now: () => now });
    await expect(cleaner.cleanupExpired()).resolves.toBe(1);
    await expect(cleaner.resolve(live.id)).resolves.toEqual(live);
    await expect(access(expired.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(invalid.directory)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it("shared cleanup claims an expired preview at most once", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-shared-cleanup-"));
    const expired = await new StagingRegistry({
      stateDirectory,
      now: () => 100,
      id: () => "preview-shared-expired"
    }).create({ ttlMs: 10 });
    const first = new StagingRegistry({ stateDirectory, now: () => 200 });
    const second = new StagingRegistry({ stateDirectory, now: () => 200 });

    const removed = await Promise.all([
      first.cleanupExpired(),
      second.cleanupExpired()
    ]);
    expect(removed.reduce((total, count) => total + count, 0)).toBe(1);
    await expect(access(expired.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an old tombstone whose metadata is invalid", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-invalid-tombstone-"));
    const root = join(stateDirectory, "staging");
    const tombstone = join(
      root,
      ".expired-preview-invalid-1000-48fd7ba6-3ab0-4d20-98ca-b20a1519ce5d"
    );
    await mkdir(tombstone, { recursive: true });
    await writeFile(join(tombstone, "preview.json"), JSON.stringify({
      version: 1,
      id: "another-preview",
      createdAt: 1,
      expiresAt: 2,
      unexpected: true
    }));

    await expect(new StagingRegistry({
      stateDirectory,
      now: () => 2 * 60 * 60 * 1_000
    }).cleanupExpired()).resolves.toBe(0);
    await expect(access(tombstone)).resolves.toBeUndefined();
  });

  it("does not let thousands of unrelated entries consume the candidate budget", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-cleanup-budget-"));
    const root = join(stateDirectory, "staging");
    await mkdir(root);
    for (let start = 0; start < 5_000; start += 250) {
      await Promise.all(Array.from({ length: 250 }, (_value, offset) =>
        writeFile(join(root, `.unrelated-${start + offset}`), "ignore")
      ));
    }
    const expired = await new StagingRegistry({
      stateDirectory,
      now: () => 100,
      id: () => "zzzz-expired-after-unrelated"
    }).create({ ttlMs: 10 });
    const cleaner = new StagingRegistry({ stateDirectory, now: () => 200 });

    let removed = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      removed += await cleaner.cleanupExpired();
      if (removed > 0) break;
    }
    expect(removed).toBe(1);
    await expect(access(expired.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when cleanup sees an unsafe staging root", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cleanup-root-link-"));
    const stateDirectory = join(base, "state");
    const target = join(base, "target");
    await mkdir(stateDirectory);
    await mkdir(target);
    await symlink(target, join(stateDirectory, "staging"));

    await expect(new StagingRegistry({ stateDirectory }).cleanupExpired())
      .rejects.toMatchObject({ code: "UNSAFE_PREVIEW_STATE" });
    await expect(access(target)).resolves.toBeUndefined();
  });
});
