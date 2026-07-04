import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createDashboardServices } from "../src/services.js";
import type { DashboardServices } from "../src/services.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestReport } from "@skill-steward/store";
import { report, snapshot } from "./fixtures.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

function services(): DashboardServices {
  return {
    dashboard: vi.fn(async () => snapshot),
    latestReport: vi.fn(async () => report),
    scan: vi.fn(async () => snapshot),
    history: vi.fn(async () => []),
    roots: vi.fn(async () => [{
      harness: "agents" as const,
      visibleTo: ["agents" as const, "codex" as const, "github-copilot" as const],
      scope: "global" as const,
      path: "/home/.agents/skills",
      available: true,
      readable: true,
      skillCount: 2
    }]),
    labelFinding: vi.fn(async () => undefined)
  };
}

describe("portfolio read routes", () => {
  const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("returns dashboard, Skill, finding, history, and roots envelopes", async () => {
    const { app } = createDashboardApp({ mutationToken: "token", services: services() });
    apps.push(app);

    expect((await app.inject({ url: "/api/v1/dashboard" })).json().data).toEqual(snapshot);
    expect((await app.inject({ url: "/api/v1/skills/skill-1" })).json().data).toMatchObject({
      id: "skill-1",
      name: "review"
    });
    expect((await app.inject({ url: "/api/v1/findings/finding-1" })).json().data).toMatchObject({
      id: "finding-1",
      evidence: ["missing.md"]
    });
    expect((await app.inject({ url: "/api/v1/history" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/roots" })).json().data[0]).toMatchObject({
      harness: "agents",
      visibleTo: ["agents", "codex", "github-copilot"]
    });
  });

  it("returns stable 404s and validates finding labels", async () => {
    const service = services();
    const { app } = createDashboardApp({ mutationToken: "token", services: service });
    apps.push(app);

    expect((await app.inject({ url: "/api/v1/skills/missing" })).json()).toMatchObject({
      error: { code: "SKILL_NOT_FOUND" }
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/findings/finding-1/labels",
          headers: { "x-skill-steward-token": "token" },
          payload: { label: "incorrect", comment: "false positive" }
        })
      ).statusCode
    ).toBe(200);
    expect(service.labelFinding).toHaveBeenCalledWith(
      "finding-1",
      "incorrect",
      "false positive"
    );
  });

  it("uses native inventory only for default dashboard scans", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-dashboard-services-native-"));
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const customRoot = join(base, "custom");
    const customSkill = join(customRoot, "custom-review");
    await installNativeCodexFixture(home);
    await mkdir(customSkill, { recursive: true });
    await writeFile(
      join(customSkill, "SKILL.md"),
      "---\nname: custom-review\ndescription: Review custom changes\n---\n"
    );
    const service = createDashboardServices({
      stateDirectory,
      home,
      cwd: base,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    await service.scan([]);
    const nativeReport = await readLatestReport(stateDirectory);
    expect(nativeReport).toMatchObject({
      schemaVersion: 2,
      skills: [expect.objectContaining({
        name: "native-review",
        ownership: "native-plugin"
      })],
      inventory: {
        harnesses: expect.arrayContaining([
          expect.objectContaining({ harness: "codex", status: "verified" })
        ])
      }
    });
    const { app } = createDashboardApp({ mutationToken: "token", services: service });
    apps.push(app);
    const dashboardInventory = (await app.inject({ url: "/api/v1/dashboard" })).json().data.inventory;
    expect(dashboardInventory).toEqual(
      nativeReport?.schemaVersion === 2 ? nativeReport.inventory : null
    );
    expect(dashboardInventory.sources.length).toBeGreaterThan(6);

    await service.scan([customRoot]);
    const custom = await readLatestReport(stateDirectory);
    expect(custom).toMatchObject({
      schemaVersion: 2,
      skills: [expect.objectContaining({ name: "custom-review" })]
    });
    expect(custom?.skills).not.toContainEqual(
      expect.objectContaining({ name: "native-review" })
    );
  });

  it("preserves the deprecated Harness and every alias when summarizing conventional roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-dashboard-root-aliases-"));
    const home = join(base, "home");
    const sharedRoot = join(home, ".agents", "skills");
    await mkdir(sharedRoot, { recursive: true });
    const service = createDashboardServices({
      stateDirectory: join(base, "state"),
      home,
      cwd: base
    });

    const roots = await service.roots();
    const shared = roots.find(({ path, scope }) => path === sharedRoot && scope === "global");

    expect(shared?.harness).toBe("agents");
    expect(shared?.visibleTo).toEqual(["agents", "codex", "github-copilot"]);
  });
});
