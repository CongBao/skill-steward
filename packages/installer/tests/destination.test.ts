import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstallDestination } from "../src/destination.js";

describe("resolveInstallDestination", () => {
  const home = join("home", "alice");
  const workspace = join("repo");

  it("resolves global and project targets through the shared harness catalog", () => {
    expect(
      resolveInstallDestination({
        harness: "claude",
        scope: "global",
        home,
        workspace,
        name: "review"
      })
    ).toEqual({
      root: join(home, ".claude", "skills"),
      target: join(home, ".claude", "skills", "review")
    });
    expect(
      resolveInstallDestination({
        harness: "codex",
        scope: "project",
        home,
        workspace,
        name: "review"
      }).target
    ).toBe(join(workspace, ".agents", "skills", "review"));
  });

  it("rejects unsafe names and project scope without a workspace", () => {
    for (const name of ["../review", "a/b", ".", "", "review skill"]) {
      expect(() =>
        resolveInstallDestination({
          harness: "claude",
          scope: "global",
          home,
          workspace,
          name
        })
      ).toThrow();
    }
    expect(() =>
      resolveInstallDestination({
        harness: "claude",
        scope: "project",
        home,
        name: "review"
      })
    ).toThrow("workspace");
  });
});
