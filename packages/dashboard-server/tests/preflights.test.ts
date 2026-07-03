import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreflightResult } from "@skill-steward/preflight";
import { readPreflightEvidence } from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import {
  createPreflightServices,
  PreflightServiceError,
  type PreflightServices
} from "../src/preflight-services.js";
import { report } from "./fixtures.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function result(): PreflightResult {
  return {
    schemaVersion: 1,
    algorithmVersion: 1,
    id: "run-1",
    generatedAt: "2026-07-03T01:00:00.000Z",
    portfolioFingerprint: report.portfolioFingerprint,
    taskHash: `sha256:${"c".repeat(64)}`,
    taskCharacterCount: 33,
    taskTermCount: 4,
    selectedSkillIds: ["skill-1"],
    candidates: [
      {
        skillId: "skill-1",
        name: "review",
        description: "Review changes",
        scope: "global",
        visibleTo: ["claude"],
        relevance: 0.7,
        uniqueCoverage: 0.5,
        riskPenalty: 0.2,
        redundancyPenalty: 0,
        contextTokens: 100,
        decision: "selected",
        reasons: [
          { code: "TASK_TERM_MATCH", detail: "review, change" }
        ]
      }
    ],
    conflicts: report.findings,
    selectedContextTokens: 100,
    plausibleContextTokens: 100,
    estimatedContextSaved: 0
  };
}

describe("preflight services", () => {
  it("runs against a fresh portfolio and stores sanitized evidence", async () => {
    expect(createPreflightServices).toBeDefined();
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "steward-preflight-service-")
    );
    const currentPortfolio = vi.fn(async () => report);
    const services = createPreflightServices({
      stateDirectory,
      currentPortfolio,
      now: () => new Date("2026-07-03T01:00:00.000Z"),
      id: () => "run-1"
    });

    const output = await services.run({
      task: "PRIVATE review code security changes",
      maxSkills: 3
    });

    expect(currentPortfolio).toHaveBeenCalledOnce();
    expect(output.id).toBe("run-1");
    expect(await readPreflightEvidence(stateDirectory)).toHaveLength(1);
    expect(
      await readFile(join(stateDirectory, "preflights.json"), "utf8")
    ).not.toContain("PRIVATE review code security changes");
  });
});

describe("preflight routes", () => {
  it("requires the mutation token and returns a preflight result", async () => {
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi.fn(async () => undefined)
    };
    const { app } = createDashboardApp({
      mutationToken: "test-token",
      preflightServices: services
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/preflights",
      payload: { task: "Review security and missing tests", maxSkills: 3 }
    });
    expect(forbidden.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/preflights",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { task: "  Review security and missing tests  ", maxSkills: 3 }
    });
    expect(response.statusCode).toBe(200);
    expect(services.run).toHaveBeenCalledWith({
      task: "Review security and missing tests",
      maxSkills: 3
    });
    expect(response.json()).toMatchObject({
      data: { id: "run-1", selectedSkillIds: ["skill-1"] },
      error: null
    });
    expect(response.body).not.toContain("Review security and missing tests");
  });

  it("validates task limits without calling the service", async () => {
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi.fn(async () => undefined)
    };
    const { app } = createDashboardApp({
      mutationToken: "test-token",
      preflightServices: services
    });
    apps.push(app);

    for (const payload of [
      { task: "short", maxSkills: 3 },
      { task: "Review this change", maxSkills: 6 },
      { task: "x".repeat(20_001), maxSkills: 3 }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/preflights",
        headers: { "x-skill-steward-token": "test-token" },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_PREFLIGHT_REQUEST" }
      });
    }
    expect(services.run).not.toHaveBeenCalled();
  });

  it("records feedback and maps missing evidence to 404", async () => {
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new PreflightServiceError(
            "PREFLIGHT_NOT_FOUND",
            "Preflight evidence was not found"
          )
        )
    };
    const { app } = createDashboardApp({
      mutationToken: "test-token",
      preflightServices: services
    });
    apps.push(app);

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/preflights/run-1/feedback",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { label: "incomplete", selectedSkillIds: ["skill-1"] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ data: { saved: true } });

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/preflights/missing/feedback",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { label: "useful", selectedSkillIds: [] }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "PREFLIGHT_NOT_FOUND" }
    });
  });
});
