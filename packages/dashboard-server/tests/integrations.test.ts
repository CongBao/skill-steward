import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  integrationPlanSchema,
  IntegrationError,
  planIntegration,
  removeIntegration,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions
} from "@skill-steward/integrations";
import {
  readLatestReport,
  writeLatestReport,
  type IntegrationRecord
} from "@skill-steward/store";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createIntegrationServices } from "../src/integration-services.js";
import { createDashboardServices } from "../src/services.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

async function applyIntegrationPlanInternal(
  plan: unknown,
  options: IntegrationConfigOptions,
  dependencyOverrides?: unknown
): Promise<IntegrationRecord> {
  const modulePath = ["../../integrations/src", "config.js"].join("/");
  const internal = await import(modulePath) as {
    applyIntegrationPlanInternal(
      input: unknown,
      config: IntegrationConfigOptions,
      dependencies?: unknown
    ): Promise<IntegrationRecord>;
  };
  return internal.applyIntegrationPlanInternal(plan, options, dependencyOverrides);
}

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
  const installedCompanion = join(home, ".agents", "skills", "skill-steward-preflight");
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  await cp(companionSkillDirectory, installedCompanion, { recursive: true });
  let readinessFailure: (() => Promise<void>) | undefined;
  let readinessSequence: Array<(() => Promise<void>) | undefined> = [];
  let domainFailureAfterCommit: Error | undefined;
  let uncertainJournalCommit = false;
  let rollbackJournalFailure = false;
  let removalJournalDrift = false;
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
      const sequenced = readinessSequence.shift();
      if (sequenced) await sequenced();
      else if (readinessSequence.length === 0 && readinessFailure) await readinessFailure();
      await createDashboardServices({
        stateDirectory,
        home,
        cwd: home,
        now: () => currentTime
      }).scan([]);
    },
    now: () => currentTime,
    id: () => ids[idIndex++] ?? `integration-record-${idIndex}`
  }, {
    plan: async (harness, options) => {
      const unowned = await planIntegration(harness, options);
      if (
        !("fingerprint" in unowned.companion.after)
        || !("fingerprint" in unowned.companion.source)
        || unowned.companion.expectedBefore.state !== "exact"
        || unowned.companion.expectedBefore.fingerprint !== unowned.companion.after.fingerprint
      ) return unowned;
      const fingerprint = unowned.companion.after.fingerprint;
      return integrationPlanSchema.parse({
        ...unowned,
        companion: {
          ...unowned.companion,
          action: "none",
          expectedBefore: { state: "exact", fingerprint },
          proof: {
            kind: "recorded",
            recordId: "fixture-current-companion",
            installedFingerprint: fingerprint
          }
        }
      });
    },
    applyPlan: async (plan, options) => {
      appliedPlanIds.push((plan as { id: string }).id);
      const record = await applyIntegrationPlanInternal(plan, options, uncertainJournalCommit
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
        ? {
            appendRecord: async () => {
              await writeFile(
                (plan as { targetPath: string }).targetPath,
                '{"external":"during-dashboard-rollback"}\n'
              );
              throw new Error("removed record was not committed");
            }
          }
        : {}
    ),
    removePlan: (harness, options) => removeIntegration(
      harness,
      options,
      removalJournalDrift
        ? {
            appendRecord: async () => {
              await writeFile(
                join(home, ".codex", "hooks.json"),
                '{"external":"during-dashboard-remove"}\n'
              );
              throw new Error("removed record was not committed");
            }
          }
        : {}
    )
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
    sequenceReadiness(value: Array<(() => Promise<void>) | undefined>) {
      readinessSequence = [...value];
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
    driftRemovalJournal() {
      removalJournalDrift = true;
    },
    readinessCalls: () => readinessCalls,
    setNow(value: string) {
      currentTime = new Date(value);
    }
  };
}

describe("Harness integration routes", () => {
  it("keeps lifecycle services free of legacy companion mutators", async () => {
    const source = await readFile(
      new URL("../src/integration-services.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("installCompanionSkill");
    expect(source).not.toContain("removeManagedCompanionSkill");
  });

  it("fails closed without installing a missing companion", async () => {
    const instance = await fixture(["missing-companion"]);
    const companion = join(
      instance.home,
      ".agents",
      "skills",
      "skill-steward-preflight"
    );
    const config = join(instance.home, ".codex", "hooks.json");
    const before = await readFile(config, "utf8");
    await rm(companion, { recursive: true, force: true });
    const plan = await instance.integrationServices.plan("codex");

    await expect(instance.integrationServices.apply("codex", plan.id)).rejects.toMatchObject({
      code: "INTEGRATION_COMPANION_ACTION_UNAVAILABLE"
    });
    await expect(instance.integrationServices.apply("codex", plan.id)).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_REQUIRED"
    });
    await expect(access(companion)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("runs readiness through the same native dashboard inventory", async () => {
    const instance = await fixture(["native-ready"]);
    await installNativeCodexFixture(instance.home);
    const plan = await instance.integrationServices.plan("codex");

    await expect(instance.integrationServices.apply("codex", plan.id)).resolves.toBeDefined();
    expect(await readLatestReport(instance.stateDirectory)).toMatchObject({
      schemaVersion: 2,
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "native-review", ownership: "native-plugin" })
      ]),
      inventory: {
        harnesses: expect.arrayContaining([
          expect.objectContaining({ harness: "codex", status: "verified" })
        ])
      }
    });
  });
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

  it("consumes one Dashboard plan only once under concurrent calls", async () => {
    const instance = await fixture(["single-plan"]);
    const plan = await instance.integrationServices.plan("codex");
    instance.sequenceReadiness([async () => { await delay(25); }]);

    const outcomes = await Promise.allSettled([
      instance.integrationServices.apply("codex", plan.id),
      instance.integrationServices.apply("codex", plan.id)
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected"))
      .toEqual([expect.objectContaining({
        reason: expect.objectContaining({ code: "INTEGRATION_PLAN_REQUIRED" })
      })]);
    expect(instance.readinessCalls()).toBe(1);
  });

  it("serializes exact same-Harness plans across readiness rollback", async () => {
    const instance = await fixture(["failing-plan", "successful-plan"]);
    const failing = await instance.integrationServices.plan("codex");
    const successful = await instance.integrationServices.plan("codex");
    instance.sequenceReadiness([
      async () => {
        await delay(50);
        throw new Error("first scan failed");
      },
      undefined
    ]);

    const outcomes = await Promise.allSettled([
      instance.integrationServices.apply("codex", failing.id),
      instance.integrationServices.apply("codex", successful.id)
    ]);
    expect(outcomes.filter(({ status }) => status === "rejected"))
      .toEqual([expect.objectContaining({
        reason: expect.objectContaining({ code: "INTEGRATION_READINESS_FAILED" })
      })]);
    expect(outcomes.filter(({ status }) => status === "fulfilled"))
      .toEqual([expect.objectContaining({
        value: expect.objectContaining({ status: "needs-trust" })
      })]);
    await expect(instance.integrationServices.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({
        harness: "codex",
        status: "needs-trust",
        companion: expect.objectContaining({ status: "conflict" })
      })])
    );
  });

  it("serializes apply with overlapping removal through final status", async () => {
    const instance = await fixture(["apply-plan"]);
    const plan = await instance.integrationServices.plan("codex");
    let readinessStarted!: () => void;
    const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
    instance.sequenceReadiness([async () => {
      readinessStarted();
      await delay(50);
    }]);

    const applying = instance.integrationServices.apply("codex", plan.id);
    await started;
    const removing = instance.integrationServices.remove("codex");

    await expect(applying).resolves.toMatchObject({ status: "needs-trust" });
    await expect(removing).resolves.toMatchObject({ status: "not-installed" });
  });

  it("serializes different Harness applies around the shared companion", async () => {
    const instance = await fixture(["codex-plan", "claude-plan"]);
    const codex = await instance.integrationServices.plan("codex");
    const claude = await instance.integrationServices.plan("claude-code");

    const results = await Promise.all([
      instance.integrationServices.apply("codex", codex.id),
      instance.integrationServices.apply("claude-code", claude.id)
    ]);

    expect(results).toEqual([
      expect.objectContaining({ harness: "codex", status: "needs-trust" }),
      expect.objectContaining({ harness: "claude-code", status: "installed" })
    ]);
    await expect(access(join(
      instance.home,
      ".agents",
      "skills",
      "skill-steward-preflight"
    ))).resolves.toBeUndefined();
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

  it("keeps legacy readiness and removal compensation behind injected internal fixtures", async () => {
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
      changes: expect.arrayContaining([expect.objectContaining({ operation: "write" })]),
      companion: expect.objectContaining({ action: "none" }),
      applyAvailable: false,
      applyCommand: null,
      applyUnavailableReason: "COMPANION_TRANSACTION_NOT_ENABLED"
    });

    const applied = await applyRequest(app, "codex", planned.json().data.id, headers);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({
      harness: "codex",
      status: "needs-trust",
      companion: {
        status: "conflict",
        reason: "COMPANION_LEGACY_TREE_NOT_ALLOWLISTED"
      }
    });
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
    expect(removed.json().data).toMatchObject({
      harness: "codex",
      status: "not-installed",
      message: "Shared companion retained pending reviewed consumer-aware removal"
    });
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("keeps the production Dashboard integration route review-only and consumes refusal", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-integration-public-api-"));
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const companionSkillDirectory = join(base, "asset", "skill-steward-preflight");
    await mkdir(home, { recursive: true });
    await mkdir(companionSkillDirectory, { recursive: true });
    await writeFile(
      join(companionSkillDirectory, "SKILL.md"),
      "---\nname: skill-steward-preflight\ndescription: Preflight tasks\n---\nRun preflight.\n"
    );
    let readinessCalls = 0;
    const integrationServices = createIntegrationServices({
      home,
      stateDirectory,
      companionSkillDirectory,
      afterApply: async () => { readinessCalls += 1; },
      now: () => new Date("2026-07-05T00:00:00.000Z"),
      id: () => "public-review-plan"
    });
    const { app } = createDashboardApp({
      mutationToken: "token",
      integrationServices
    });
    apps.push(app);
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json().data).toMatchObject({
      id: "public-review-plan",
      applyAvailable: false,
      applyCommand: null,
      applyUnavailableReason: "COMPANION_TRANSACTION_NOT_ENABLED",
      companion: { action: "create" }
    });

    const refused = await applyRequest(app, "codex", "public-review-plan", headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: "INTEGRATION_COMPANION_ACTION_UNAVAILABLE"
    });
    const consumed = await applyRequest(app, "codex", "public-review-plan", headers);
    expect(consumed.statusCode).toBe(409);
    expect(consumed.json().error).toMatchObject({ code: "INTEGRATION_PLAN_REQUIRED" });
    expect(readinessCalls).toBe(0);
    await expect(access(join(home, ".codex", "hooks.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .rejects.toMatchObject({ code: "ENOENT" });
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
      .resolves.toBeUndefined();
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

  it("retains the companion when the domain restores a failed journal commit", async () => {
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
      .resolves.toBeUndefined();
  });

  it("rolls back config and retains companion when the legacy journal is malformed", async () => {
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
      .resolves.toBeUndefined();
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
      .toBe('{"external":"during-dashboard-rollback"}\n');
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("preserves external drift and companion when removal journaling fails", async () => {
    const { app, home, driftRemovalJournal } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    });
    expect((await applyRequest(
      app,
      "codex",
      planned.json().data.id,
      headers
    )).statusCode).toBe(200);
    driftRemovalJournal();

    const failed = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/codex",
      headers
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toBe('{"external":"during-dashboard-remove"}\n');
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });

  it("retains modified and unreadable companions during Hook removal", async () => {
    for (const mode of ["modified", "unreadable"] as const) {
      const { app, home } = await fixture([`retained-${mode}`]);
      const headers = { "x-skill-steward-token": "token" };
      const companion = join(home, ".agents", "skills", "skill-steward-preflight");
      const skill = join(companion, "SKILL.md");
      const planned = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/codex/plan",
        headers
      });
      expect((await applyRequest(
        app,
        "codex",
        planned.json().data.id,
        headers
      )).statusCode).toBe(200);
      if (mode === "modified") await writeFile(skill, "user modified\n", "utf8");
      else await chmod(companion, 0o000);
      try {
        const removed = await app.inject({
          method: "DELETE",
          url: "/api/v1/integrations/codex",
          headers
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().data.message)
          .toBe("Shared companion retained pending reviewed consumer-aware removal");
        await expect(access(companion)).resolves.toBeUndefined();
      } finally {
        if (mode === "unreadable") await chmod(companion, 0o700);
      }
      if (mode === "modified") expect(await readFile(skill, "utf8")).toBe("user modified\n");
    }
  });
});
