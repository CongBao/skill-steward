import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessIdSchema } from "../src/domain.js";
import { standardRoots } from "../src/discover.js";
import { openSpecToolDirectories } from "../src/tool-catalog.js";

const expected = [
  ["amazon-q", ".amazonq/skills"],
  ["antigravity", ".agent/skills"],
  ["auggie", ".augment/skills"],
  ["bob", ".bob/skills"],
  ["claude", ".claude/skills"],
  ["cline", ".cline/skills"],
  ["codebuddy", ".codebuddy/skills"],
  ["codex", ".codex/skills"],
  ["forgecode", ".forge/skills"],
  ["continue", ".continue/skills"],
  ["costrict", ".cospec/skills"],
  ["crush", ".crush/skills"],
  ["cursor", ".cursor/skills"],
  ["factory", ".factory/skills"],
  ["gemini", ".gemini/skills"],
  ["github-copilot", ".github/skills"],
  ["iflow", ".iflow/skills"],
  ["junie", ".junie/skills"],
  ["kilocode", ".kilocode/skills"],
  ["kimi", ".kimi/skills"],
  ["kiro", ".kiro/skills"],
  ["lingma", ".lingma/skills"],
  ["vibe", ".vibe/skills"],
  ["opencode", ".opencode/skills"],
  ["pi", ".pi/skills"],
  ["qoder", ".qoder/skills"],
  ["qwen", ".qwen/skills"],
  ["roocode", ".roo/skills"],
  ["trae", ".trae/skills"],
  ["windsurf", ".windsurf/skills"]
] as const;

describe("OpenSpec tool directory catalog", () => {
  it("matches all 30 tool skill directories in the reference", () => {
    expect(
      openSpecToolDirectories.map(({ id, skillDirectory }) => [
        id,
        skillDirectory
      ])
    ).toEqual(expected);
    expect(new Set(openSpecToolDirectories.map(({ id }) => id)).size).toBe(30);
  });

  it("registers every tool as a valid harness and scans home and project roots", () => {
    const home = join("home", "alice");
    const cwd = join("repo");
    const roots = standardRoots({ home, cwd });

    for (const [id, relativeDirectory] of expected) {
      expect(harnessIdSchema.safeParse(id).success).toBe(true);
      expect(roots).toContainEqual({
        path: join(home, relativeDirectory),
        scope: "global",
        visibleTo: [id]
      });
      expect(roots).toContainEqual({
        path: join(cwd, relativeDirectory),
        scope: "project",
        visibleTo: [id]
      });
    }
  });
});
