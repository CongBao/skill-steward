import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill, type SkillRoot } from "@skill-steward/engine";
import { writeLatestReport } from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createGovernanceServices } from "../src/governance-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-governance-api-")));
  const home = join(base, "home");
  const activeRoot = join(home, ".agents", "skills");
  const activePath = join(activeRoot, "review");
  const stateDirectory = join(base, "state");
  await mkdir(activePath, { recursive: true });
  await mkdir(stateDirectory);
  await writeFile(join(activePath, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
  const roots: SkillRoot[] = [{
    path: activeRoot,
    scope: "global",
    visibleTo: ["agents", "codex", "github-copilot"]
  }];
  const skill = await parseSkill({ path: activePath, roots });
  await writeLatestReport(stateDirectory, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [skill],
    findings: []
  });
  const afterCommit = vi.fn(async () => undefined);
  const governanceServices = createGovernanceServices({
    stateDirectory,
    activeRoots: () => roots,
    afterCommit,
    now: () => new Date("2026-07-03T00:01:00.000Z")
  });
  const created = createDashboardApp({ mutationToken: "token", governanceServices });
  apps.push(created.app);
  return { ...created, stateDirectory, activePath, skill, afterCommit };
}

describe("governance routes", () => {
  it("uses token-protected in-memory plans for quarantine and restore", async () => {
    const { app, activePath, skill, afterCommit } = await fixture();
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      payload: { action: "quarantine", skillId: skill.id }
    })).statusCode).toBe(401);
    const headers = { "x-skill-steward-token": "token" };
    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "quarantine", skillId: skill.id }
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json().data).toMatchObject({ kind: "quarantine", activePath });
    const quarantineId = planned.json().data.id;
    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${quarantineId}/apply`,
      headers
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({
      transaction: { status: "quarantined" },
      rescanRequired: true
    });
    await expect(access(activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${quarantineId}/apply`,
      headers
    })).statusCode).toBe(409);

    const transactions = await app.inject({ url: "/api/v1/governance/transactions" });
    expect(transactions.statusCode).toBe(200);
    const transactionId = transactions.json().data[0].id;
    const restorePlan = await app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "restore", transactionId }
    });
    expect(restorePlan.json().data).toMatchObject({ kind: "restore" });
    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${restorePlan.json().data.id}/apply`,
      headers
    });
    expect(restored.json().data).toMatchObject({ transaction: { status: "restored" } });
    await expect(access(activePath)).resolves.toBeUndefined();
    expect(afterCommit).toHaveBeenCalledTimes(2);
  });

  it("has no permanent delete route", async () => {
    const { app, activePath } = await fixture();
    expect((await app.inject({
      method: "DELETE",
      url: "/api/v1/governance/skills/anything",
      headers: { "x-skill-steward-token": "token" }
    })).statusCode).toBe(404);
    await expect(access(activePath)).resolves.toBeUndefined();
  });
});
