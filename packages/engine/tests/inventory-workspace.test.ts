import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceSearchBounds,
  discoverNestedClaudeSkillRoots,
  discoverNestedClaudeSkillRootsWithHooks,
  findRepositoryRoot,
  workspaceAncestors
} from "../src/inventory/workspace.js";

describe("repository-aware workspace roots", () => {
  it("uses the accepted workspace traversal limits", () => {
    expect(defaultWorkspaceSearchBounds).toEqual({
      maxDepth: 24,
      maxDirectories: 20_000
    });
  });

  it("treats a .git worktree file as the repository boundary", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-workspace-"));
    const repo = join(base, "repo");
    const packageRoot = join(repo, "packages", "app");
    const nestedCwd = join(packageRoot, "src");
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: ../git/worktrees/repo\n");

    await expect(findRepositoryRoot(nestedCwd)).resolves.toBe(resolve(repo));
    await expect(workspaceAncestors(nestedCwd)).resolves.toEqual([
      resolve(nestedCwd),
      resolve(packageRoot),
      resolve(repo, "packages"),
      resolve(repo)
    ]);
  });

  it("returns only the normalized cwd when no repository marker exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steward-no-repo-"));

    await expect(workspaceAncestors(cwd)).resolves.toEqual([resolve(cwd)]);
  });
});

describe("nested Claude root discovery", () => {
  it.each([
    ["maxDepth", Number.NaN],
    ["maxDepth", Number.POSITIVE_INFINITY],
    ["maxDepth", -1],
    ["maxDepth", 1.5],
    ["maxDirectories", Number.NaN],
    ["maxDirectories", Number.NEGATIVE_INFINITY],
    ["maxDirectories", -1],
    ["maxDirectories", 1.5]
  ] as const)(
    "rejects invalid workspace bound %s=%s before reading the root",
    async (field, value) => {
      const bounds = { maxDepth: 10, maxDirectories: 10 };
      bounds[field] = value;
      await expect(discoverNestedClaudeSkillRoots(
        join(tmpdir(), "must-not-be-read"),
        bounds
      )).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
    }
  );

  it("accepts a zero directory cap as immediate truncation", async () => {
    await expect(discoverNestedClaudeSkillRoots(
      join(tmpdir(), "must-not-be-read"),
      { maxDepth: 0, maxDirectories: 0 }
    )).resolves.toEqual({ paths: [], truncated: true, directoriesVisited: 0 });
  });

  it.each([
    ["maxDepth", 25],
    ["maxDirectories", 20_001]
  ] as const)(
    "rejects workspace hard-max overflow %s=%s before reading the root",
    async (field, value) => {
      const bounds = { maxDepth: 24, maxDirectories: 20_000 };
      bounds[field] = value;

      await expect(discoverNestedClaudeSkillRoots(
        join(tmpdir(), "must-not-be-read"),
        bounds
      )).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
    }
  );

  it("finds nested .claude/skills roots without entering ignored or symlinked directories", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-claude-roots-"));
    const rootSkills = join(repo, ".claude", "skills");
    const packageSkills = join(repo, "packages", "web", ".claude", "skills");
    const ignoredSkills = join(repo, "node_modules", "dependency", ".claude", "skills");
    const outside = join(await mkdtemp(join(tmpdir(), "steward-outside-")), ".claude", "skills");
    await mkdir(rootSkills, { recursive: true });
    await mkdir(packageSkills, { recursive: true });
    await mkdir(ignoredSkills, { recursive: true });
    await mkdir(outside, { recursive: true });
    if (process.platform !== "win32") {
      await symlink(join(outside, "..", ".."), join(repo, "linked-package"), "dir");
    }

    const result = await discoverNestedClaudeSkillRoots(repo);

    expect(result.paths).toEqual([
      await realpath(rootSkills),
      await realpath(packageSkills)
    ].sort());
    expect(result.truncated).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not traverse a symlinked .claude directory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-claude-symlink-"));
    const packageRoot = join(repo, "package");
    const outsideClaude = join(await mkdtemp(join(tmpdir(), "steward-claude-outside-")), ".claude");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(join(outsideClaude, "skills"), { recursive: true });
    await symlink(outsideClaude, join(packageRoot, ".claude"), "dir");

    const result = await discoverNestedClaudeSkillRoots(repo);

    expect(result.paths).toEqual([]);
  });

  it("does not descend into a discovered Skill bundle", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-skill-boundary-"));
    const bundle = join(repo, "bundle");
    const internal = join(bundle, "internal", ".claude", "skills");
    const sibling = join(repo, "sibling", ".claude", "skills");
    await mkdir(internal, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(
      join(bundle, "SKILL.md"),
      "---\nname: bundle\ndescription: Boundary\n---\n"
    );

    const result = await discoverNestedClaudeSkillRoots(repo);

    expect(result.paths).toEqual([await realpath(sibling)]);
  });

  it("reports truncation when the directory cap is reached", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-claude-cap-"));
    await mkdir(join(repo, "a", ".claude", "skills"), { recursive: true });
    await mkdir(join(repo, "b", ".claude", "skills"), { recursive: true });

    const result = await discoverNestedClaudeSkillRoots(repo, {
      maxDepth: 8,
      maxDirectories: 1
    });

    expect(result.truncated).toBe(true);
    expect(result.directoriesVisited).toBeLessThanOrEqual(1);
  });

  it("selects tight-cap roots by locale-independent code-unit order", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-workspace-order-"));
    for (const name of ["a", "Á", "B"]) {
      await mkdir(join(repo, name, ".claude", "skills"), { recursive: true });
    }

    const result = await discoverNestedClaudeSkillRoots(repo, {
      maxDepth: 2,
      maxDirectories: 3
    });

    expect(result.paths.map((path) => basename(dirname(dirname(path))))).toEqual([
      "B",
      "a"
    ]);
    expect(result.truncated).toBe(true);
    expect(result.directoriesVisited).toBe(3);
  });

  it("refuses a queued workspace child replaced by an escaping link", async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-workspace-replace-"));
    const target = join(repo, "queued-child");
    const moved = join(repo, "queued-child-original");
    const outside = await mkdtemp(join(tmpdir(), "steward-workspace-escape-"));
    await mkdir(join(target, ".claude", "skills"), { recursive: true });
    await mkdir(join(outside, ".claude", "skills"), { recursive: true });

    const physicalTarget = await realpath(target);
    let replaced = false;
    const result = await discoverNestedClaudeSkillRootsWithHooks(
      repo,
      defaultWorkspaceSearchBounds,
      {
        async onDirectoryQueued(path) {
          if (replaced) return;
          expect(path).toBe(physicalTarget);
          replaced = true;
          await rename(target, moved);
          await symlink(
            outside,
            target,
            process.platform === "win32" ? "junction" : "dir"
          );
        }
      }
    );

    expect(replaced).toBe(true);
    expect(result.paths).not.toContain(
      await realpath(join(outside, ".claude", "skills"))
    );
    expect(result.truncated).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "refuses an initially-present escaping workspace junction",
    async () => {
    const repo = await mkdtemp(join(tmpdir(), "steward-workspace-junction-"));
    const outside = await mkdtemp(
      join(tmpdir(), "steward-workspace-junction-outside-")
    );
    await mkdir(join(outside, ".claude", "skills"), { recursive: true });
    await symlink(outside, join(repo, "linked"), "junction");

    const result = await discoverNestedClaudeSkillRoots(repo);

    expect(result.paths).toEqual([]);
    }
  );
});
