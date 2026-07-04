import { type Stats } from "node:fs";
import { lstat, open, opendir, readdir, rename, writeFile } from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompanionManifestError,
  inspectCompanionTree
} from "../src/companion-manifest.js";

async function fixture(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "steward-companion-manifest-"));
  const root = join(base, "skill");
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "skill\n", "utf8");
  await writeFile(join(root, "references", "guide.md"), "guide\n", "utf8");
  await chmod(root, 0o700);
  await chmod(join(root, "references"), 0o750);
  await chmod(join(root, "SKILL.md"), 0o600);
  await chmod(join(root, "references", "guide.md"), 0o640);
  return { base, root };
}

function directoryHandle(names: string[], onRead?: (count: number) => void) {
  let index = 0;
  return {
    async read() {
      onRead?.(index + 1);
      if (index >= names.length) return null;
      const name = names[index]!;
      index += 1;
      return { name };
    },
    async close() {}
  };
}

describe("inspectCompanionTree", () => {
  it("produces a stable every-entry manifest with content, size, and POSIX mode", async () => {
    const { base, root } = await fixture();
    const first = await inspectCompanionTree(root, { boundary: base, platform: "linux" });
    const second = await inspectCompanionTree(root, { boundary: base, platform: "linux" });

    expect(first).toEqual(second);
    expect(first.entries.map(({ relativePath }) => relativePath)).toEqual([
      ".",
      "SKILL.md",
      "references",
      "references/guide.md"
    ]);
    expect(first.entries).toContainEqual(expect.objectContaining({
      relativePath: "SKILL.md",
      kind: "file",
      bytes: 6,
      securityMode: "posix:0600",
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }));
  });

  it("changes identity for extra, missing, content, and mode drift", async () => {
    const { base, root } = await fixture();
    const initial = await inspectCompanionTree(root, { boundary: base, platform: "linux" });
    await writeFile(join(root, "extra.txt"), "extra", "utf8");
    const extra = await inspectCompanionTree(root, { boundary: base, platform: "linux" });
    await rm(join(root, "extra.txt"));
    await rm(join(root, "references", "guide.md"));
    const missing = await inspectCompanionTree(root, { boundary: base, platform: "linux" });
    await writeFile(join(root, "SKILL.md"), "changed\n", "utf8");
    const content = await inspectCompanionTree(root, { boundary: base, platform: "linux" });
    await chmod(join(root, "SKILL.md"), 0o644);
    const mode = await inspectCompanionTree(root, { boundary: base, platform: "linux" });

    expect(new Set([
      initial.fingerprint,
      extra.fingerprint,
      missing.fingerprint,
      content.fingerprint,
      mode.fingerprint
    ]).size).toBe(5);
  });

  it("rejects symlinks and linked ancestors without traversing them", async () => {
    const { base, root } = await fixture();
    const outside = join(base, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(root, "linked.txt"));
    await expect(inspectCompanionTree(root, { boundary: base })).rejects.toMatchObject({
      code: "COMPANION_TREE_UNSAFE"
    });

    const physical = join(base, "physical");
    await mkdir(join(physical, "skill"), { recursive: true });
    await writeFile(join(physical, "skill", "SKILL.md"), "skill", "utf8");
    const linkedParent = join(base, "linked-parent");
    await symlink(physical, linkedParent);
    await expect(inspectCompanionTree(join(linkedParent, "skill"), {
      boundary: base
    })).rejects.toMatchObject({ code: "COMPANION_TREE_UNSAFE" });
  });

  it("fails closed on Windows without a native reparse detector", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      platform: "win32"
    })).rejects.toMatchObject({ code: "COMPANION_TREE_UNPROVABLE" });
  });

  it("detects a Win32 root replacement between availability samples", async () => {
    const { base, root } = await fixture();
    const moved = `${root}-initial`;
    let rootSamples = 0;
    await expect(inspectCompanionTree(root, {
      boundary: base,
      platform: "win32",
      lstatPath: async (path) => {
        const metadata = await lstat(path);
        if (path === root) {
          rootSamples += 1;
          if (rootSamples === 1) {
            await rename(root, moved);
            await mkdir(root);
            await writeFile(join(root, "SKILL.md"), "replacement\n", "utf8");
          }
        }
        return metadata;
      }
    })).rejects.toMatchObject({ code: "COMPANION_TREE_CHANGED" });
    expect(rootSamples).toBe(2);
  });

  it("rejects injected Windows reparse points and normalizes Windows modes", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      platform: "win32",
      isReparsePoint: (path) => basename(path) === "SKILL.md"
    })).rejects.toMatchObject({ code: "COMPANION_TREE_UNSAFE" });

    const manifest = await inspectCompanionTree(root, {
      boundary: base,
      platform: "win32",
      isReparsePoint: () => false
    });
    expect(manifest.platform).toBe("win32");
    expect(manifest.entries.every(({ securityMode }) =>
      securityMode === "win32:writable" || securityMode === "win32:readonly"
    )).toBe(true);
  });

  it("rejects a linked boundary before traversing its child", async () => {
    const { base, root } = await fixture();
    const linkedBoundary = `${base}-linked`;
    await symlink(base, linkedBoundary);
    let opened = 0;
    await expect(inspectCompanionTree(join(linkedBoundary, basename(root)), {
      boundary: linkedBoundary,
      openFile: async (path, flags) => {
        opened += 1;
        return open(path, flags);
      }
    })).rejects.toMatchObject({ code: "COMPANION_TREE_UNSAFE" });
    expect(opened).toBe(0);
  });

  it("rejects a boundary renamed to an outside symlink after its first lstat", async () => {
    const { base } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "steward-companion-outside-boundary-"));
    await mkdir(join(outside, "skill"));
    await writeFile(join(outside, "skill", "secret.txt"), "outside", "utf8");
    const moved = `${base}-moved`;
    let swapped = false;
    let opened = 0;
    await expect(inspectCompanionTree(join(base, "skill"), {
      boundary: base,
      lstatPath: async (path) => {
        const metadata = await lstat(path);
        if (path === base && !swapped) {
          swapped = true;
          await rename(base, moved);
          await symlink(outside, base);
        }
        return metadata;
      },
      openFile: async (path, flags) => {
        opened += 1;
        return open(path, flags);
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^COMPANION_TREE_(CHANGED|UNSAFE)$/)
    });
    expect(opened).toBe(0);
  });

  it("rejects a root renamed to an outside symlink after its first lstat", async () => {
    const { base, root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "steward-companion-outside-root-"));
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    const moved = `${root}-moved`;
    let swapped = false;
    let opened = 0;
    await expect(inspectCompanionTree(root, {
      boundary: base,
      lstatPath: async (path) => {
        const metadata = await lstat(path);
        if (path === root && !swapped) {
          swapped = true;
          await rename(root, moved);
          await symlink(outside, root);
        }
        return metadata;
      },
      openFile: async (path, flags) => {
        opened += 1;
        return open(path, flags);
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^COMPANION_TREE_(CHANGED|UNSAFE)$/)
    });
    expect(opened).toBe(0);
  });

  it("rejects a child directory swapped to an outside symlink before content read", async () => {
    const { base, root } = await fixture();
    const child = join(root, "references");
    const outside = await mkdtemp(join(tmpdir(), "steward-companion-outside-child-"));
    await writeFile(join(outside, "guide.md"), "outside", "utf8");
    const moved = `${child}-moved`;
    let swapped = false;
    let opened = 0;
    await expect(inspectCompanionTree(root, {
      boundary: base,
      lstatPath: async (path) => {
        const metadata = await lstat(path);
        if (path === child && !swapped) {
          swapped = true;
          await rename(child, moved);
          await symlink(outside, child);
        }
        return metadata;
      },
      openFile: async (path, flags) => {
        opened += 1;
        return open(path, flags);
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^COMPANION_TREE_(CHANGED|UNSAFE)$/)
    });
    expect(opened).toBe(1);
  });

  it("rejects a child ancestor swapped midway through directory enumeration", async () => {
    const { base, root } = await fixture();
    const child = join(root, "references");
    const outside = await mkdtemp(join(tmpdir(), "steward-companion-midscan-child-"));
    await writeFile(join(outside, "guide.md"), "outside", "utf8");
    const moved = `${child}-moved`;
    let swapped = false;
    let opened = 0;
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => {
        const handle = await opendir(path);
        if (path !== child) return handle;
        return {
          async read() {
            const entry = await handle.read();
            if (!swapped) {
              swapped = true;
              await rename(child, moved);
              await symlink(outside, child);
            }
            return entry;
          },
          async close() { await handle.close(); }
        };
      },
      openFile: async (path, flags) => {
        opened += 1;
        return open(path, flags);
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^COMPANION_TREE_(CHANGED|UNSAFE)$/)
    });
    expect(opened).toBe(1);
  });

  it("detects an entry added after the first bounded enumeration", async () => {
    const { base, root } = await fixture();
    let rootEnumerations = 0;
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => {
        if (path === root) {
          rootEnumerations += 1;
          if (rootEnumerations === 2) {
            await writeFile(join(root, "late.txt"), "late", "utf8");
          }
        }
        return opendir(path);
      }
    })).rejects.toMatchObject({ code: "COMPANION_TREE_CHANGED" });
    expect(rootEnumerations).toBe(2);
  });

  it("stops directory I/O at maxEntries plus one", async () => {
    const { base, root } = await fixture();
    let reads = 0;
    const names = Array.from({ length: 600 }, (_, index) => `entry-${String(index).padStart(3, "0")}`);
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => path === root
        ? directoryHandle(names, (count) => { reads = count; })
        : opendir(path)
    })).rejects.toMatchObject({ code: "COMPANION_TREE_TRUNCATED" });
    expect(reads).toBe(513);
  });

  it("rejects special filesystem entries", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => path === root
        ? directoryHandle([...await readdir(path), "special-entry"])
        : opendir(path),
      lstatPath: async (path) => basename(path) === "special-entry"
        ? {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false
          } as Stats
        : lstat(path)
    })).rejects.toMatchObject({ code: "COMPANION_TREE_UNSAFE" });
  });

  it("rejects case and Unicode-normalization collisions before opening the alias", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => path === root
        ? directoryHandle(["SKILL.md", "skill.md"])
        : opendir(path)
    })).rejects.toMatchObject({ code: "COMPANION_TREE_COLLISION" });
  });

  it("reports duplicate enumerations as a typed collision", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async (path) => path === root
        ? directoryHandle(["SKILL.md", "SKILL.md"])
        : opendir(path)
    })).rejects.toMatchObject({ code: "COMPANION_TREE_COLLISION" });
  });

  it("rechecks file identity after open and before reading content", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openFile: async (path, flags) => {
        if (basename(path) === "SKILL.md") {
          await writeFile(path, "changed after metadata validation\n", "utf8");
        }
        return open(path, flags);
      }
    })).rejects.toMatchObject({ code: "COMPANION_TREE_CHANGED" });
  });

  it.each([
    { limits: { maxEntries: 1 }, label: "entry" },
    { limits: { maxFileBytes: 2 }, label: "file-byte" },
    { limits: { maxTotalBytes: 4 }, label: "total-byte" },
    { limits: { maxDepth: 0 }, label: "depth" }
  ])("reports $label bounds as typed truncation", async ({ limits }) => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, { boundary: base, limits }))
      .rejects.toMatchObject({ code: "COMPANION_TREE_TRUNCATED" });
  });

  it("does not permit callers to expand the security bounds", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(root, {
      boundary: base,
      limits: { maxEntries: 513 }
    })).rejects.toMatchObject({ code: "COMPANION_TREE_TRUNCATED" });
  });

  it("distinguishes missing and I/O failures", async () => {
    const { base, root } = await fixture();
    await expect(inspectCompanionTree(join(base, "missing"), { boundary: base }))
      .rejects.toMatchObject({ code: "COMPANION_TREE_MISSING" });
    await expect(inspectCompanionTree(root, {
      boundary: base,
      openDirectory: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
    })).rejects.toEqual(expect.objectContaining({
      code: "COMPANION_TREE_IO"
    }));
  });

  it("exports a typed error class for fail-closed callers", () => {
    expect(new CompanionManifestError("COMPANION_TREE_UNSAFE", "unsafe"))
      .toMatchObject({ code: "COMPANION_TREE_UNSAFE" });
  });
});
