import type {
  CatalogSkillRecord,
  CatalogSource,
  CatalogTrust
} from "@skill-steward/catalog";
import type {
  Finding,
  HarnessId,
  HarnessExposure,
  PortfolioReport,
  PortfolioReportV2,
  SkillRecordV2,
  SkillScope
} from "@skill-steward/engine";
import { sha256 } from "@skill-steward/engine";
import { PreflightError, type CandidateAvailability } from "./domain.js";

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
  rawInstalledSkillId?: string;
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
  harnessEligible: boolean;
  harnessVisibility?: HarnessExposure["state"];
  shadowedByCandidateId?: string;
}

function supportsHarness(
  compatibleHarnesses: HarnessId[],
  harness: HarnessId | undefined
): boolean {
  return !harness || harness === "unknown" || compatibleHarnesses.length === 0 ||
    compatibleHarnesses.includes(harness);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const SAFE_CANDIDATE_IDENTIFIER = /^[a-z0-9][a-z0-9._:@+-]{0,95}$/iu;

function isSafeCandidateIdentifier(value: string): boolean {
  return SAFE_CANDIDATE_IDENTIFIER.test(value);
}

interface InstalledIdentityEntry {
  skill: SkillRecordV2;
  index: number;
  recordHash: string;
}

function installedCandidateIdentities(
  skills: SkillRecordV2[]
): Map<SkillRecordV2, string> {
  const byRawId = new Map<string, InstalledIdentityEntry[]>();
  skills.forEach((skill, index) => {
    const entries = byRawId.get(skill.id) ?? [];
    entries.push({ skill, index, recordHash: sha256(JSON.stringify(skill)) });
    byRawId.set(skill.id, entries);
  });

  const identities = new Map<SkillRecordV2, string>();
  const used = new Set<string>();
  const derived: Array<InstalledIdentityEntry & {
    baseId: string;
    occurrence: number;
    rawId: string;
  }> = [];

  for (const [rawId, entries] of byRawId) {
    if (entries.length === 1 && isSafeCandidateIdentifier(rawId)) {
      identities.set(entries[0]!.skill, rawId);
      used.add(rawId);
      continue;
    }
    const ordered = [...entries].sort((left, right) =>
      compareCodeUnits(left.recordHash, right.recordHash) || left.index - right.index
    );
    ordered.forEach((entry, occurrence) => {
      derived.push({
        ...entry,
        rawId,
        occurrence,
        baseId: sha256([
          "skill-steward:preflight-candidate:v1",
          rawId,
          entry.recordHash,
          String(occurrence)
        ].join("\0"))
      });
    });
  }

  derived.sort((left, right) =>
    compareCodeUnits(left.baseId, right.baseId) ||
    compareCodeUnits(left.rawId, right.rawId) ||
    compareCodeUnits(left.recordHash, right.recordHash) ||
    left.occurrence - right.occurrence
  );
  for (const entry of derived) {
    let candidateId = entry.baseId;
    let collision = 0;
    while (used.has(candidateId)) {
      collision += 1;
      candidateId = sha256(`${entry.baseId}\0collision=${collision}`);
    }
    used.add(candidateId);
    identities.set(entry.skill, candidateId);
  }
  return identities;
}

function visibilityForHarness(
  skill: SkillRecordV2,
  harness: HarnessId | undefined,
  installedSkillsById: ReadonlyMap<string, SkillRecordV2[]>,
  candidateIdsBySkill: ReadonlyMap<SkillRecordV2, string>
): Pick<
  NormalizedPreflightCandidate,
  "harnessCompatible" | "harnessEligible" | "harnessVisibility" |
  "shadowedByCandidateId"
> {
  const exposures = [...(harness && harness !== "unknown"
    ? skill.exposures.filter((exposure) => exposure.harness === harness)
    : skill.exposures
  )].sort((left, right) =>
    compareCodeUnits(left.state, right.state) ||
    compareCodeUnits(left.shadowedBy ?? "", right.shadowedBy ?? "")
  );
  const effective = exposures.find(({ state }) => state === "effective");
  if (effective) {
    return {
      harnessCompatible: true,
      harnessEligible: true,
      harnessVisibility: "effective"
    };
  }
  const shadowed = exposures.filter(({ state }) => state === "shadowed");
  if (shadowed.length === exposures.length && shadowed.length > 0) {
    const targetIds = new Set(shadowed.flatMap(({ shadowedBy }) =>
      shadowedBy ? [shadowedBy] : []
    ));
    const targetId = targetIds.size === 1 ? [...targetIds][0] : undefined;
    const targetMatches = targetId && targetId !== skill.id
      && isSafeCandidateIdentifier(targetId)
      ? installedSkillsById.get(targetId) ?? []
      : [];
    const target = targetMatches.length === 1 ? targetMatches[0] : undefined;
    const verified = target && shadowed.every((exposure) =>
      exposure.shadowedBy === target.id && target.exposures.some((targetExposure) =>
        targetExposure.harness === exposure.harness &&
        targetExposure.effectiveName === exposure.effectiveName &&
        targetExposure.state === "effective"
      )
    );
    if (!verified) {
      return {
        harnessCompatible: false,
        harnessEligible: false,
        harnessVisibility: "ambiguous"
      };
    }
    return {
      harnessCompatible: false,
      harnessEligible: false,
      harnessVisibility: "shadowed",
      shadowedByCandidateId: candidateIdsBySkill.get(target)!
    };
  }
  if (exposures.length > 0 && exposures.every(({ state }) => state === "inactive")) {
    return {
      harnessCompatible: false,
      harnessEligible: false,
      harnessVisibility: "inactive"
    };
  }
  if (exposures.length > 0) {
    return {
      harnessCompatible: false,
      harnessEligible: false,
      harnessVisibility: "ambiguous"
    };
  }
  return {
    harnessCompatible: false,
    harnessEligible: false
  };
}

function requireVisibilityReport(report: PortfolioReport): PortfolioReportV2 {
  if (report.schemaVersion !== 2) {
    throw new PreflightError("INVENTORY_RESCAN_REQUIRED");
  }
  return report;
}

export function normalizePreflightCandidates(
  input: AnalyzePreflightInputV2
): NormalizedPreflightCandidate[] {
  const report = requireVisibilityReport(input.report);
  const candidateIdsBySkill = installedCandidateIdentities(report.skills);
  const installedSkillsById = new Map<string, SkillRecordV2[]>();
  for (const skill of report.skills) {
    const matches = installedSkillsById.get(skill.id) ?? [];
    matches.push(skill);
    installedSkillsById.set(skill.id, matches);
  }
  const visibilityBySkill = new Map(report.skills.map((skill) => [
    skill,
    visibilityForHarness(
      skill,
      input.harness,
      installedSkillsById,
      candidateIdsBySkill
    )
  ]));
  const eligibleSkills = report.skills.filter((skill) =>
    visibilityBySkill.get(skill)?.harnessEligible
  );
  const installedFingerprints = new Set(eligibleSkills.map(({ fingerprint }) => fingerprint));
  const installedIds = new Set(report.skills.flatMap((skill) => [
    skill.id,
    candidateIdsBySkill.get(skill)!
  ]));
  const installed = report.skills.map((skill): NormalizedPreflightCandidate => {
    const findings = report.findings.filter(({ skillIds }) => skillIds.includes(skill.id));
    const visibility = visibilityBySkill.get(skill)!;
    const candidateId = candidateIdsBySkill.get(skill)!;
    return {
      candidateId,
      availability: "installed",
      installedSkillId: candidateId,
      rawInstalledSkillId: skill.id,
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
      ...visibility
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
      harnessCompatible: supportsHarness(skill.compatibleHarnesses, input.harness),
      harnessEligible: supportsHarness(skill.compatibleHarnesses, input.harness)
    }];
  });

  return [...installed, ...available];
}
