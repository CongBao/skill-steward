import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const integrationServices = createIntegrationServices({
    home,
    stateDirectory,
    companionSkillDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    id: () => "integration-record"
  });
  const created = createDashboardApp({ mutationToken: "token", integrationServices });
  apps.push(created.app);
  return { ...created, home };
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
    const { app, home } = await fixture();
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
});
