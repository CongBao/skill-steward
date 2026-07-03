import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHarnessRoot,
  standardRootCatalog
} from "../src/root-catalog.js";

describe("harness root catalog", () => {
  const home = join("home", "alice");
  const cwd = join("repo");

  it("uses official shared and product-specific destinations", () => {
    expect(
      resolveHarnessRoot({ harness: "codex", scope: "global", home, workspace: cwd })
    ).toBe(join(home, ".agents", "skills"));
    expect(
      resolveHarnessRoot({ harness: "codex", scope: "project", home, workspace: cwd })
    ).toBe(join(cwd, ".agents", "skills"));
    expect(
      resolveHarnessRoot({ harness: "claude", scope: "global", home, workspace: cwd })
    ).toBe(join(home, ".claude", "skills"));
    expect(
      resolveHarnessRoot({ harness: "github-copilot", scope: "global", home, workspace: cwd })
    ).toBe(join(home, ".copilot", "skills"));
    expect(
      resolveHarnessRoot({ harness: "github-copilot", scope: "project", home, workspace: cwd })
    ).toBe(join(cwd, ".github", "skills"));
  });

  it("requires a workspace for project installation", () => {
    expect(() =>
      resolveHarnessRoot({ harness: "claude", scope: "project", home })
    ).toThrow("workspace");
  });

  it("coalesces shared roots and declares all visible harnesses", () => {
    const roots = standardRootCatalog({ home, cwd });
    const sharedGlobal = roots.find(
      ({ path, scope }) => path === join(home, ".agents", "skills") && scope === "global"
    );
    const copilotGlobal = roots.find(
      ({ path, scope }) => path === join(home, ".copilot", "skills") && scope === "global"
    );

    expect(sharedGlobal?.visibleTo).toEqual(
      expect.arrayContaining(["agents", "codex", "github-copilot"])
    );
    expect(copilotGlobal?.visibleTo).toEqual(["github-copilot"]);
    expect(new Set(roots.map(({ path, scope }) => `${scope}:${path}`)).size).toBe(
      roots.length
    );
  });
});
