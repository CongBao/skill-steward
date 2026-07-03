import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installationRouteSchema,
  resolveInstallDestination,
  resolveVerifiedInstallDestination
} from "../src/destination.js";

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

  it("strictly validates persisted routes and resolves them from the current home", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-route-"));
    const route = {
      harness: "github-copilot",
      scope: "project",
      targetName: "review",
      workspace: base
    };
    expect(installationRouteSchema.parse(route)).toEqual(route);
    expect(installationRouteSchema.safeParse({ ...route, extra: true }).success).toBe(false);
    expect(installationRouteSchema.safeParse({ ...route, harness: "unknown" }).success).toBe(false);
    await expect(resolveVerifiedInstallDestination({ route, home: base })).resolves.toEqual({
      root: join(base, ".github", "skills"),
      target: join(base, ".github", "skills", "review")
    });
  });

  it.each(["symlink", "file"] as const)(
    "rejects an existing %s in the route from anchor to destination parent",
    async (kind) => {
      const base = await mkdtemp(join(tmpdir(), `steward-route-${kind}-`));
      const outside = join(base, "outside");
      await mkdir(outside);
      const agents = join(base, ".agents");
      if (kind === "symlink") await symlink(outside, agents, "dir");
      else await writeFile(agents, "not a directory");

      await expect(resolveVerifiedInstallDestination({
        home: base,
        route: {
          harness: "codex",
          scope: "global",
          targetName: "review",
          workspace: base
        }
      })).rejects.toMatchObject({ code: "UNSAFE_INSTALL_DESTINATION" });
    }
  );
});
