import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, scanPortfolio } from "../src/index.js";

describe("adversarial filesystem inputs", () => {
  it("ignores a missing root", async () => {
    await expect(
      discoverSkills([
        {
          path: join(tmpdir(), "definitely-missing-steward-root"),
          scope: "unknown",
          visibleTo: ["unknown"]
        }
      ])
    ).resolves.toEqual([]);
  });

  it("does not recurse into a symlink loop inside a skill", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-symlink-"));
    const root = join(base, "skills");
    const skill = join(root, "safe");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: safe\ndescription: Safe skill\n---\n"
    );
    await symlink(
      base,
      join(skill, "loop"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const report = await scanPortfolio([
      { path: root, scope: "project", visibleTo: ["agents"] }
    ]);

    expect(report.skills[0]?.files.map((file) => file.relativePath)).toEqual([
      "SKILL.md"
    ]);
  });
});
