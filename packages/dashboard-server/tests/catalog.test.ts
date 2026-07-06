import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogInspection } from "@skill-steward/catalog";
import type {
  InstallationProvenance,
  InstallationSource
} from "@skill-steward/installer";
import {
  writeCatalogSnapshot,
  writeCatalogSources
} from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import { createCatalogServices } from "../src/catalog-services.js";
import { createPreflightServices } from "../src/preflight-services.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const inspection: CatalogInspection = {
  commitSha: "a".repeat(40),
  candidates: [{
    id: "candidate",
    relativePath: "testing",
    name: "testing",
    description: "Find missing tests",
    fingerprint: `sha256:${"b".repeat(64)}`,
    files: [],
    estimatedTokens: 200,
    scripts: [],
    executables: [],
    findings: []
  }]
};

describe("catalog routes", () => {
  it("lists presets without a token and protects mutations", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-catalog-api-"));
    const catalogServices = createCatalogServices({
      stateDirectory,
      inspect: async () => inspection,
      now: () => new Date("2026-07-03T00:00:00.000Z")
    });
    const { app } = createDashboardApp({
      mutationToken: "token",
      catalogServices
    });
    apps.push(app);

    const listed = await app.inject({ method: "GET", url: "/api/v1/catalog/sources" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-plugins", enabled: false })
    ]));
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/catalog/sources/openai-plugins/enable"
    })).statusCode).toBe(401);

    const enabled = await app.inject({
      method: "POST",
      url: "/api/v1/catalog/sources/openai-plugins/enable",
      headers: { "x-skill-steward-token": "token" }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data).toMatchObject({ id: "openai-plugins", enabled: true });

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/catalog/refresh",
      headers: { "x-skill-steward-token": "token" }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceId: "openai-plugins", status: "ready", skillCount: 1 })
      ])
    });
  });

  it("adds user sources and rejects conflicts and credential URLs", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-catalog-add-"));
    const catalogServices = createCatalogServices({
      stateDirectory,
      inspect: async () => inspection
    });
    const { app } = createDashboardApp({ mutationToken: "token", catalogServices });
    apps.push(app);
    const headers = { "x-skill-steward-token": "token" };
    const source = {
      id: "community-skills",
      name: "Community skills",
      url: "https://example.com/community.git"
    };

    expect((await app.inject({
      method: "POST",
      url: "/api/v1/catalog/sources",
      headers,
      payload: source
    })).statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/catalog/sources",
      headers,
      payload: source
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CATALOG_SOURCE_EXISTS" } });
    const credential = await app.inject({
      method: "POST",
      url: "/api/v1/catalog/sources",
      headers,
      payload: {
        id: "credential-source",
        name: "Credential source",
        url: "https://token@example.com/private.git"
      }
    });
    expect(credential.statusCode).toBe(400);
    expect(credential.json()).toMatchObject({ error: { code: "INVALID_CATALOG_SOURCE" } });
  });

  it("feeds installed and available metadata into Preflight v2", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-catalog-preflight-"));
    const source = {
      id: "fixture-catalog",
      name: "Fixture catalog",
      kind: "git" as const,
      url: "https://example.com/skills.git",
      enabled: true,
      trust: "user" as const,
      preset: false
    };
    const preflightServices = createPreflightServices({
      stateDirectory,
      currentPortfolio: async () => ({
        schemaVersion: 2,
        generatedAt: "2026-07-03T00:00:00.000Z",
        portfolioFingerprint: `sha256:${"c".repeat(64)}`,
        workspace: {
          path: "/workspace",
          identity: `sha256:${"f".repeat(64)}`
        },
        skills: [{
          id: "security-installed",
          name: "security-review",
          description: "Review security vulnerabilities",
          path: "/skills/security-review",
          root: "security-review",
          scope: "global",
          visibleTo: ["codex"],
          fingerprint: `sha256:${"d".repeat(64)}`,
          files: [],
          estimatedTokens: 200,
          ownership: "direct",
          sourceIds: ["codex:fixture"],
          exposures: [{
            harness: "codex",
            effectiveName: "security-review",
            state: "effective",
            sourceId: "codex:fixture",
            reason: "TEST_EFFECTIVE"
          }]
        }],
        findings: [],
        inventory: {
          sources: [{
            id: "codex:fixture",
            harness: "codex",
            scope: "global",
            kind: "direct-root",
            path: "/skills",
            status: "scanned",
            skillCount: 1,
            effectiveSkillCount: 1
          }],
          harnesses: [{
            harness: "codex",
            status: "verified",
            sourceIds: ["codex:fixture"],
            skillCount: 1,
            effectiveSkillCount: 1
          }]
        }
      }),
      catalogState: async () => ({
        sources: [source],
        snapshot: {
          schemaVersion: 1,
          generatedAt: "2026-07-03T00:00:00.000Z",
          sources: [{
            sourceId: source.id,
            status: "ready",
            commitSha: "a".repeat(40),
            refreshedAt: "2026-07-03T00:00:00.000Z",
            skillCount: 1
          }],
          skills: [{
            id: "testing-available",
            sourceId: source.id,
            sourceRevision: "a".repeat(40),
            relativePath: "testing",
            name: "testing-review",
            description: "Find missing tests",
            fingerprint: `sha256:${"e".repeat(64)}`,
            estimatedTokens: 180,
            scripts: [],
            executables: [],
            findings: [],
            compatibleHarnesses: ["codex"],
            compatibility: "declared"
          }]
        }
      }),
      id: () => "run-catalog",
      now: () => new Date("2026-07-03T00:00:00.000Z")
    });
    const { app } = createDashboardApp({ mutationToken: "token", preflightServices });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/preflights",
      headers: { "x-skill-steward-token": "token" },
      payload: {
        task: "Review security vulnerabilities and find missing tests",
        harness: "codex",
        includeAvailable: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      schemaVersion: 5,
      useCandidateIds: ["security-installed"],
      installCandidateIds: ["testing-available"]
    });
  });

  it("returns a reinspected installation preview without planning or committing", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "steward-catalog-preview-"));
    const source = {
      id: "fixture-catalog",
      name: "Fixture catalog",
      kind: "git" as const,
      url: "https://example.com/skills.git",
      enabled: true,
      trust: "user" as const,
      preset: false
    };
    const fingerprint = `sha256:${"f".repeat(64)}`;
    await writeCatalogSources(stateDirectory, [source]);
    await writeCatalogSnapshot(stateDirectory, {
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      sources: [{ sourceId: source.id, status: "ready", skillCount: 1 }],
      skills: [{
        id: "testing-available",
        sourceId: source.id,
        sourceRevision: "a".repeat(40),
        relativePath: "testing",
        name: "testing-review",
        description: "Find missing tests",
        fingerprint,
        estimatedTokens: 180,
        scripts: [],
        executables: [],
        findings: [],
        compatibleHarnesses: [],
        compatibility: "unknown"
      }]
    });
    await writeFile(join(stateDirectory, "preflights.json"), `${JSON.stringify({
      schemaVersion: 3,
      records: [{
        schemaVersion: 3,
        id: "run-1",
        createdAt: "2026-07-03T00:00:00.000Z",
        portfolioFingerprint: `sha256:${"a".repeat(64)}`,
        taskHash: `sha256:${"b".repeat(64)}`,
        taskCharacterCount: 20,
        taskTermCount: 3,
        algorithmVersion: 2,
        candidateIds: ["testing-available"],
        useCandidateIds: [],
        installCandidateIds: ["testing-available"]
      }]
    })}\n`, "utf8");
    const inspectInstallation = vi.fn(async (
      gitSource: Extract<InstallationSource, { kind: "git" }>,
      provenance?: InstallationProvenance
    ) => ({
      previewId: "preview-1",
      expiresAt: 10_000,
      source: gitSource,
      candidates: [{ id: "root", relativePath: ".", name: "testing-review", fingerprint }],
      ...(provenance ? { provenance } : {})
    }));
    const catalogServices = createCatalogServices({
      stateDirectory,
      inspect: async () => inspection,
      inspectInstallation
    });
    const { app } = createDashboardApp({ mutationToken: "token", catalogServices });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/catalog/candidates/testing-available/inspect-installation",
      headers: { "x-skill-steward-token": "token" },
      payload: { preflightId: "run-1" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      catalogCandidateId: "testing-available",
      previewId: "preview-1",
      provenance: {
        preflightId: "run-1",
        candidateId: "testing-available",
        sourceId: "fixture-catalog",
        sourceRevision: "a".repeat(40)
      },
      candidates: [expect.objectContaining({ id: "root", fingerprint })]
    });
    expect(inspectInstallation).toHaveBeenCalledWith(
      expect.anything(),
      {
        preflightId: "run-1",
        candidateId: "testing-available",
        sourceId: "fixture-catalog",
        sourceRevision: "a".repeat(40)
      }
    );
    await expect(catalogServices.inspectCandidate("testing-available", "missing"))
      .rejects.toMatchObject({ code: "CATALOG_PROVENANCE_INVALID" });

    const driftedServices = createCatalogServices({
      stateDirectory,
      inspect: async () => inspection,
      inspectInstallation: async (gitSource) => ({
        previewId: "preview-drifted",
        expiresAt: 10_000,
        source: { ...gitSource, ref: "b".repeat(40) },
        candidates: [{ id: "root", relativePath: ".", name: "testing-review", fingerprint }]
      })
    });
    await expect(driftedServices.inspectCandidate("testing-available"))
      .rejects.toMatchObject({ code: "CATALOG_CANDIDATE_DRIFTED" });
  });
});
