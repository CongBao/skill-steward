import {
  catalogSourceSchema,
  catalogCandidateSource,
  createGitCatalogInspector,
  refreshCatalog,
  verifyCatalogCandidateInspection,
  type CatalogSnapshot,
  type CatalogSource,
  type RefreshCatalogInput
} from "@skill-steward/catalog";
import type { InstallCandidate } from "@skill-steward/installer";
import {
  readCatalogSnapshot,
  readCatalogSources,
  writeCatalogSnapshot,
  writeCatalogSources
} from "@skill-steward/store";
import type {
  InspectionResult,
  InstallationServices
} from "./installation-services.js";

export type CatalogServiceErrorCode =
  | "CATALOG_SOURCE_EXISTS"
  | "CATALOG_SOURCE_NOT_FOUND"
  | "CATALOG_SOURCE_LIMIT"
  | "CATALOG_PRESET_REMOVE_FORBIDDEN"
  | "CATALOG_CANDIDATE_NOT_FOUND"
  | "CATALOG_CANDIDATE_DRIFTED"
  | "CATALOG_INSTALLATION_UNAVAILABLE";

export class CatalogServiceError extends Error {
  constructor(
    public readonly code: CatalogServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CatalogServiceError";
  }
}

export type CatalogCandidateInspection = InspectionResult & {
  catalogCandidateId: string;
};

export interface CatalogServices {
  list(): Promise<{ sources: CatalogSource[]; snapshot: CatalogSnapshot | null }>;
  add(source: CatalogSource): Promise<CatalogSource>;
  enable(id: string, enabled: boolean): Promise<CatalogSource>;
  remove(id: string): Promise<void>;
  refresh(): Promise<CatalogSnapshot>;
  inspectCandidate(id: string): Promise<CatalogCandidateInspection>;
}

export interface CatalogServiceOptions {
  stateDirectory: string;
  inspect?: RefreshCatalogInput["inspect"];
  inspectInstallation?: InstallationServices["inspectGit"];
  now?: () => Date;
}

export function createCatalogServices(
  options: CatalogServiceOptions
): CatalogServices {
  const inspect = options.inspect ?? createGitCatalogInspector({
    stateDirectory: options.stateDirectory
  });
  const now = options.now ?? (() => new Date());

  async function list() {
    const [sources, snapshot] = await Promise.all([
      readCatalogSources(options.stateDirectory),
      readCatalogSnapshot(options.stateDirectory)
    ]);
    return { sources, snapshot };
  }

  return {
    list,
    async add(input) {
      const source = catalogSourceSchema.parse({
        ...input,
        kind: "git",
        enabled: false,
        trust: "user",
        preset: false
      });
      const sources = await readCatalogSources(options.stateDirectory);
      if (sources.some(({ id }) => id === source.id)) {
        throw new CatalogServiceError(
          "CATALOG_SOURCE_EXISTS",
          `Catalog source '${source.id}' already exists`
        );
      }
      await writeCatalogSources(options.stateDirectory, [...sources, source]);
      return source;
    },
    async enable(id, enabled) {
      const sources = await readCatalogSources(options.stateDirectory);
      const index = sources.findIndex((source) => source.id === id);
      const source = sources[index];
      if (index < 0 || !source) {
        throw new CatalogServiceError(
          "CATALOG_SOURCE_NOT_FOUND",
          `Catalog source '${id}' was not found`
        );
      }
      if (enabled && !source.enabled && sources.filter((entry) => entry.enabled).length >= 5) {
        throw new CatalogServiceError(
          "CATALOG_SOURCE_LIMIT",
          "At most five catalog sources may be enabled"
        );
      }
      const updated = catalogSourceSchema.parse({ ...source, enabled });
      const next = [...sources];
      next[index] = updated;
      await writeCatalogSources(options.stateDirectory, next);
      return updated;
    },
    async remove(id) {
      const sources = await readCatalogSources(options.stateDirectory);
      const source = sources.find((entry) => entry.id === id);
      if (!source) {
        throw new CatalogServiceError(
          "CATALOG_SOURCE_NOT_FOUND",
          `Catalog source '${id}' was not found`
        );
      }
      if (source.preset) {
        throw new CatalogServiceError(
          "CATALOG_PRESET_REMOVE_FORBIDDEN",
          "Preset catalog sources can be disabled but not removed"
        );
      }
      await writeCatalogSources(
        options.stateDirectory,
        sources.filter((entry) => entry.id !== id)
      );
    },
    async refresh() {
      const current = await list();
      const snapshot = await refreshCatalog({
        sources: current.sources,
        previous: current.snapshot,
        now: now(),
        inspect
      });
      await writeCatalogSnapshot(options.stateDirectory, snapshot);
      return snapshot;
    },
    async inspectCandidate(id) {
      const current = await list();
      const candidate = current.snapshot?.skills.find((skill) => skill.id === id);
      if (!candidate) {
        throw new CatalogServiceError(
          "CATALOG_CANDIDATE_NOT_FOUND",
          `Catalog candidate '${id}' was not found`
        );
      }
      const source = current.sources.find((entry) => entry.id === candidate.sourceId);
      if (!source) {
        throw new CatalogServiceError(
          "CATALOG_SOURCE_NOT_FOUND",
          `Catalog source '${candidate.sourceId}' was not found`
        );
      }
      if (!options.inspectInstallation) {
        throw new CatalogServiceError(
          "CATALOG_INSTALLATION_UNAVAILABLE",
          "Catalog installation preview is unavailable"
        );
      }
      const gitSource = catalogCandidateSource(candidate, source);
      let preview: InspectionResult;
      try {
        preview = await options.inspectInstallation(gitSource);
      } catch {
        throw new CatalogServiceError(
          "CATALOG_CANDIDATE_DRIFTED",
          "Catalog candidate could not be reproduced at its recorded revision"
        );
      }
      try {
        if (preview.source.kind !== "git" || !preview.source.ref) {
          throw new Error("Installation preview did not retain the pinned revision");
        }
        verifyCatalogCandidateInspection(candidate, {
          commitSha: preview.source.ref,
          candidates: preview.candidates as InstallCandidate[]
        });
      } catch {
        throw new CatalogServiceError(
          "CATALOG_CANDIDATE_DRIFTED",
          "Catalog candidate changed since the last refresh"
        );
      }
      return { catalogCandidateId: candidate.id, ...preview };
    }
  };
}
