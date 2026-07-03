import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import type { DashboardServices } from "../src/services.js";
import { report, snapshot } from "./fixtures.js";

function services(): DashboardServices {
  return {
    dashboard: vi.fn(async () => snapshot),
    latestReport: vi.fn(async () => report),
    scan: vi.fn(async () => snapshot),
    history: vi.fn(async () => []),
    roots: vi.fn(async () => []),
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
    expect((await app.inject({ url: "/api/v1/roots" })).statusCode).toBe(200);
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
});
