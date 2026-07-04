import type {
  HarnessCoverage,
  HarnessExposure,
  HarnessId,
  InventorySource,
  ParsedSkill,
  SkillRecordV2,
  SkillScope
} from "../domain.js";
import { sha256 } from "../fingerprint.js";
import type {
  InventoryCandidate,
  InventoryPlan,
  InventoryPlanSource
} from "./domain.js";
import { compareCodeUnits } from "./selection.js";

export interface ParsedInventoryCandidate {
  candidate: InventoryCandidate;
  skill: ParsedSkill;
}

export interface ResolvedInventory {
  skills: SkillRecordV2[];
  sources: InventorySource[];
  coverage: HarnessCoverage[];
}

interface ExposureBinding {
  skill: MutableSkill;
  source: InventoryPlanSource;
  effectiveName: string;
  exposure?: HarnessExposure;
}

interface MutableSkill {
  record: SkillRecordV2;
  bindings: ExposureBinding[];
  ownershipConflict: boolean;
}

interface PluginOwner {
  key: string;
  harness: HarnessId;
  id: string;
  version?: string;
  sources: InventoryPlanSource[];
}

const noCandidateStatuses = new Set<InventorySource["status"]>([
  "invalid",
  "missing",
  "unreadable"
]);

const partialStatuses = new Set<InventorySource["status"]>([
  "ambiguous",
  "invalid",
  "truncated",
  "unreadable"
]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function mergedScope(sources: InventoryPlanSource[]): SkillScope {
  const scopes = new Set(sources.map(({ scope }) => scope));
  return scopes.size === 1 ? sources[0]?.scope ?? "unknown" : "unknown";
}

function pluginOwnerKey(source: InventoryPlanSource): string | undefined {
  if (source.ownership !== "native-plugin" || !source.plugin) return undefined;
  return [source.harness, source.plugin.id, source.plugin.version ?? ""].join("\0");
}

function pluginOwners(sources: InventoryPlanSource[]): PluginOwner[] {
  const owners = new Map<string, PluginOwner>();
  for (const source of sources) {
    const key = pluginOwnerKey(source);
    if (!key || !source.plugin) continue;
    const owner = owners.get(key);
    if (owner) {
      owner.sources.push(source);
      continue;
    }
    owners.set(key, {
      key,
      harness: source.harness,
      id: source.plugin.id,
      ...(source.plugin.version ? { version: source.plugin.version } : {}),
      sources: [source]
    });
  }
  return [...owners.values()].sort((left, right) =>
    compareCodeUnits(left.key, right.key)
  );
}

function effectiveName(skill: ParsedSkill, source: InventoryPlanSource): string {
  if (source.harness === "claude") {
    if (source.ownership === "native-plugin") {
      return source.pluginNamespace
        ? `${source.pluginNamespace}:${skill.name}`
        : skill.name;
    }
    if (source.pathQualification) {
      return `${source.pathQualification}:${skill.name}`;
    }
  }
  return skill.name;
}

function baseRecord(
  parsed: ParsedSkill,
  sources: InventoryPlanSource[],
  sourceIds: string[],
  owner: PluginOwner | undefined,
  ownershipConflict: boolean
): MutableSkill {
  const { body: _body, ...base } = parsed;
  const id = ownershipConflict && owner
    ? sha256(`${parsed.id}\0${owner.key}`)
    : parsed.id;
  const record: SkillRecordV2 = owner
    ? {
        ...base,
        id,
        scope: mergedScope(sources),
        visibleTo: [],
        ownership: "native-plugin",
        plugin: {
          harness: owner.harness,
          id: owner.id,
          ...(owner.version ? { version: owner.version } : {})
        },
        sourceIds,
        exposures: []
      }
    : {
        ...base,
        id,
        scope: mergedScope(sources),
        visibleTo: [],
        ownership: "direct",
        sourceIds,
        exposures: []
      };
  return { record, bindings: [], ownershipConflict };
}

function logicalSkills(
  parsed: ParsedInventoryCandidate,
  sourceById: ReadonlyMap<string, InventoryPlanSource>
): MutableSkill[] {
  const candidateSources = uniqueSorted(parsed.candidate.sourceIds)
    .flatMap((id) => {
      const source = sourceById.get(id);
      return source ? [source] : [];
    });
  const direct = candidateSources.filter(({ ownership }) => ownership === "direct");
  const owners = pluginOwners(candidateSources);
  if (owners.length === 0) {
    return [baseRecord(
      parsed.skill,
      candidateSources,
      candidateSources.map(({ id }) => id),
      undefined,
      false
    )];
  }

  const ownershipConflict = owners.length > 1;
  if (!ownershipConflict) {
    const owner = owners[0]!;
    const matching = candidateSources.filter((source) =>
      pluginOwnerKey(source) === owner.key
    );
    const sources = [...direct, ...matching].sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    );
    return [baseRecord(
      parsed.skill,
      sources,
      sources.map(({ id }) => id),
      owner,
      false
    )];
  }

  const records: MutableSkill[] = direct.length > 0
    ? [baseRecord(
        parsed.skill,
        direct,
        direct.map(({ id }) => id),
        undefined,
        false
      )]
    : [];
  for (const owner of owners) {
    const matching = candidateSources.filter((source) =>
      pluginOwnerKey(source) === owner.key
    );
    records.push(baseRecord(
      parsed.skill,
      matching,
      matching.map(({ id }) => id),
      owner,
      true
    ));
  }
  return records;
}

function exposure(
  binding: ExposureBinding,
  state: HarnessExposure["state"],
  reason: string,
  shadowedBy?: string
): void {
  binding.exposure = {
    harness: binding.source.harness,
    effectiveName: binding.effectiveName,
    state,
    sourceId: binding.source.id,
    ...(shadowedBy ? { shadowedBy } : {}),
    reason
  };
}

function terminalExposure(binding: ExposureBinding): boolean {
  if (noCandidateStatuses.has(binding.source.status)) return true;
  if (binding.skill.ownershipConflict) {
    exposure(
      binding,
      "ambiguous",
      "PHYSICAL_PLUGIN_OWNERSHIP_AMBIGUOUS"
    );
    return true;
  }
  switch (binding.source.status) {
    case "disabled":
      exposure(binding, "inactive", "SOURCE_DISABLED");
      return true;
    case "stale":
      exposure(binding, "inactive", "SOURCE_STALE");
      return true;
    case "ambiguous":
      exposure(binding, "ambiguous", "SOURCE_AMBIGUOUS");
      return true;
    case "truncated":
      exposure(binding, "ambiguous", "SOURCE_TRUNCATED");
      return true;
    default:
      return false;
  }
}

function uniqueSkills(bindings: ExposureBinding[]): Map<string, ExposureBinding[]> {
  const bySkill = new Map<string, ExposureBinding[]>();
  for (const binding of bindings) {
    const existing = bySkill.get(binding.skill.record.id);
    if (existing) existing.push(binding);
    else bySkill.set(binding.skill.record.id, [binding]);
  }
  return bySkill;
}

function resolveClaude(bindings: ExposureBinding[]): void {
  const directGroups = new Map<string, ExposureBinding[]>();
  for (const binding of bindings) {
    if (binding.source.ownership === "native-plugin") {
      if (!binding.source.pluginNamespace) {
        exposure(binding, "ambiguous", "CLAUDE_PLUGIN_NAMESPACE_UNKNOWN");
      } else {
        exposure(binding, "effective", "CLAUDE_PLUGIN_NAMESPACE");
      }
      continue;
    }
    const existing = directGroups.get(binding.effectiveName);
    if (existing) existing.push(binding);
    else directGroups.set(binding.effectiveName, [binding]);
  }

  for (const group of directGroups.values()) {
    const bySkill = uniqueSkills(group);
    const globalIds = new Set(group
      .filter(({ source }) => source.scope === "global")
      .map(({ skill }) => skill.record.id));
    if (globalIds.size > 1 || (globalIds.size === 0 && bySkill.size > 1)) {
      for (const binding of group) {
        exposure(binding, "ambiguous", "CLAUDE_DIRECT_PRECEDENCE_AMBIGUOUS");
      }
      continue;
    }
    const winnerId = globalIds.values().next().value as string | undefined ??
      bySkill.keys().next().value as string | undefined;
    if (!winnerId) continue;
    for (const binding of group) {
      if (binding.skill.record.id === winnerId) {
        exposure(binding, "effective", "CLAUDE_DIRECT_PRECEDENCE");
      } else {
        exposure(
          binding,
          "shadowed",
          "CLAUDE_DIRECT_SHADOWED",
          winnerId
        );
      }
    }
  }
}

function resolveCopilot(
  bindings: ExposureBinding[],
  runtime: NonNullable<InventoryPlan["runtime"]>["copilot"] | undefined
): void {
  const disabled = runtime?.disabledSkills ?? { status: "known" as const, names: [] };
  const disabledNames = disabled.status === "known"
    ? new Set(disabled.names)
    : undefined;
  const groups = new Map<string, ExposureBinding[]>();
  for (const binding of bindings) {
    if (!disabledNames) {
      exposure(binding, "ambiguous", "COPILOT_DISABLED_SKILLS_AMBIGUOUS");
      continue;
    }
    if (
      disabledNames.has(binding.effectiveName) ||
      disabledNames.has(binding.skill.record.name)
    ) {
      exposure(binding, "inactive", "COPILOT_SKILL_DISABLED");
      continue;
    }
    const existing = groups.get(binding.effectiveName);
    if (existing) existing.push(binding);
    else groups.set(binding.effectiveName, [binding]);
  }

  for (const group of groups.values()) {
    const bySkill = uniqueSkills(group);
    const ranks = new Map<string, number>();
    for (const [skillId, aliases] of bySkill) {
      ranks.set(skillId, Math.min(...aliases.map(({ source }) => source.precedenceRank)));
    }
    const bestRank = Math.min(...ranks.values());
    const winners = [...ranks.entries()]
      .filter(([, rank]) => rank === bestRank)
      .map(([id]) => id)
      .sort(compareCodeUnits);
    if (winners.length !== 1) {
      for (const binding of group) {
        exposure(binding, "ambiguous", "COPILOT_PRECEDENCE_AMBIGUOUS");
      }
      continue;
    }
    const winnerId = winners[0]!;
    for (const binding of group) {
      if (binding.skill.record.id === winnerId) {
        exposure(binding, "effective", "COPILOT_FIRST_FOUND");
      } else {
        exposure(binding, "shadowed", "COPILOT_SHADOWED", winnerId);
      }
    }
  }
}

function finalizeExposures(
  plan: InventoryPlan,
  skills: MutableSkill[],
  sourceById: ReadonlyMap<string, InventoryPlanSource>
): void {
  const pending = new Map<HarnessId, ExposureBinding[]>();
  for (const skill of skills) {
    for (const sourceId of skill.record.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) continue;
      const binding: ExposureBinding = {
        skill,
        source,
        effectiveName: effectiveName(
          { ...skill.record, body: "" },
          source
        )
      };
      skill.bindings.push(binding);
      if (terminalExposure(binding)) continue;
      if (source.kind === "convention-root") {
        exposure(binding, "ambiguous", "CONVENTION_PRECEDENCE_UNVERIFIED");
        continue;
      }
      const harnessBindings = pending.get(source.harness);
      if (harnessBindings) harnessBindings.push(binding);
      else pending.set(source.harness, [binding]);
    }
  }

  for (const [harness, bindings] of pending) {
    switch (harness) {
      case "codex":
        for (const binding of bindings) {
          exposure(binding, "effective", "CODEX_DISTINCT_SOURCE");
        }
        break;
      case "claude":
        resolveClaude(bindings);
        break;
      case "github-copilot":
        resolveCopilot(bindings, plan.runtime?.copilot);
        break;
      default:
        for (const binding of bindings) {
          exposure(binding, "ambiguous", "HARNESS_PRECEDENCE_UNVERIFIED");
        }
    }
  }

  for (const skill of skills) {
    skill.record.exposures = skill.bindings
      .flatMap(({ exposure: value }) => value ? [value] : [])
      .sort((left, right) =>
        compareCodeUnits(left.harness, right.harness) ||
        compareCodeUnits(left.effectiveName, right.effectiveName) ||
        compareCodeUnits(left.sourceId, right.sourceId)
      );
    skill.record.visibleTo = uniqueSorted(skill.record.exposures
      .filter(({ state }) => state === "effective")
      .map(({ harness }) => harness)) as HarnessId[];
  }
}

function coverageStatus(
  harness: HarnessId,
  sources: InventorySource[],
  skillCount: number,
  plan: InventoryPlan
): HarnessCoverage["status"] {
  if (sources.every(({ kind }) => kind === "convention-root")) {
    return "convention-only";
  }
  const limited = sources.some(({ status }) => partialStatuses.has(status)) ||
    (harness === "github-copilot" &&
      (plan.runtime?.copilot?.coverageLimitations.length ?? 0) > 0);
  if (!limited) return "verified";
  const trustworthy = skillCount > 0 || sources.some(({ status }) =>
    status === "scanned" || status === "missing" ||
    status === "disabled" || status === "stale"
  );
  return trustworthy ? "partial" : "unavailable";
}

function finalizeSourcesAndCoverage(
  plan: InventoryPlan,
  persistedSources: InventorySource[],
  skills: SkillRecordV2[]
): { sources: InventorySource[]; coverage: HarnessCoverage[] } {
  const skillIdsBySource = new Map<string, Set<string>>();
  const effectiveSkillIdsBySource = new Map<string, Set<string>>();
  for (const skill of skills) {
    for (const sourceId of skill.sourceIds) {
      const values = skillIdsBySource.get(sourceId) ?? new Set<string>();
      values.add(skill.id);
      skillIdsBySource.set(sourceId, values);
    }
    for (const exposureValue of skill.exposures) {
      if (exposureValue.state !== "effective") continue;
      const values = effectiveSkillIdsBySource.get(exposureValue.sourceId) ??
        new Set<string>();
      values.add(skill.id);
      effectiveSkillIdsBySource.set(exposureValue.sourceId, values);
    }
  }

  const sources = persistedSources.map((source) => ({
    ...source,
    skillCount: skillIdsBySource.get(source.id)?.size ?? 0,
    effectiveSkillCount: effectiveSkillIdsBySource.get(source.id)?.size ?? 0
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
  const harnesses = uniqueSorted(sources.map(({ harness }) => harness)) as HarnessId[];
  const coverage = harnesses.map((harness) => {
    const harnessSources = sources.filter((source) => source.harness === harness);
    const sourceIds = harnessSources.map(({ id }) => id).sort(compareCodeUnits);
    const harnessSkillPaths = new Set(skills
      .filter((skill) => skill.sourceIds.some((id) => sourceIds.includes(id)))
      .map(({ path }) => path));
    const effectiveSkillPaths = new Set(skills
      .filter((skill) => skill.exposures.some((exposureValue) =>
        exposureValue.harness === harness && exposureValue.state === "effective"
      ))
      .map(({ path }) => path));
    return {
      harness,
      status: coverageStatus(
        harness,
        harnessSources,
        harnessSkillPaths.size,
        plan
      ),
      sourceIds,
      skillCount: harnessSkillPaths.size,
      effectiveSkillCount: effectiveSkillPaths.size
    } satisfies HarnessCoverage;
  });
  return { sources, coverage };
}

export function resolveInventory(
  plan: InventoryPlan,
  persistedSources: InventorySource[],
  parsedCandidates: ParsedInventoryCandidate[]
): ResolvedInventory {
  const persistedById = new Map(persistedSources.map((source) => [source.id, source]));
  const sourceById = new Map(plan.sources.map((source) => {
    const persisted = persistedById.get(source.id);
    if (!persisted) return [source.id, source] as const;
    const resolutionSource: InventoryPlanSource = {
      ...source,
      status: persisted.status
    };
    if (persisted.diagnostic) {
      resolutionSource.diagnostic = persisted.diagnostic;
    } else {
      delete resolutionSource.diagnostic;
    }
    return [source.id, resolutionSource] as const;
  }));
  const mutableSkills = parsedCandidates.flatMap((parsed) =>
    logicalSkills(parsed, sourceById)
  );
  finalizeExposures(plan, mutableSkills, sourceById);
  const skills = mutableSkills.map(({ record }) => record).sort((left, right) =>
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.id, right.id)
  );
  const finalized = finalizeSourcesAndCoverage(plan, persistedSources, skills);
  return { skills, ...finalized };
}
