import type {
  CatalogSkillRecord,
  CatalogSource,
  CatalogTrust
} from "@skill-steward/catalog";
import type {
  Finding,
  HarnessId,
  PortfolioReport,
  SkillScope
} from "@skill-steward/engine";
import type { CandidateAvailability } from "./domain.js";

export interface AnalyzePreflightInputV2 {
  task: string;
  report: PortfolioReport;
  catalogSkills: CatalogSkillRecord[];
  catalogSources: CatalogSource[];
  harness?: HarnessId;
  includeAvailable?: boolean;
  maxSkills?: number;
  id: string;
  now: Date;
}

export interface NormalizedCandidateSource {
  sourceId: string;
  trust: CatalogTrust;
  url: string;
  revision: string;
  relativePath: string;
}

export interface NormalizedPreflightCandidate {
  candidateId: string;
  availability: CandidateAvailability;
  installedSkillId?: string;
  catalogSkillId?: string;
  name: string;
  description: string;
  scope: SkillScope;
  compatibleHarnesses: HarnessId[];
  compatibility: "declared" | "portable" | "unknown";
  fingerprint: string;
  contextTokens: number;
  scripts: string[];
  executables: string[];
  findings: Finding[];
  source?: NormalizedCandidateSource;
  harnessCompatible: boolean;
}

function supportsHarness(
  compatibleHarnesses: HarnessId[],
  harness: HarnessId | undefined
): boolean {
  return !harness || harness === "unknown" || compatibleHarnesses.length === 0 ||
    compatibleHarnesses.includes(harness);
}

export function normalizePreflightCandidates(
  input: AnalyzePreflightInputV2
): NormalizedPreflightCandidate[] {
  const installedFingerprints = new Set(input.report.skills.map(({ fingerprint }) => fingerprint));
  const installedIds = new Set(input.report.skills.map(({ id }) => id));
  const installed = input.report.skills.map((skill): NormalizedPreflightCandidate => {
    const findings = input.report.findings.filter(({ skillIds }) => skillIds.includes(skill.id));
    return {
      candidateId: skill.id,
      availability: "installed",
      installedSkillId: skill.id,
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      compatibleHarnesses: skill.visibleTo,
      compatibility: "declared",
      fingerprint: skill.fingerprint,
      contextTokens: skill.estimatedTokens,
      scripts: [],
      executables: [],
      findings,
      harnessCompatible: supportsHarness(skill.visibleTo, input.harness)
    };
  });

  if (input.includeAvailable === false) return installed;

  const sources = new Map(
    input.catalogSources.filter(({ enabled }) => enabled).map((source) => [source.id, source])
  );
  const available = input.catalogSkills.flatMap((skill): NormalizedPreflightCandidate[] => {
    const source = sources.get(skill.sourceId);
    if (!source || installedFingerprints.has(skill.fingerprint) || installedIds.has(skill.id)) {
      return [];
    }
    return [{
      candidateId: skill.id,
      availability: "available",
      catalogSkillId: skill.id,
      name: skill.name,
      description: skill.description,
      scope: "unknown",
      compatibleHarnesses: skill.compatibleHarnesses,
      compatibility: skill.compatibility,
      fingerprint: skill.fingerprint,
      contextTokens: skill.estimatedTokens,
      scripts: skill.scripts,
      executables: skill.executables,
      findings: skill.findings,
      source: {
        sourceId: source.id,
        trust: source.trust,
        url: source.url,
        revision: skill.sourceRevision,
        relativePath: skill.relativePath
      },
      harnessCompatible: supportsHarness(skill.compatibleHarnesses, input.harness)
    }];
  });

  return [...installed, ...available];
}
