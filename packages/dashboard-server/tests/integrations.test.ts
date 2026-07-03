import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import { readLatestReport, writeLatestReport } from "@skill-steward/store";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createIntegrationServices } from "../src/integration-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "steward-integration-api-"));
  const home = join(base, "home");
  const stateDirectory = join(base, "state");
  const companionSkillDirectory = join(base, "asset", "skill-steward-preflight");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(companionSkillDirectory, { recursive: true });
  await writeFile(join(home, ".codex", "hooks.json"), '{"unrelated":true}\n');
  await writeFile(join(companionSkillDirectory, "SKILL.md"), "---\nname: skill-steward-preflight\ndescription: Preflight tasks\n---\nRun preflight.\n");
  let readinessFailure: (() => Promise<void>) | undefined;
  let readinessCalls = 0;
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
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    id: () => "integration-record"
  });
  const created = createDashboardApp({ mutationToken: "token", integrationServices });
  apps.push(created.app);
  return {
    ...created,
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
    readinessCalls: () => readinessCalls
  };
}

describe("Harness integration routes", () => {
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

    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/apply",
      headers
    });
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

    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/apply",
      headers
    });
    expect(applied.statusCode).toBe(409);
    expect(applied.json().error).toMatchObject({ code: "INTEGRATION_READINESS_FAILED" });
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves pre-existing managed artifacts when a later readiness call fails", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    for (const action of ["plan", "apply"]) {
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/integrations/claude-code/${action}`,
        headers
      })).statusCode).toBe(200);
    }
    const companion = join(home, ".agents", "skills", "skill-steward-preflight");
    const claudeConfig = join(home, ".claude", "settings.json");
    const beforeClaude = await readFile(claudeConfig, "utf8");
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    failReadiness();
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/apply",
      headers
    });
    expect(failed.statusCode).toBe(409);
    await expect(access(companion)).resolves.toBeUndefined();
    expect(await readFile(claudeConfig, "utf8")).toBe(beforeClaude);
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8")))
      .toEqual({ unrelated: true });
  });

  it("keeps a no-op pre-existing integration when readiness fails", async () => {
    const { app, home, failReadiness } = await fixture();
    const headers = { "x-skill-steward-token": "token" };
    for (const action of ["plan", "apply"]) {
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/integrations/codex/${action}`,
        headers
      })).statusCode).toBe(200);
    }
    const configPath = join(home, ".codex", "hooks.json");
    const before = await readFile(configPath, "utf8");
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/plan",
      headers
    })).statusCode).toBe(200);
    failReadiness();
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/apply",
      headers
    })).statusCode).toBe(409);
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
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/codex/apply",
      headers
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
    expect(await readFile(configPath, "utf8")).toContain('"external":true');
    await expect(access(join(home, ".agents", "skills", "skill-steward-preflight")))
      .resolves.toBeUndefined();
  });
});
