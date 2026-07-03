import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkill } from "../src/parse-skill.js";

describe("parseSkill", () => {
  it("parses frontmatter and fingerprints every regular bundle file", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-parse-"));
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "---\nname: review\ndescription: Review code changes\n---\nUse the checklist.\n");
    await writeFile(join(root, "references", "checklist.md"), "first");

    const first = await parseSkill({
      path: root,
      roots: [{ path: root, scope: "project", visibleTo: ["agents"] }]
    });
    await writeFile(join(root, "references", "checklist.md"), "second");
    const second = await parseSkill({
      path: root,
      roots: [{ path: root, scope: "project", visibleTo: ["agents"] }]
    });

    expect(first.name).toBe("review");
    expect(first.visibleTo).toEqual(["agents"]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.files.map((file) => file.relativePath)).toEqual([
      "SKILL.md",
      "references/checklist.md"
    ]);
  });

  it("does not follow symlinks inside a skill bundle", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-parse-link-"));
    const root = join(base, "skill");
    await mkdir(root);
    await writeFile(join(root, "SKILL.md"), "---\nname: safe\ndescription: Safe skill\n---\n");
    await symlink(base, join(root, "loop"), process.platform === "win32" ? "junction" : "dir");

    const parsed = await parseSkill({ path: root, roots: [] });

    expect(parsed.files.map((file) => file.relativePath)).toEqual(["SKILL.md"]);
  });

  it("excludes dependency, VCS, cache, and build directories from a bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-parse-generated-"));
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: lean\ndescription: Lean skill\n---\n"
    );
    const generatedDirectories = [
      ".git",
      ".venv",
      "venv",
      "node_modules",
      "__pycache__",
      ".pytest_cache",
      "coverage",
      "dist",
      "build",
      "target"
    ];
    for (const directory of generatedDirectories) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "generated.bin"), "generated");
    }
    await mkdir(join(root, "references"));
    await writeFile(join(root, "references", "kept.md"), "kept");

    const parsed = await parseSkill({ path: root, roots: [] });

    expect(parsed.files.map((file) => file.relativePath)).toEqual([
      "SKILL.md",
      "references/kept.md"
    ]);
  });

  it("rejects missing required frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-invalid-"));
    await writeFile(join(root, "SKILL.md"), "# Missing frontmatter\n");

    await expect(parseSkill({ path: root, roots: [] })).rejects.toThrow("frontmatter");
  });
});
