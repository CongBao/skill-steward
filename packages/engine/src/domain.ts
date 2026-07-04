import { z } from "zod";
import {
  openSpecToolDirectories,
  type OpenSpecToolId
} from "./tool-catalog.js";

export type HarnessId = "agents" | OpenSpecToolId | "unknown";

const harnessIds = [
  "agents",
  ...openSpecToolDirectories.map(({ id }) => id),
  "unknown"
] as [HarnessId, ...HarnessId[]];

export const harnessIdSchema = z.enum(harnessIds);

export const skillScopeSchema = z.enum(["global", "project", "unknown"]);
export const severitySchema = z.enum(["info", "warning", "error", "critical"]);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const stableCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/);

export const skillFileSchema = z.object({
  relativePath: z.string().min(1),
  sha256: fingerprintSchema,
  bytes: z.number().int().nonnegative()
}).strict();

export const skillRecordV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  root: z.string().min(1),
  scope: skillScopeSchema,
  visibleTo: z.array(harnessIdSchema),
  fingerprint: fingerprintSchema,
  files: z.array(skillFileSchema),
  estimatedTokens: z.number().int().nonnegative()
}).strict();

export const skillRecordSchema = skillRecordV1Schema;

export const inventorySourceStatusSchema = z.enum([
  "scanned",
  "missing",
  "unreadable",
  "invalid",
  "disabled",
  "stale",
  "ambiguous",
  "truncated"
]);

export const inventorySourceKindSchema = z.enum([
  "direct-root",
  "inherited-root",
  "admin-root",
  "native-plugin",
  "skills-directory-plugin",
  "convention-root"
]);

export const harnessExposureSchema = z.object({
  harness: harnessIdSchema,
  effectiveName: z.string().min(1),
  state: z.enum(["effective", "shadowed", "inactive", "ambiguous"]),
  sourceId: z.string().min(1),
  shadowedBy: z.string().min(1).optional(),
  reason: stableCodeSchema
}).strict();

const skillPluginSchema = z.object({
  harness: harnessIdSchema,
  id: z.string().min(1),
  version: z.string().min(1).optional()
}).strict();

const skillRecordV2BaseSchema = skillRecordV1Schema.extend({
  sourceIds: z.array(z.string().min(1)).min(1),
  exposures: z.array(harnessExposureSchema)
}).strict();

export const skillRecordV2Schema = z.discriminatedUnion("ownership", [
  skillRecordV2BaseSchema.extend({
    ownership: z.literal("direct")
  }).strict(),
  skillRecordV2BaseSchema.extend({
    ownership: z.literal("native-plugin"),
    plugin: skillPluginSchema
  }).strict()
]);

const sourcePluginSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional()
}).strict();

const inventoryDiagnosticSchema = z.object({
  code: stableCodeSchema,
  message: z.string().min(1).max(2000)
}).strict();

export const inventorySourceSchema = z.object({
  id: z.string().min(1),
  harness: harnessIdSchema,
  scope: skillScopeSchema,
  kind: inventorySourceKindSchema,
  path: z.string().min(1),
  manifestPath: z.string().min(1).optional(),
  plugin: sourcePluginSchema.optional(),
  status: inventorySourceStatusSchema,
  skillCount: z.number().int().nonnegative(),
  effectiveSkillCount: z.number().int().nonnegative(),
  diagnostic: inventoryDiagnosticSchema.optional()
}).strict();

export const harnessCoverageSchema = z.object({
  harness: harnessIdSchema,
  status: z.enum([
    "verified",
    "partial",
    "unavailable",
    "convention-only"
  ]),
  sourceIds: z.array(z.string().min(1)),
  skillCount: z.number().int().nonnegative(),
  effectiveSkillCount: z.number().int().nonnegative()
}).strict();

export const findingSchema = z.object({
  id: z.string().min(1),
  code: stableCodeSchema,
  severity: severitySchema,
  skillIds: z.array(z.string().min(1)),
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1)
}).strict();

export const findingLabelSchema = z.object({
  findingId: z.string().min(1),
  label: z.enum(["useful", "incorrect", "unclear", "already-known"]),
  createdAt: z.string().datetime(),
  comment: z.string().max(2000).optional()
});

export const portfolioReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  portfolioFingerprint: fingerprintSchema,
  skills: z.array(skillRecordV1Schema),
  findings: z.array(findingSchema)
}).strict();

const portfolioReportV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  portfolioFingerprint: fingerprintSchema,
  workspace: z.object({
    path: z.string().min(1),
    identity: fingerprintSchema
  }).strict(),
  skills: z.array(skillRecordV2Schema),
  findings: z.array(findingSchema),
  inventory: z.object({
    sources: z.array(inventorySourceSchema),
    harnesses: z.array(harnessCoverageSchema)
  }).strict()
}).strict();

type PortfolioReportV2Shape = z.infer<typeof portfolioReportV2BaseSchema>;

function addVisibilityIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function validateVisibilityReport(
  report: PortfolioReportV2Shape,
  context: z.RefinementCtx
): void {
  const sourceById = new Map<
    string,
    PortfolioReportV2Shape["inventory"]["sources"][number]
  >();

  report.inventory.sources.forEach((source, sourceIndex) => {
    if (sourceById.has(source.id)) {
      addVisibilityIssue(
        context,
        ["inventory", "sources", sourceIndex, "id"],
        "DUPLICATE_INVENTORY_SOURCE_ID"
      );
    } else {
      sourceById.set(source.id, source);
    }
    if (source.effectiveSkillCount > source.skillCount) {
      addVisibilityIssue(
        context,
        ["inventory", "sources", sourceIndex, "effectiveSkillCount"],
        "SOURCE_EFFECTIVE_SKILL_COUNT_EXCEEDS_SKILL_COUNT"
      );
    }
  });

  const skillIndexesById = new Map<string, number[]>();
  report.skills.forEach((skill, skillIndex) => {
    const indexes = skillIndexesById.get(skill.id);
    if (indexes) {
      indexes.push(skillIndex);
      addVisibilityIssue(
        context,
        ["skills", skillIndex, "id"],
        "DUPLICATE_SKILL_ID"
      );
    } else {
      skillIndexesById.set(skill.id, [skillIndex]);
    }
  });

  report.skills.forEach((skill, skillIndex) => {
    if (hasDuplicate(skill.sourceIds)) {
      addVisibilityIssue(
        context,
        ["skills", skillIndex, "sourceIds"],
        "DUPLICATE_SKILL_SOURCE_ID"
      );
    }

    for (const sourceId of skill.sourceIds) {
      if (!sourceById.has(sourceId)) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "sourceIds"],
          "UNKNOWN_SKILL_SOURCE_ID"
        );
      }
    }

    const exposureIdentities = new Set<string>();
    skill.exposures.forEach((exposure, exposureIndex) => {
      const identity = JSON.stringify([
        exposure.harness,
        exposure.sourceId,
        exposure.effectiveName
      ]);
      if (exposureIdentities.has(identity)) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "exposures", exposureIndex],
          "DUPLICATE_SKILL_EXPOSURE_IDENTITY"
        );
      } else {
        exposureIdentities.add(identity);
      }

      if (!skill.sourceIds.includes(exposure.sourceId)) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "exposures", exposureIndex, "sourceId"],
          "EXPOSURE_SOURCE_NOT_REFERENCED"
        );
      }
      const source = sourceById.get(exposure.sourceId);
      if (!source) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "exposures", exposureIndex, "sourceId"],
          "UNKNOWN_EXPOSURE_SOURCE_ID"
        );
      } else if (source.harness !== exposure.harness) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "exposures", exposureIndex, "sourceId"],
          "EXPOSURE_SOURCE_HARNESS_MISMATCH"
        );
      }

      if (exposure.shadowedBy !== undefined) {
        const targetIndexes = skillIndexesById.get(exposure.shadowedBy) ?? [];
        const issuePath = [
          "skills",
          skillIndex,
          "exposures",
          exposureIndex,
          "shadowedBy"
        ];
        if (targetIndexes.length === 0) {
          addVisibilityIssue(
            context,
            issuePath,
            "UNKNOWN_EXPOSURE_SHADOW_TARGET"
          );
        } else if (targetIndexes.length > 1) {
          addVisibilityIssue(
            context,
            issuePath,
            "AMBIGUOUS_EXPOSURE_SHADOW_TARGET"
          );
        } else if (targetIndexes[0] === skillIndex) {
          addVisibilityIssue(
            context,
            issuePath,
            "SELF_EXPOSURE_SHADOW_TARGET"
          );
        }
      }
    });

    if (skill.ownership === "native-plugin") {
      const matchingPluginSources = skill.sourceIds.flatMap((sourceId) => {
        const source = sourceById.get(sourceId);
        const matchesIdentity = (
          source?.kind === "native-plugin" ||
          source?.kind === "skills-directory-plugin"
        ) &&
          source.harness === skill.plugin.harness &&
          source.plugin?.id === skill.plugin.id;
        return matchesIdentity ? [source] : [];
      });
      if (matchingPluginSources.length === 0) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "plugin"],
          "NATIVE_PLUGIN_SOURCE_MISMATCH"
        );
      } else if (
        skill.plugin.version !== undefined &&
        matchingPluginSources.every((source) =>
          source.plugin?.version !== undefined &&
          source.plugin.version !== skill.plugin.version
        )
      ) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "plugin", "version"],
          "NATIVE_PLUGIN_VERSION_MISMATCH"
        );
      }
    } else {
      const referencesPluginSource = skill.sourceIds.some((sourceId) => {
        const source = sourceById.get(sourceId);
        return source !== undefined && (
          source.kind === "native-plugin" ||
          source.kind === "skills-directory-plugin" ||
          source.plugin !== undefined
        );
      });
      if (referencesPluginSource) {
        addVisibilityIssue(
          context,
          ["skills", skillIndex, "sourceIds"],
          "DIRECT_SKILL_PLUGIN_SOURCE"
        );
      }
    }
  });

  const coverageHarnesses = new Set<HarnessId>();
  report.inventory.harnesses.forEach((coverage, coverageIndex) => {
    if (coverageHarnesses.has(coverage.harness)) {
      addVisibilityIssue(
        context,
        ["inventory", "harnesses", coverageIndex, "harness"],
        "DUPLICATE_HARNESS_COVERAGE"
      );
    } else {
      coverageHarnesses.add(coverage.harness);
    }
    if (hasDuplicate(coverage.sourceIds)) {
      addVisibilityIssue(
        context,
        ["inventory", "harnesses", coverageIndex, "sourceIds"],
        "DUPLICATE_COVERAGE_SOURCE_ID"
      );
    }
    for (const sourceId of coverage.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) {
        addVisibilityIssue(
          context,
          ["inventory", "harnesses", coverageIndex, "sourceIds"],
          "UNKNOWN_COVERAGE_SOURCE_ID"
        );
      } else if (source.harness !== coverage.harness) {
        addVisibilityIssue(
          context,
          ["inventory", "harnesses", coverageIndex, "sourceIds"],
          "COVERAGE_SOURCE_HARNESS_MISMATCH"
        );
      }
    }
    if (coverage.effectiveSkillCount > coverage.skillCount) {
      addVisibilityIssue(
        context,
        ["inventory", "harnesses", coverageIndex, "effectiveSkillCount"],
        "COVERAGE_EFFECTIVE_SKILL_COUNT_EXCEEDS_SKILL_COUNT"
      );
    }
  });
}

export const portfolioReportV2Schema = portfolioReportV2BaseSchema.superRefine(
  validateVisibilityReport
);

const portfolioReportVersionSchema = z.discriminatedUnion("schemaVersion", [
  portfolioReportV1Schema,
  portfolioReportV2BaseSchema
]);

export const portfolioReportSchema = portfolioReportVersionSchema.superRefine(
  (report, context) => {
    if (report.schemaVersion === 2) validateVisibilityReport(report, context);
  }
);

export type SkillScope = z.infer<typeof skillScopeSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillRecord = z.infer<typeof skillRecordV1Schema>;
export type SkillRecordV2 = z.infer<typeof skillRecordV2Schema>;
export type InventorySource = z.infer<typeof inventorySourceSchema>;
export type HarnessExposure = z.infer<typeof harnessExposureSchema>;
export type HarnessCoverage = z.infer<typeof harnessCoverageSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type FindingLabel = z.infer<typeof findingLabelSchema>;
export type PortfolioReportV1 = z.infer<typeof portfolioReportV1Schema>;
export type PortfolioReportV2 = z.infer<typeof portfolioReportV2Schema>;
export type PortfolioReport = z.infer<typeof portfolioReportSchema>;

export function isVisibilityReport(
  report: PortfolioReport
): report is PortfolioReportV2 {
  return report.schemaVersion === 2;
}

export interface ParsedSkill extends SkillRecord {
  body: string;
}

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  visibleTo: HarnessId[];
}

export interface DiscoveredSkill {
  path: string;
  roots: SkillRoot[];
}

export interface ParseFailure {
  path: string;
  message: string;
}
