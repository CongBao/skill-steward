import { sha256 } from "@skill-steward/engine";
import {
  inspectStagedSkills,
  stagePublicGit,
  StagingRegistry,
  type InstallCandidate
} from "@skill-steward/installer";
import {
  catalogSkillRecordSchema,
  catalogSnapshotSchema,
  type CatalogSkillRecord,
  type CatalogSnapshot,
  type CatalogSource
} from "./domain.js";

export interface CatalogInspection {
  commitSha: string;
  candidates: InstallCandidate[];
}

export interface RefreshCatalogInput {
  sources: CatalogSource[];
  previous: CatalogSnapshot | null;
  now: Date;
  inspect(sourceId: string, source: CatalogSource): Promise<CatalogInspection>;
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "CATALOG_REFRESH_FAILED";
}

function normalizeCandidate(
  source: CatalogSource,
  commitSha: string,
  candidate: InstallCandidate
): CatalogSkillRecord | null {
  if (!candidate.fingerprint) return null;
  return catalogSkillRecordSchema.parse({
    id: sha256(`${source.id}:${candidate.relativePath}`),
    sourceId: source.id,
    sourceRevision: commitSha,
    relativePath: candidate.relativePath,
    name: candidate.name,
    description: candidate.description,
    fingerprint: candidate.fingerprint,
    estimatedTokens: candidate.estimatedTokens,
    scripts: candidate.scripts,
    executables: candidate.executables,
    findings: candidate.findings,
    compatibleHarnesses: [],
    compatibility: "unknown"
  });
}

export async function refreshCatalog(
  input: RefreshCatalogInput
): Promise<CatalogSnapshot> {
  const priorSkills = input.previous?.skills ?? [];
  const skills: CatalogSkillRecord[] = [];
  const states: CatalogSnapshot["sources"] = [];

  for (const source of input.sources) {
    if (!source.enabled) {
      states.push({ sourceId: source.id, status: "disabled", skillCount: 0 });
      continue;
    }

    try {
      const result = await input.inspect(source.id, source);
      const normalized = result.candidates
        .map((candidate) => normalizeCandidate(source, result.commitSha, candidate))
        .filter((candidate): candidate is CatalogSkillRecord => candidate !== null);
      skills.push(...normalized);
      states.push({
        sourceId: source.id,
        status: "ready",
        commitSha: result.commitSha,
        refreshedAt: input.now.toISOString(),
        skillCount: normalized.length
      });
    } catch (error) {
      const previous = priorSkills.filter(({ sourceId }) => sourceId === source.id);
      const previousState = input.previous?.sources.find(
        ({ sourceId }) => sourceId === source.id
      );
      skills.push(...previous);
      states.push({
        sourceId: source.id,
        status: previous.length ? "stale" : "error",
        ...(previousState?.commitSha ? { commitSha: previousState.commitSha } : {}),
        ...(previousState?.refreshedAt ? { refreshedAt: previousState.refreshedAt } : {}),
        errorCode: errorCode(error),
        skillCount: previous.length
      });
    }
  }

  return catalogSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    sources: states,
    skills
  });
}

export interface GitCatalogInspectorOptions {
  stateDirectory: string;
  previewTtlMs?: number;
}

export function createGitCatalogInspector(
  options: GitCatalogInspectorOptions
): RefreshCatalogInput["inspect"] {
  const registry = new StagingRegistry({ stateDirectory: options.stateDirectory });
  const previewTtlMs = options.previewTtlMs ?? 10 * 60 * 1_000;

  return async (_sourceId, source) => {
    const preview = await registry.create({ ttlMs: previewTtlMs });
    try {
      const staged = await stagePublicGit(preview.directory, {
        kind: "git",
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(source.subdirectory ? { subdirectory: source.subdirectory } : {})
      });
      return {
        commitSha: staged.commitSha,
        candidates: await inspectStagedSkills(staged.sourceDirectory)
      };
    } finally {
      await registry.expire(preview.id);
    }
  };
}
