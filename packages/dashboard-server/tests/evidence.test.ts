import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createEvidenceServices } from "../src/evidence-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "steward-evidence-api-"));
  const evidenceServices = createEvidenceServices({
    stateDirectory,
    now: () => new Date("2026-07-03T01:00:00.000Z")
  });
  const created = createDashboardApp({ mutationToken: "token", evidenceServices });
  apps.push(created.app);
  return { ...created, stateDirectory };
}

describe("evidence routes", () => {
  it("exposes summaries but token-protects single-use policy plans", async () => {
    const { app } = await fixture();
    const policy = await app.inject({ url: "/api/v1/evidence/policy" });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().data).toMatchObject({ mode: "minimal", retentionDays: 30 });
    const summary = await app.inject({ url: "/api/v1/evidence/summary" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data).toMatchObject({
      totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 },
      readiness: { status: "insufficient-evidence" }
    });

    expect((await app.inject({
      method: "POST",
      url: "/api/v1/evidence/policy/plan",
      payload: { mode: "learning", retentionDays: 45, maxEvents: 1_000 }
    })).statusCode).toBe(401);
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/evidence/policy/plan",
      headers,
      payload: { mode: "learning", retentionDays: 45, maxEvents: 1_000 }
    });
    expect(planned.statusCode).toBe(200);
    const planId = planned.json().data.id;
    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/evidence/policy/apply",
      headers,
      payload: { planId }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ mode: "learning" });
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/evidence/policy/apply",
      headers,
      payload: { planId }
    })).statusCode).toBe(409);
  });

  it("compacts and exactly erases evidence without exposing browser export", async () => {
    const { app, stateDirectory } = await fixture();
    await writeFile(join(stateDirectory, "preflights.json"), '{"schemaVersion":3,"records":[]}\n');
    await writeFile(join(stateDirectory, "evidence-events.jsonl"), "");
    await writeFile(join(stateDirectory, "evidence-salt"), Buffer.alloc(32, 1));
    await writeFile(join(stateDirectory, "catalog.json"), "keep");
    const headers = { "x-skill-steward-token": "token" };
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/evidence/compact",
      headers
    })).statusCode).toBe(200);
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/evidence/erase/plan",
      headers
    });
    const planId = planned.json().data.id;
    expect(planned.json().data.paths).toHaveLength(3);
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/evidence/erase/apply",
      headers,
      payload: { planId }
    })).statusCode).toBe(200);
    await expect(access(join(stateDirectory, "preflights.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateDirectory, "evidence-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateDirectory, "evidence-salt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateDirectory, "catalog.json"))).resolves.toBeUndefined();
    expect((await app.inject({ method: "POST", url: "/api/v1/evidence/export", headers })).statusCode)
      .toBe(404);
  });
});
