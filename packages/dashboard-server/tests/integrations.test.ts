import { access, chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanInventory } from "@skill-steward/engine";
import {
  applyIntegrationPlan,
  planIntegration,
  planIntegrationDisconnect,
  type IntegrationTransactionOptions
} from "@skill-steward/integrations";
import { readIntegrationRecordJournal, readLatestReport } from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createIntegrationServices } from "../src/integration-services.js";

const packagedCompanion = fileURLToPath(new URL(
  "../../integrations/assets/skill-steward-preflight",
  import.meta.url
));
const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(input: { readinessFailure?: Error } = {}) {
  const home = await mkdtemp(join(tmpdir(), "steward-integration-api-"));
  const stateDirectory = join(home, "state");
  let readinessCalls = 0;
  let id = 0;
  const integrationServices = createIntegrationServices({
    home,
    stateDirectory,
    companionSkillDirectory: packagedCompanion,
    generateReadiness: async () => {
      readinessCalls += 1;
      if (input.readinessFailure) throw input.readinessFailure;
      return scanInventory({ home, cwd: home }, new Date("2026-07-05T00:00:00.000Z"));
    },
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    id: () => `integration-plan-${++id}`
  });
  const created = createDashboardApp({ mutationToken: "token", integrationServices });
  apps.push(created.app);
  return {
    ...created,
    home,
    stateDirectory,
    integrationServices,
    readinessCalls: () => readinessCalls
  };
}

const headers = { "x-skill-steward-token": "token" };

async function post(
  app: ReturnType<typeof createDashboardApp>["app"],
  url: string,
  payload?: unknown
) {
  if (payload === undefined) {
    return await app.inject({ method: "POST", url, headers });
  }
  return await app.inject({
    method: "POST",
    url,
    headers,
    payload: payload as Record<string, unknown>
  });
}

describe("Harness integration routes", () => {
  it("delegates apply and reviewed disconnect to one high-level domain mutation", async () => {
    const source = await readFile(
      new URL("../src/integration-services.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("installCompanionSkill");
    expect(source).not.toContain("removeManagedCompanionSkill");
    expect(source).not.toContain("withIntegrationMutationLease");
    expect(source).not.toContain("rollbackIntegrationPlan");
    expect(source).not.toContain("removeIntegration");
    expect(source).toContain("planIntegrationDisconnect");
    expect(source).toContain("applyIntegrationDisconnect");
    expect(source).not.toContain("disconnectCompanionIntegrationTransaction");
  });

  it("calls exactly one high-level mutation with planId and a readiness generator", async () => {
    const applyPlan = vi.fn(async (_planId: string, options: IntegrationTransactionOptions) => {
      await options.generateReadiness({
        transactionId: "00000000-0000-4000-8000-000000000001",
        recordId: "record-1",
        planId: "strict-plan-id",
        harness: "codex",
        action: "create"
      });
      return {
        transactionId: "00000000-0000-4000-8000-000000000001",
        outcome: "ready" as const,
        hook: "installed" as const,
        companion: "created" as const,
        recordId: "record-1",
        cleanup: "clean" as const,
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none" as const
      };
    });
    const home = await mkdtemp(join(tmpdir(), "steward-integration-service-one-call-"));
    const generateReadiness = vi.fn(async () => ({ report: true }));
    const services = createIntegrationServices({
      home,
      stateDirectory: join(home, "state"),
      companionSkillDirectory: packagedCompanion,
      generateReadiness
    }, { applyPlan });

    await expect(services.apply("codex", "strict-plan-id")).resolves.toMatchObject({
      planId: "strict-plan-id",
      action: "create",
      receipt: { reasonCode: "INTEGRATION_READY" }
    });
    expect(applyPlan).toHaveBeenCalledTimes(1);
    expect(applyPlan.mock.calls[0]?.[0]).toBe("strict-plan-id");
    expect(applyPlan.mock.calls[0]?.[1]).not.toHaveProperty("proof");
    expect(applyPlan.mock.calls[0]?.[1]).not.toHaveProperty("leaseContext");
    expect(generateReadiness).toHaveBeenCalledTimes(1);
  });

  it("requires strict { planId } bodies for apply and disconnect", async () => {
    for (const suffix of ["apply", "disconnect"]) {
      for (const body of [undefined, {}, { planId: "plan-a", extra: true }, { planId: "../raw" }]) {
        const { app } = await fixture();
        const response = await post(app, `/api/v1/integrations/codex/${suffix}`, body);
        expect(response.statusCode, `${suffix}: ${JSON.stringify(body)}`).toBe(400);
        expect(response.json().error.code).toBe("INVALID_INTEGRATION_PLAN_REQUEST");
      }
    }
  });

  it("normalizes an unknown code-shaped service error without exposing its canary", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-integration-api-private-error-"));
    const canary = join(home, ".codex", "server-canary");
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory: join(home, "state"),
      companionSkillDirectory: packagedCompanion,
      generateReadiness: async () => ({})
    }, {
      plan: async () => {
        throw Object.assign(new Error(`EACCES: lstat '${canary}' server-canary`), {
          code: "EACCES",
          path: canary,
          syscall: "lstat"
        });
      }
    });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    apps.push(app);

    const response = await post(app, "/api/v1/integrations/codex/plan");

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: "INTEGRATION_OPERATION_FAILED",
      message: "Integration operation could not be completed safely."
    });
    expect(response.body).not.toMatch(/EACCES|lstat|server-canary|\.codex/u);
    expect(response.body).not.toContain(home);
  });

  it("keeps integration status failures out of the raw global error handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-integration-api-status-private-"));
    const canary = join(home, ".codex", "status-canary");
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory: join(home, "state"),
      companionSkillDirectory: packagedCompanion,
      generateReadiness: async () => ({})
    }, {
      status: async () => {
        throw Object.assign(new Error(`EACCES: lstat '${canary}' status-canary`), {
          code: "EACCES",
          path: canary,
          syscall: "lstat"
        });
      }
    });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/integrations" });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: "INTEGRATION_OPERATION_FAILED",
      message: "Integration operation could not be completed safely."
    });
    expect(response.body).not.toMatch(/EACCES|lstat|status-canary|\.codex/u);
    expect(response.body).not.toContain(home);
  });

  it("keeps real unreadable Hook plan and apply failures path-free", async () => {
    const planFixture = await fixture();
    const planParent = join(planFixture.home, ".codex");
    await mkdir(planParent, { recursive: true });
    await chmod(planParent, 0o000);
    let unreadablePlan;
    try {
      unreadablePlan = await post(planFixture.app, "/api/v1/integrations/codex/plan");
    } finally {
      await chmod(planParent, 0o700);
    }
    expect(unreadablePlan.statusCode).toBe(500);
    expect(unreadablePlan.json().error).toEqual({
      code: "INTEGRATION_OPERATION_FAILED",
      message: "Integration operation could not be completed safely."
    });
    expect(unreadablePlan.body).not.toMatch(/EACCES|lstat|server-canary|\.codex/u);
    expect(unreadablePlan.body).not.toContain(planFixture.home);

    const applyFixture = await fixture();
    const applyParent = join(applyFixture.home, ".codex");
    await mkdir(applyParent, { recursive: true });
    const plan = (await post(
      applyFixture.app,
      "/api/v1/integrations/codex/plan"
    )).json().data;
    await chmod(applyParent, 0o000);
    let unreadableApply;
    try {
      unreadableApply = await post(
        applyFixture.app,
        "/api/v1/integrations/codex/apply",
        { planId: plan.planId }
      );
    } finally {
      await chmod(applyParent, 0o700);
    }
    expect(unreadableApply.statusCode).toBe(409);
    expect(unreadableApply.json().error).toMatchObject({
      code: "INTEGRATION_TRANSACTION_FAILED",
      message: "The integration transaction was rolled back. Create a fresh plan.",
      data: { receipt: { reasonCode: "INTEGRATION_TRANSACTION_FAILED" } }
    });
    expect(unreadableApply.body).not.toMatch(/EACCES|lstat|server-canary|\.codex/u);
    expect(unreadableApply.body).not.toContain(applyFixture.home);
  });

  it("preserves a known typed code but replaces its private message", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-integration-api-known-error-"));
    const canary = join(home, ".codex", "known-canary");
    const applyPlan = vi.fn(async () => {
      throw Object.assign(new Error(`Reviewed ${canary} changed known-canary`), {
        code: "INTEGRATION_DRIFTED"
      });
    });
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory: join(home, "state"),
      companionSkillDirectory: packagedCompanion,
      generateReadiness: async () => ({})
    }, { applyPlan });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    apps.push(app);

    const response = await post(app, "/api/v1/integrations/codex/apply", {
      planId: "known-error-plan"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "INTEGRATION_DRIFTED",
      message: "The reviewed integration state changed. Create a fresh plan."
    });
    expect(response.body).not.toMatch(/known-canary|\.codex/u);
    expect(response.body).not.toContain(home);
  });

  it("binds a cross-surface apply plan to its persisted Harness after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-integration-api-restart-apply-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now,
      id: () => "cross-surface-apply"
    });
    const generateReadiness = vi.fn(async () =>
      scanInventory({ home, cwd: home }, now())
    );
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory,
      companionSkillDirectory: packagedCompanion,
      generateReadiness,
      now
    });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    apps.push(app);

    const mismatch = await post(app, "/api/v1/integrations/claude-code/apply", {
      planId: plan.planId
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toMatchObject({ code: "INTEGRATION_PLAN_MISMATCH" });
    expect(JSON.stringify(mismatch.json())).not.toContain(home);
    expect(generateReadiness).not.toHaveBeenCalled();
    await expect(access(plan.targets.hook)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readIntegrationRecordJournal(stateDirectory)).records).toEqual([]);

    const applied = await post(app, "/api/v1/integrations/codex/apply", {
      planId: plan.planId
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().data.action).toBe("create");
  });

  it("binds a cross-surface disconnect plan to its persisted Harness after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-integration-api-restart-disconnect-"));
    const stateDirectory = join(home, "state");
    const now = () => new Date("2026-07-05T00:00:00.000Z");
    const options = {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now,
      id: () => "cross-surface-create"
    };
    const create = await planIntegration("codex", options);
    await applyIntegrationPlan(create.planId, {
      ...options,
      generateReadiness: async () => scanInventory({ home, cwd: home }, now())
    });
    const plan = await planIntegrationDisconnect("codex", {
      ...options,
      id: () => "cross-surface-disconnect"
    });
    const hookBefore = await readFile(plan.targets.hook, "utf8");
    const journalBefore = await readIntegrationRecordJournal(stateDirectory);
    const generateReadiness = vi.fn(async () =>
      scanInventory({ home, cwd: home }, now())
    );
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory,
      companionSkillDirectory: packagedCompanion,
      generateReadiness,
      now
    });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    apps.push(app);

    const mismatch = await post(app, "/api/v1/integrations/claude-code/disconnect", {
      planId: plan.planId
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toMatchObject({ code: "INTEGRATION_PLAN_MISMATCH" });
    expect(JSON.stringify(mismatch.json())).not.toContain(home);
    expect(generateReadiness).not.toHaveBeenCalled();
    expect(await readFile(plan.targets.hook, "utf8")).toBe(hookBefore);
    expect((await readIntegrationRecordJournal(stateDirectory)).records)
      .toEqual(journalBefore.records);

    const disconnected = await post(app, "/api/v1/integrations/codex/disconnect", {
      planId: plan.planId
    });
    expect(disconnected.statusCode, disconnected.body).toBe(200);
    expect(disconnected.json().data.action).toBe("disconnect");
  });

  it("creates from one reviewed API plan and returns the common sanitized receipt", async () => {
    const instance = await fixture();
    const planned = await post(instance.app, "/api/v1/integrations/codex/plan");
    expect(planned.statusCode).toBe(200);
    const plan = planned.json().data;
    expect(plan).toMatchObject({
      action: "create",
      status: "missing",
      availability: { state: "available", available: true, reason: null },
      targets: {
        hook: join(instance.home, ".codex", "hooks.json"),
        companion: join(instance.home, ".agents", "skills", "skill-steward-preflight")
      },
      fingerprintCategory: "new",
      applyCommand: `skill-steward integrate apply --plan ${plan.planId} --confirm`
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /backupPath|stagePath|recoveryPath|sourceDirectory|expectedBefore|proof|identity/u
    );

    const applied = await post(
      instance.app,
      "/api/v1/integrations/codex/apply",
      { planId: plan.planId }
    );
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().data).toMatchObject({
      planId: plan.planId,
      action: "create",
      receipt: {
        outcome: "ready",
        hook: "installed",
        companion: "created",
        reasonCode: "INTEGRATION_READY"
      }
    });
    expect(instance.readinessCalls()).toBe(1);
    expect(await readLatestReport(instance.stateDirectory)).toBeDefined();
  });

  it("reviews and applies a v2 disconnect and removes the last companion", async () => {
    const instance = await fixture();
    const createPlan = (await post(
      instance.app,
      "/api/v1/integrations/codex/plan"
    )).json().data;
    expect((await post(
      instance.app,
      "/api/v1/integrations/codex/apply",
      { planId: createPlan.planId }
    )).statusCode).toBe(200);

    const planned = await post(
      instance.app,
      "/api/v1/integrations/codex/disconnect/plan"
    );
    expect(planned.statusCode, planned.body).toBe(200);
    const plan = planned.json().data;
    expect(plan).toMatchObject({
      action: "disconnect",
      availability: { available: true, reason: null },
      companion: "removed",
      companionRetained: false,
      lastConsumer: true,
      applyCommand: `skill-steward integrate remove --plan ${plan.planId} --confirm`
    });

    const disconnected = await post(
      instance.app,
      "/api/v1/integrations/codex/disconnect",
      { planId: plan.planId }
    );
    expect(disconnected.statusCode, disconnected.body).toBe(200);
    expect(disconnected.json().data).toMatchObject({
      action: "disconnect",
      receipt: {
        hook: "removed",
        companion: "removed",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none"
      }
    });
    await expect(access(plan.targets.companion)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the legacy v1 compatibility writer after a v2 head", async () => {
    const instance = await fixture();
    const plan = (await post(
      instance.app,
      "/api/v1/integrations/codex/plan"
    )).json().data;
    expect((await post(
      instance.app,
      "/api/v1/integrations/codex/apply",
      { planId: plan.planId }
    )).statusCode).toBe(200);
    const hook = plan.targets.hook as string;
    const before = await readFile(hook, "utf8");

    const legacy = await instance.app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/codex",
      headers
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().error.code).toBe("INTEGRATION_LEGACY_CLEANUP_UNAVAILABLE");
    expect(await readFile(hook, "utf8")).toBe(before);
  });

  it("returns path-free transaction errors and exact common recovery receipt", async () => {
    const instance = await fixture({ readinessFailure: new Error("scan unavailable") });
    const plan = (await post(
      instance.app,
      "/api/v1/integrations/codex/plan"
    )).json().data;
    const failed = await post(
      instance.app,
      "/api/v1/integrations/codex/apply",
      { planId: plan.planId }
    );
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({
      code: "INTEGRATION_TRANSACTION_FAILED",
      data: {
        receipt: {
          outcome: "rolled-back",
          nextSafeAction: "create-new-plan"
        }
      }
    });
    expect(JSON.stringify(failed.json())).not.toMatch(
      /stagePath|backupPath|recoveryPath|statePath|\.skill-steward-/u
    );
  });

  it("lists the same five companion statuses without filesystem paths", async () => {
    const instance = await fixture();
    const response = await instance.app.inject({
      method: "GET",
      url: "/api/v1/integrations"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "missing", hookStatus: "not-installed" })
    ]));
    expect(JSON.stringify(response.json().data)).not.toContain("targetPath");
  });
});
