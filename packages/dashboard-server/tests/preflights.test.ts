import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREFLIGHT_ALGORITHM_VERSION,
  type PreflightResult
} from "@skill-steward/preflight";
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
    schemaVersion: 4,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id: "run-1",
    generatedAt: "2026-07-03T01:00:00.000Z",
    portfolioFingerprint: report.portfolioFingerprint,
    taskHash: `sha256:${"c".repeat(64)}`,
    taskCharacterCount: 33,
    taskTermCount: 4,
    useCandidateIds: ["skill-1"],
    installCandidateIds: [],
    candidates: [{
      candidateId: "skill-1",
      availability: "installed",
      installedSkillId: "skill-1",
      name: "review",
      description: "Review changes",
      scope: "global",
      compatibleHarnesses: ["claude"],
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: "error",
      relevance: 0.7,
      uniqueCoverage: 0.5,
      riskPenalty: 0.2,
      redundancyPenalty: 0,
      installPenalty: 0,
      contextTokens: 100,
      features: {
        taskCoverage: 0.7,
        skillPrecision: 0.6,
        nameMatch: true,
        projectScopeFit: false
      },
      decision: "use",
      reasons: [{ code: "TASK_TERM_MATCH", detail: "review, change" }]
    }],
    conflicts: report.findings,
    inventoryWarnings: [],
    capabilityGaps: [],
    installedCoverage: 0.5,
    projectedCoverage: 0.5,
    selectedContextTokens: 100,
    plausibleContextTokens: 100,
    estimatedContextSaved: 0
  };
}

describe("preflight services", () => {
  it("runs against fresh portfolio and catalog state and stores sanitized evidence", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-preflight-service-"));
    const currentPortfolio = vi.fn(async () => report);
    const catalogState = vi.fn(async () => ({ sources: [], snapshot: null }));
    const services = createPreflightServices({
      stateDirectory,
      currentPortfolio,
      catalogState,
      now: () => new Date("2026-07-03T01:00:00.000Z"),
      id: () => "run-1"
    });

    const output = await services.run({
      task: "PRIVATE review code security changes",
      maxSkills: 3,
      harness: "claude",
      includeAvailable: true
    });

    expect(currentPortfolio).toHaveBeenCalledOnce();
    expect(catalogState).toHaveBeenCalledOnce();
    expect(output).toMatchObject({ id: "run-1", schemaVersion: 4 });
    expect(await readPreflightEvidence(stateDirectory)).toEqual([
      expect.objectContaining({
        harness: "claude-code",
        delivery: "dashboard"
      })
    ]);
    expect(await readFile(join(stateDirectory, "preflights.json"), "utf8"))
      .not.toContain("PRIVATE review code security changes");
  });
});

describe("preflight routes", () => {
  it("requires the mutation token and returns a version-4 result", async () => {
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
      payload: {
        task: "  Review security and missing tests  ",
        maxSkills: 3,
        harness: "codex",
        includeAvailable: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(services.run).toHaveBeenCalledWith({
      task: "Review security and missing tests",
      maxSkills: 3,
      harness: "codex",
      includeAvailable: true
    });
    expect(response.json()).toMatchObject({
      data: { id: "run-1", schemaVersion: 4, useCandidateIds: ["skill-1"] },
      error: null
    });
    expect(response.body).not.toContain("Review security and missing tests");
  });

  it("validates task limits without calling the service", async () => {
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi.fn(async () => undefined)
    };
    const { app } = createDashboardApp({ mutationToken: "test-token", preflightServices: services });
    apps.push(app);
    for (const payload of [
      { task: "short", maxSkills: 3 },
      { task: "Review this change", maxSkills: 6 },
      { task: "x".repeat(20_001), maxSkills: 3 },
      { task: "Review this change", harness: "not-real" }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/preflights",
        headers: { "x-skill-steward-token": "test-token" },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_PREFLIGHT_REQUEST" } });
    }
    expect(services.run).not.toHaveBeenCalled();
  });

  it("records candidate feedback and maps missing evidence to 404", async () => {
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new PreflightServiceError(
          "PREFLIGHT_NOT_FOUND",
          "Preflight evidence was not found"
        ))
    };
    const { app } = createDashboardApp({ mutationToken: "test-token", preflightServices: services });
    apps.push(app);

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/preflights/run-1/feedback",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { label: "incomplete", candidateIds: ["skill-1"] }
    });
    expect(saved.statusCode).toBe(200);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/preflights/missing/feedback",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { label: "useful", candidateIds: [] }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PREFLIGHT_NOT_FOUND" } });
  });

  it("passes readable legacy candidate IDs through the feedback route", async () => {
    const candidateIds = ["legacy/skill", "legacy skill", "x".repeat(97)];
    const services: PreflightServices = {
      run: vi.fn(async () => result()),
      feedback: vi.fn(async () => undefined)
    };
    const { app } = createDashboardApp({
      mutationToken: "test-token",
      preflightServices: services
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/preflights/legacy-v2/feedback",
      headers: { "x-skill-steward-token": "test-token" },
      payload: { label: "incomplete", candidateIds }
    });

    expect(response.statusCode).toBe(200);
    expect(services.feedback).toHaveBeenCalledWith("legacy-v2", {
      label: "incomplete",
      candidateIds
    });
  });
});
