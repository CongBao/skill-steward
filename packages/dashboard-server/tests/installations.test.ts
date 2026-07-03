import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { readInstallationHistory } from "@skill-steward/installer";
import {
  createInstallationServices,
  type InstallationServices
} from "../src/installation-services.js";

function services(): InstallationServices {
  return {
    inspectFolder: vi.fn(async () => ({
      previewId: "preview-1",
      expiresAt: 10_000,
      source: { kind: "folder" as const, label: "review" },
      candidates: [{ id: "candidate-1", name: "review", fingerprint: `sha256:${"a".repeat(64)}` }]
    })),
    inspectZip: vi.fn(),
    inspectGit: vi.fn(),
    plan: vi.fn(async () => ({
      id: "plan-1",
      status: "ready" as const,
      action: "create" as const,
      changes: [{ operation: "create" as const, path: "/skills/review" }]
    })),
    commit: vi.fn(async () => ({ id: "tx-1", status: "installed" as const })),
    history: vi.fn(async () => []),
    rollback: vi.fn(async () => ({ id: "tx-1", status: "rolled-back" as const }))
  };
}

describe("installation routes", () => {
  const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("inspects a folder and creates an exact plan", async () => {
    const installationServices = services();
    const { app } = createDashboardApp({
      mutationToken: "token",
      installationServices
    });
    apps.push(app);
    const headers = { "x-skill-steward-token": "token" };

    const inspected = await app.inject({
      method: "POST",
      url: "/api/v1/install-sources/inspect",
      headers,
      payload: {
        source: { kind: "folder", label: "review" },
        files: [
          {
            relativePath: "review/SKILL.md",
            contentBase64: Buffer.from("skill").toString("base64")
          }
        ]
      }
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ data: { previewId: "preview-1" } });

    const planned = await app.inject({
      method: "POST",
      url: "/api/v1/installations/plan",
      headers,
      payload: {
        previewId: "preview-1",
        candidateId: "candidate-1",
        harness: "claude",
        scope: "global",
        targetName: "review"
      }
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toMatchObject({ data: { id: "plan-1", status: "ready" } });
  });

  it("requires explicit confirmation, exposes history, and rolls back", async () => {
    const installationServices = services();
    const { app } = createDashboardApp({ mutationToken: "token", installationServices });
    apps.push(app);
    const headers = { "x-skill-steward-token": "token" };

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installations/commit",
          headers,
          payload: { planId: "plan-1", confirmed: false }
        })
      ).json()
    ).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installations/commit",
          headers,
          payload: { planId: "plan-1", confirmed: true }
        })
      ).json()
    ).toMatchObject({ data: { status: "installed" } });
    expect((await app.inject({ url: "/api/v1/installations" })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installations/tx-1/rollback",
          headers
        })
      ).json()
    ).toMatchObject({ data: { status: "rolled-back" } });
  });

  it("carries validated catalog provenance from preview through the journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-install-provenance-"));
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: recommended-review\ndescription: Review changes\n---\n"
    );
    const provenance = {
      preflightId: "run-1",
      candidateId: "testing-available",
      sourceId: "fixture-catalog",
      sourceRevision: "a".repeat(40)
    };
    const stateDirectory = join(root, "state");
    const installationServices = createInstallationServices({
      stateDirectory,
      home: root,
      workspace: root,
      stageGit: async (directory) => {
        const staged = join(directory, "source");
        await cp(source, staged, { recursive: true });
        return { sourceDirectory: staged, commitSha: "a".repeat(40) };
      }
    });
    const preview = await installationServices.inspectGit({
      kind: "git",
      url: "https://example.com/skills.git",
      ref: "a".repeat(40)
    }, provenance);
    const candidate = preview.candidates[0]!;
    const plan = await installationServices.plan({
      previewId: preview.previewId,
      candidateId: candidate.id,
      harness: "codex",
      scope: "global",
      targetName: candidate.name
    });
    await installationServices.commit(plan.id);
    expect(await readInstallationHistory(stateDirectory)).toEqual([
      expect.objectContaining({ provenance })
    ]);
  });
});
