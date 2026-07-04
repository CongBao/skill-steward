import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, standardRoots } from "../src/discover.js";

describe("standardRoots", () => {
  it("includes shared and harness-specific global and project roots", () => {
    const home = join("home", "alice");
    const cwd = join("repo");
    const roots = standardRoots({ home, cwd });

    expect(roots.map((root) => root.path)).toEqual(expect.arrayContaining([
      join(home, ".agents", "skills"),
      join(home, ".codex", "skills"),
      join(home, ".claude", "skills"),
      join(cwd, ".agents", "skills")
    ]));
  });
});

describe("discoverSkills", () => {
  it("deduplicates a physical skill exposed through two symlinked roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-discover-"));
    const source = join(base, "source", "review");
    const agentsRoot = join(base, "agents");
    const codexRoot = join(base, "codex");
    await mkdir(source, { recursive: true });
    await mkdir(agentsRoot, { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(source, join(agentsRoot, "review"), linkType);
    await symlink(source, join(codexRoot, "review"), linkType);

    const skills = await discoverSkills([
      { path: agentsRoot, scope: "global", visibleTo: ["agents"] },
      { path: codexRoot, scope: "global", visibleTo: ["codex"] }
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.roots.flatMap((root) => root.visibleTo).sort()).toEqual(["agents", "codex"]);
  });

  it("ignores missing roots", async () => {
    await expect(discoverSkills([
      { path: join(tmpdir(), "definitely-missing-skill-root"), scope: "unknown", visibleTo: ["unknown"] }
    ])).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves compatibility for a symlinked custom root", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-root-alias-"));
    const physicalRoot = join(base, "physical-root");
    const skill = join(physicalRoot, "review");
    const rootAlias = join(base, "root-alias");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
    await symlink(physicalRoot, rootAlias, "dir");

    const skills = await discoverSkills([
      { path: rootAlias, scope: "project", visibleTo: ["agents"] }
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.roots[0]?.path).toBe(rootAlias);
  });

  it.skipIf(process.platform === "win32")("preserves compatibility for a readable symlinked SKILL.md", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-marker-alias-"));
    const root = join(base, "skills");
    const skill = join(root, "review");
    const marker = join(base, "shared-SKILL.md");
    await mkdir(skill, { recursive: true });
    await writeFile(marker, "---\nname: review\ndescription: Review code\n---\n");
    await symlink(marker, join(skill, "SKILL.md"), "file");

    const skills = await discoverSkills([
      { path: root, scope: "project", visibleTo: ["agents"] }
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(await realpath(skill));
  });
});
