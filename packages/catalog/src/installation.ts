import {
  installationSourceSchema,
  InstallerError,
  type InstallCandidate,
  type InstallationSource
} from "@skill-steward/installer";
import type { CatalogInspection } from "./refresh.js";
import type { CatalogSkillRecord, CatalogSource } from "./domain.js";

type GitInstallationSource = Extract<InstallationSource, { kind: "git" }>;

export function catalogCandidateSource(
  candidate: CatalogSkillRecord,
  source: CatalogSource
): GitInstallationSource {
  if (candidate.sourceId !== source.id) {
    throw new InstallerError(
      "CATALOG_SOURCE_MISMATCH",
      "Catalog candidate source does not match"
    );
  }
  const subdirectory = [
    source.subdirectory,
    candidate.relativePath === "." ? undefined : candidate.relativePath
  ].filter((value): value is string => Boolean(value)).join("/");
  const parsed = installationSourceSchema.parse({
    kind: "git",
    url: source.url,
    ref: candidate.sourceRevision,
    ...(subdirectory ? { subdirectory } : {})
  });
  if (parsed.kind !== "git") {
    throw new InstallerError("INVALID_SOURCE", "Expected a Git installation source");
  }
  return parsed;
}

export function verifyCatalogCandidateInspection(
  candidate: CatalogSkillRecord,
  inspection: CatalogInspection
): InstallCandidate {
  const inspected = inspection.candidates[0];
  if (
    inspection.commitSha !== candidate.sourceRevision ||
    inspection.candidates.length !== 1 ||
    !inspected ||
    inspected.relativePath !== "." ||
    !inspected.fingerprint ||
    inspected.fingerprint !== candidate.fingerprint
  ) {
    throw new InstallerError(
      "CATALOG_CANDIDATE_DRIFTED",
      "Catalog candidate changed since the last reviewed refresh"
    );
  }
  return inspected;
}
