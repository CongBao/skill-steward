import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import {
  applyIntegrationPlan,
  IntegrationError,
  removeManagedCompanionSkill,
  rollbackIntegrationPlan
} from "@skill-steward/integrations";
import { readLatestReport, writeLatestReport } from "@skill-steward/store";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createIntegrationServices } from "../src/integration-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function applyRequest(
  app: ReturnType<typeof createDashboardApp>["app"],
  harness: string,
  planId: string,
  headers: Record<string, string>
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/integrations/${harness}/apply`,
    headers,
    payload: { planId }
  });
}

async function fixture(ids: string[] = ["integration-record"]) {
  const base = await mkdtemp(join(tmpdir(), "steward-integration-api-"));
  const home = join(base, "home");
  const stateDirectory = join(base, "state");
  const companionSkillDirectory = join(base, "asset", "skill-steward-preflight");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(companionSkillDirectory, { recursive: true });
  await writeFile(join(home, ".codex", "hooks.json"), '{"unrelated":true}\n');
  await writeFile(join(companionSkillDirectory, "SKILL.md"), "---\nname: skill-steward-preflight\ndescription: Preflight tasks\n---\nRun preflight.\n");
  let readinessFailure: (() => Promise<void>) | undefined;
  let domainFailureAfterCommit: Error | undefined;
  let uncertainJournalCommit = false;
  let rollbackJournalFailure = false;
  let companionCleanupFailure = false;
  let readinessCalls = 0;
  let idIndex = 0;
  let currentTime = new Date("2026-07-03T00:00:00.000Z");
  const appliedPlanIds: string[] = [];
  const integrationServices = createIntegrationServices({
    home,
    stateDirectory,
    companionSkillDirectory,
    afterApply: async () => {
      readinessCalls += 1;
      if (readinessFailure) await readinessFailure();
      const report = await scanPortfolio(standardRoots({ home, cwd: home }));
      await writeLatestReport(stateDirectory, report);
    },
    now: () => currentTime,
    id: () => ids[idIndex++] ?? `integration-record-${idIndex}`
  }, {
    applyPlan: async (plan, options) => {
      appliedPlanIds.push((plan as { id: string }).id);
      const record = await applyIntegrationPlan(plan, options, uncertainJournalCommit
        ? {
            appendRecord: async () => {
              throw Object.assign(new Error("journal commit cannot be proven"), {
                code: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN"
              });
            }
          }
        : {});
      if (domainFailureAfterCommit) throw domainFailureAfterCommit;
      return record;
    },
    rollbackPlan: (plan, options) => rollbackIntegrationPlan(
      plan,
      options,
      rollbackJournalFailure
        ? { appendRecord: async () => { throw new Error("removed record was not committed"); } }
        : {}
    ),
    removeCompanion: async (options) => companionCleanupFailure
      ? false
      : removeManagedCompanionSkill(options)
  });
  const created = createDashboardApp({ mutationToken: "token", integrationServices });
  apps.push(created.app);
  return {
    ...created,
    integrationServices,
    appliedPlanIds,
    home,
    stateDirectory,
    failReadiness(
      error = new Error("forced readiness failure"),
      beforeThrow?: () => Promise<void>
    ) {
      readinessFailure = async () => {
        await beforeThrow?.();
        throw error;
      };
    },
    failDomainAfterCommit(error: Error) {
      domainFailureAfterCommit = error;
    },
    failJournalCommitUncertain() {
      uncertainJournalCommit = true;
    },
    failRollbackJournal() {
      rollbackJournalFailure = true;
    },
    failCompanionCleanup() {
      companionCleanupFailure = true;
    },
    readinessCalls: () => readinessCalls,
    setNow(value: string) {
      currentTime = new Date(value);
    }
  };
}

describe("Harness integration routes", () => {
  it("requires a strict planId apply body", async () => {
    const headers = { "x-skill-steward-token": "token" };
    for (const body of [undefined, {}, { planId: "plan-a", extra: true }]) {
      const { app } = await fixture(["plan-a"]);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/integrations/codex/plan",
        headers
      })).statusCode).toBe(200);
      const applied = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/codex/apply",
        headers,
        ...(body === undefined ? {} : { payload: body })
      });
      expect(applied.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("binds multiple same-Harness plans to their exact IDs", async () => {
    const { integrationServices, appliedPlanIds } = await fixture(["plan-a", "plan-b"]);
    const planA = await integrationServices.plan("codex");
    const planB = await integrationServices.plan("codex");
    expect(planA.id).toBe("plan-a");
    expect(planB.id).toBe("plan-b");

    await expect(integrationServices.apply("claude-code", planB.id)).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_MISMATCH"
    });
    await integrationServices.apply("codex", planA.id);
    expect(appliedPlanIds).toEqual(["plan-a"]);
    await expect(integrationServices.apply("codex", planA.id)).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_REQUIRED"
    });
    await expect(integrationServices.apply("codex", planB.id)).rejects.toMatchObject({
      code: "INTEGRATION_DRIFTED"
    });
    expect(appliedPlanIds).toEqual(["plan-a", "plan-b"]);
  });

  it("expires reviewed plans opportunistically", async () => {
    const instance = await fixture(["expiring-plan"]);
    const plan = await instance.integrationServices.plan("codex");
    instance.setNow("2026-07-03T00:10:00.000Z");

    await expect(instance.integrationServices.apply("codex", plan.id)).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_REQUIRED"
    });
  });

  it("bounds reviewed plans and evicts the oldest unused entry", async () => {
    const ids = Array.from({ length: 129 }, (_, index) => `plan-${index}`);
    const { integrationServices } = await fixture(ids);
    const first = await integrationServices.plan("codex");
    for (let index = 1; index < ids.length; index += 1) {
      await integrationServices.plan("codex");
    }

    await expect(integrationServices.apply("codex", first.id)).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_REQUIRED"
    });
  });

  it("lists without a token but protects plans and changes", async () => {
    const { app } = await fixture();
    const listed = await app.inject({ method: "GET", url: "/api/v1/integrations" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toEqual([
      expect.objectContaining({ harness: "codex", status: "not-installed" }),
      expect.objectContaining({ harness: "claude-code", status: "not-installed" }),
      expect.objectContaining({ harness: "github-copilot", status: "not-installed" })
    ]);
    const capabilities = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/capabilities"
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        harness: "github-copilot",
        mode: "observe-only",
        promptInjection: false
      })
    ]));
    expect((await app.inject({ method: "POST", url: "/api/v1/integrations/codex/plan" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/unsupported/plan",
      headers: { "x-skill-steward-token": "token" }
    })).statusCode).toBe(400);
  });

  it("reviews, applies, and reversibly removes a Codex integration", async () => {
    const { app, home, stateDirectory, readinessCalls } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json().data).toMatchObject({
      harness: "codex",
      targetPath: join(home, ".codex", "hooks.json"),
      changes: expect.arrayContaining([expect.objectContaining({ operation: "write" })])
    });

    const applied = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ harness: "codex", status: "needs-trust" });
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"))).resolves.toBeUndefined();
    expect(readinessCalls()).toBe(1);
    await expect(readLatestReport(stateDirectory)).resolves.toBeDefined();

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/codex",
      headers
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toMatchObject({ harness: "codex", status: "not-installed" });
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight"))).rejects.toThrow();
  });

  it("reports failed readiness and rolls back only this apply", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const configPath = join(home, ".codex", "hooks.json");
    const before = await readFile(configPath, "utf8");
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(planned.statusCode).toBe(200);
    const backupPath = planned.json().data.backupPath as string;
    failReadiness();

    const applied = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(applied.statusCode).toBe(409);
    expect(applied.json().error).toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves readiness and rollback causes for service callers", async () => {
    const readinessFailure = new Error("scan storage unavailable");
    const first = await fixture(["readiness-plan"]);
    const firstPlan = await first.integrationServices.plan("codex");
    first.failReadiness(readinessFailure);
    const readiness = await first.integrationServices
      .apply("codex", firstPlan.id)
      .catch((error: unknown) => error);
    expect(readiness).toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
    expect((readiness as Error).cause).toBe(readinessFailure);

    const rollbackReadiness = new Error("scan failed before persistence");
    const second = await fixture(["rollback-plan"]);
    const secondPlan = await second.integrationServices.plan("codex");
    second.failReadiness(rollbackReadiness, async () => {
      const config = JSON.parse(await readFile(secondPlan.targetPath, "utf8"));
      await writeFile(
        secondPlan.targetPath,
        `${JSON.stringify({ ...config, changed: true })}\n`,
        "utf8"
      );
    });
    const rollback = await second.integrationServices
      .apply("codex", secondPlan.id)
      .catch((error: unknown) => error);
    expect(rollback).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect((rollback as Error).cause).toBeInstanceOf(AggregateError);
    expect(((rollback as Error).cause as AggregateError).errors[0]).toBe(rollbackReadiness);
  });

  it("preserves pre-existing managed artifacts when a later readiness call fails", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const claudePlan = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/claude-code/plan",
      headers
    });
    expect(claudePlan.statusCode).toBe(200);
    expect((await applyRequest(
      app, "claude-code", claudePlan.json().data.id, headers
    )).statusCode).toBe(200);
    const companion = join(home, ".agents", "skills", "skill-steward-preflight");
    const claudeConfig = join(home, ".claude", "settings.json");
    const beforeClaude = await readFile(claudeConfig, "utf8");
    const codexPlan = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(codexPlan.statusCode).toBe(200);
    failReadiness();
    const failed = await applyRequest(app, "codex", codexPlan.json().data.id, headers);
    expect(failed.statusCode).toBe(409);
    await expect(access(companion)).resolves.toBeUndefined();
    expect(await readFile(claudeConfig, "utf8")).toBe(beforeClaude);
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8")))
      .toEqual({ unrelated: true });
  });

  it("keeps a no-op pre-existing integration when readiness fails", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const initialPlan = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(initialPlan.statusCode).toBe(200);
    expect((await applyRequest(
      app, "codex", initialPlan.json().data.id, headers
    )).statusCode).toBe(200);
    const configPath = join(home, ".codex", "hooks.json");
    const before = await readFile(configPath, "utf8");
    const noopPlan = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(noopPlan.statusCode).toBe(200);
    failReadiness();
    expect((await applyRequest(
      app, "codex", noopPlan.json().data.id, headers
    )).statusCode).toBe(409);
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("reports incomplete rollback without removing a needed companion", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const configPath = join(home, ".codex", "hooks.json");
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    failReadiness(new Error("scan failed"), async () => {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      await writeFile(configPath, `${JSON.stringify({ ...config, external: true })}\n`, "utf8");
    });
    const failed = await applyRequest(app, "codex", "integration-record", headers);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(configPath, "utf8")).toContain('"external":true');
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("removes a new companion when the domain restores a failed journal commit", async () => {
    const { app, home, stateDirectory } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const configPath = join(home, ".codex", "hooks.json");
    const before = await readFile(configPath, "utf8");
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "integration-records"), "blocked", "utf8");

    const failed = await applyRequest(app, "codex", "integration-record", headers);
    expect(failed.statusCode).toBe(500);
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back config and companion when the legacy journal is malformed", async () => {
    const { app, home, stateDirectory } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const configPath = join(home, ".codex", "hooks.json");
    const before = await readFile(configPath, "utf8");
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "integrations.json"), "not-json\n", "utf8");

    const failed = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(failed.statusCode).toBe(500);
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a new companion when domain rollback is incomplete", async () => {
    const { app, home, failDomainAfterCommit } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    failDomainAfterCommit(new IntegrationError(
      "INTEGRATION_ROLLBACK_FAILED",
      "configuration may still be active"
    ));

    const failed = await applyRequest(app, "codex", "integration-record", headers);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toContain("skill-steward hook prompt --harness codex");
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("retains config and companion when journal commit is uncertain", async () => {
    const { app, home, failJournalCommitUncertain } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    failJournalCommitUncertain();

    const failed = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toContain("skill-steward hook prompt --harness codex");
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("retains installed artifacts when readiness rollback cannot journal removal", async () => {
    const { app, home, failReadiness, failRollbackJournal } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    failReadiness();
    failRollbackJournal();

    const failed = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toContain("skill-steward hook prompt --harness codex");
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("reports typed rollback failure when post-domain companion cleanup fails", async () => {
    const { app, home, stateDirectory, failCompanionCleanup } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "integration-records"), "blocked", "utf8");
    failCompanionCleanup();

    const failed = await applyRequest(app, "codex", "integration-record", headers);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });
});
