import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill, type SkillRoot } from "@skill-steward/engine";
import { readGovernanceTransactions } from "@skill-steward/governance";
import { readEvidenceEvents, writeLatestReport } from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createGovernanceServices } from "../src/governance-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(
  activeRootsFactory?: (roots: SkillRoot[]) => () => SkillRoot[] | Promise<SkillRoot[]>,
  postCommit?: {
    afterCommit?: () => void | Promise<void>;
    recordEvidence?: (result: unknown) => void | Promise<void>;
  }
) {
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
  const { body: _body, ...skill } = await parseSkill({ path: activePath, roots });
  await writeLatestReport(stateDirectory, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [skill],
    findings: []
  });
  const afterCommit = vi.fn(postCommit?.afterCommit ?? (async () => undefined));
  const recordEvidence = postCommit?.recordEvidence
    ? vi.fn(postCommit.recordEvidence)
    : undefined;
  const governanceServices = createGovernanceServices({
    stateDirectory,
    activeRoots: activeRootsFactory?.(roots) ?? (() => roots),
    afterCommit,
    ...(recordEvidence ? { recordEvidence } : {}),
    now: () => new Date("2026-07-03T00:01:00.000Z")
  } as Parameters<typeof createGovernanceServices>[0] & {
    recordEvidence?: (result: unknown) => void | Promise<void>;
  });
  const created = createDashboardApp({ mutationToken: "token", governanceServices });
  apps.push(created.app);
  return {
    ...created,
    base,
    home,
    roots,
    stateDirectory,
    activePath,
    skill,
    afterCommit,
    recordEvidence
  };
}

async function nativeFixture() {
  const current = await fixture();
  const pluginRoot = join(
    current.home,
    ".codex",
    "plugins",
    "cache",
    "private-marketplace",
    "private-plugin",
    "9.9.9"
  );
  const nativePath = join(pluginRoot, "skills", "native-review");
  const sourceId = "native-codex-source";
  await mkdir(nativePath, { recursive: true });
  await writeFile(
    join(nativePath, "SKILL.md"),
    "---\nname: native-review\ndescription: Review native code\n---\n"
  );
  const { body: _body, ...parsed } = await parseSkill({
    path: nativePath,
    roots: [{
      path: join(pluginRoot, "skills"),
      scope: "global",
      visibleTo: ["codex"]
    }]
  });
  const nativeSkill = {
    ...parsed,
    ownership: "native-plugin" as const,
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex" as const,
      effectiveName: parsed.name,
      state: "effective" as const,
      sourceId,
      reason: "NATIVE_PLUGIN_VISIBLE"
    }],
    plugin: {
      harness: "codex" as const,
      id: "private-plugin@private-marketplace",
      version: "9.9.9"
    }
  };
  await writeLatestReport(current.stateDirectory, {
    schemaVersion: 2,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"b".repeat(64)}`,
    workspace: {
      path: current.base,
      identity: `sha256:${"c".repeat(64)}`
    },
    skills: [nativeSkill],
    findings: [],
    inventory: {
      sources: [{
        id: sourceId,
        harness: "codex",
        scope: "global",
        kind: "native-plugin",
        path: pluginRoot,
        plugin: { id: nativeSkill.plugin.id, version: nativeSkill.plugin.version },
        status: "scanned",
        skillCount: 1,
        effectiveSkillCount: 1
      }],
      harnesses: [{
        harness: "codex",
        status: "verified",
        sourceIds: [sourceId],
        skillCount: 1,
        effectiveSkillCount: 1
      }]
    }
  });
  return { ...current, nativePath, nativeSkill };
}

describe("governance routes", () => {
  it("revalidates current mutable-root authority and retains a rejected in-memory plan", async () => {
    let rootsAvailable = true;
    const current = await fixture((roots) => () => rootsAvailable ? roots : []);
    const headers = { "x-skill-steward-token": "token" };
    const planned = await current.app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "quarantine", skillId: current.skill.id }
    });
    expect(planned.statusCode).toBe(200);
    const planId = planned.json().data.id;
    const original = await readFile(join(current.activePath, "SKILL.md"));
    rootsAvailable = false;

    const rejected = await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: "SOURCE_OUTSIDE_ACTIVE_ROOT" }
    });
    expect(await readFile(join(current.activePath, "SKILL.md"))).toEqual(original);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
    expect(await readEvidenceEvents(current.stateDirectory)).toEqual([]);
    expect(current.afterCommit).not.toHaveBeenCalled();

    rootsAvailable = true;
    const applied = await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    });
    expect(applied.statusCode).toBe(200);
  });

  it("returns bounded 409 guidance and refuses native quarantine or stale restore", async () => {
    const current = await nativeFixture();
    const headers = { "x-skill-steward-token": "token" };
    const skillFile = join(current.nativePath, "SKILL.md");
    const original = await readFile(skillFile);

    const quarantine = await current.app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "quarantine", skillId: current.nativeSkill.id }
    });

    expect(quarantine.statusCode).toBe(409);
    expect(quarantine.json()).toMatchObject({
      data: null,
      error: {
        code: "NATIVE_PLUGIN_MANAGED",
        message: expect.stringContaining("Codex plugin manager"),
        data: {
          harness: "codex",
          lifecycleSurface: "codex-plugin-manager"
        }
      }
    });
    expect(quarantine.body).not.toContain(current.base);
    expect(quarantine.body).not.toContain("private-plugin@private-marketplace");
    expect(quarantine.body).not.toContain("9.9.9");
    expect(await readFile(skillFile)).toEqual(original);
    await expect(access(join(current.stateDirectory, "reviewed-plans")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDirectory, "quarantine")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
    expect(await readEvidenceEvents(current.stateDirectory)).toEqual([]);
    expect(current.afterCommit).not.toHaveBeenCalled();

    const transactionId = "stale-native-quarantine";
    const vaultPath = join(
      current.stateDirectory,
      "quarantine",
      transactionId,
      "native-review"
    );
    await mkdir(vaultPath, { recursive: true });
    await writeFile(join(vaultPath, "SKILL.md"), original);
    const transaction = {
      schemaVersion: 2,
      id: transactionId,
      action: "quarantine",
      status: "quarantined",
      skillId: current.nativeSkill.id,
      skillName: current.nativeSkill.name,
      originalPath: current.nativePath,
      vaultPath,
      fingerprint: current.nativeSkill.fingerprint,
      visibleAliases: [],
      skillOwnership: { ownership: "native-plugin", harness: "codex" },
      createdAt: "2026-07-03T00:00:00.000Z"
    };
    const journalPath = join(current.stateDirectory, "governance.jsonl");
    await writeFile(journalPath, `${JSON.stringify(transaction)}\n`);
    const journalBefore = await readFile(journalPath);

    const restore = await current.app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "restore", transactionId }
    });

    expect(restore.statusCode).toBe(409);
    expect(restore.json()).toMatchObject({
      error: {
        code: "NATIVE_PLUGIN_MANAGED",
        data: {
          harness: "codex",
          lifecycleSurface: "codex-plugin-manager"
        }
      }
    });
    expect(restore.body).not.toContain(current.base);
    expect(restore.body).not.toContain("9.9.9");
    expect(await readFile(skillFile)).toEqual(original);
    expect(await readFile(join(vaultPath, "SKILL.md"))).toEqual(original);
    expect(await readFile(journalPath)).toEqual(journalBefore);
    expect(await readEvidenceEvents(current.stateDirectory)).toEqual([]);
    expect(current.afterCommit).not.toHaveBeenCalled();
  });

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

  it("returns a committed result and records evidence when refresh fails", async () => {
    const current = await fixture(undefined, {
      afterCommit: async () => {
        throw new Error(`refresh failed at ${join("/private", "secret")}`);
      }
    });
    const headers = { "x-skill-steward-token": "token" };
    const planned = await current.app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "quarantine", skillId: current.skill.id }
    });
    const planId = planned.json().data.id;

    const applied = await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({
      transaction: { status: "quarantined" },
      postCommitWarnings: [{
        code: "GOVERNANCE_REFRESH_FAILED",
        message: "Portfolio refresh failed after governance committed"
      }]
    });
    const refreshWarnings = JSON.stringify(applied.json().data.postCommitWarnings);
    expect(refreshWarnings).not.toContain(current.base);
    expect(refreshWarnings).not.toContain("private/secret");
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readEvidenceEvents(current.stateDirectory)).toEqual([
      expect.objectContaining({ kind: "governance-applied" })
    ]);
    expect((await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    })).statusCode).toBe(409);
  });

  it("reports an evidence warning without reversing a committed transaction", async () => {
    const current = await fixture(undefined, {
      recordEvidence: async () => {
        throw new Error(`evidence failed at ${join("/private", "secret")}`);
      }
    });
    const headers = { "x-skill-steward-token": "token" };
    const planned = await current.app.inject({
      method: "POST",
      url: "/api/v1/governance/plans",
      headers,
      payload: { action: "quarantine", skillId: current.skill.id }
    });
    const planId = planned.json().data.id;

    const applied = await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({
      transaction: { status: "quarantined" },
      postCommitWarnings: [{
        code: "GOVERNANCE_EVIDENCE_FAILED",
        message: "Evidence recording failed after governance committed"
      }]
    });
    const evidenceWarnings = JSON.stringify(applied.json().data.postCommitWarnings);
    expect(evidenceWarnings).not.toContain(current.base);
    expect(evidenceWarnings).not.toContain("private/secret");
    expect(current.recordEvidence).toHaveBeenCalledTimes(1);
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await current.app.inject({
      method: "POST",
      url: `/api/v1/governance/plans/${planId}/apply`,
      headers
    })).statusCode).toBe(409);
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
