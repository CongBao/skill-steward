import { describe, expect, it } from "vitest";
import {
  findingLabelSchema,
  portfolioReportV2Schema,
  portfolioReportSchema,
  type PortfolioReportV2
} from "../src/domain.js";
import { isVisibilityReport } from "../src/index.js";

const v1Report = {
  schemaVersion: 1 as const,
  generatedAt: "2026-07-02T00:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  skills: [],
  findings: []
};

const sourceId = "codex:project:/repo/.agents/skills";
const v2Report = {
  schemaVersion: 2 as const,
  generatedAt: "2026-07-02T01:00:00.000Z",
  portfolioFingerprint: `sha256:${"b".repeat(64)}`,
  workspace: {
    path: "/repo",
    identity: `sha256:${"1".repeat(64)}`
  },
  skills: [{
    id: "skill-1",
    name: "review",
    description: "Review code",
    path: "/repo/.agents/skills/review",
    root: "review",
    scope: "project" as const,
    visibleTo: ["codex" as const],
    fingerprint: `sha256:${"c".repeat(64)}`,
    files: [],
    estimatedTokens: 10,
    ownership: "direct" as const,
    sourceIds: [sourceId],
    exposures: [{
      harness: "codex" as const,
      effectiveName: "review",
      state: "effective" as const,
      sourceId,
      reason: "DIRECT_SKILL"
    }]
  }],
  findings: [],
  inventory: {
    sources: [{
      id: sourceId,
      harness: "codex" as const,
      scope: "project" as const,
      kind: "direct-root" as const,
      path: "/repo/.agents/skills",
      status: "scanned" as const,
      skillCount: 1,
      effectiveSkillCount: 1
    }],
    harnesses: [{
      harness: "codex" as const,
      status: "verified" as const,
      sourceIds: [sourceId],
      skillCount: 1,
      effectiveSkillCount: 1
    }]
  }
} satisfies PortfolioReportV2;

const v2Skill = v2Report.skills[0]!;
const v2Source = v2Report.inventory.sources[0]!;
const v2Coverage = v2Report.inventory.harnesses[0]!;

function expectVisibilityIssue(report: unknown, message: string): void {
  const result = portfolioReportSchema.safeParse(report);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message })
    ]));
  }
}

function expectVisibilityIssueAt(
  report: unknown,
  message: string,
  path: (string | number)[]
): void {
  const result = portfolioReportSchema.safeParse(report);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(expect.arrayContaining([{
      code: "custom",
      message,
      path
    }]));
  }
}

function nativePluginReport(
  skillVersion: string | undefined,
  sourceVersion: string | undefined
) {
  const pluginSourceId = "codex:plugin:review@vendor";
  return {
    ...v2Report,
    skills: [{
      ...v2Skill,
      ownership: "native-plugin" as const,
      plugin: {
        harness: "codex" as const,
        id: "review@vendor",
        ...(skillVersion === undefined ? {} : { version: skillVersion })
      },
      sourceIds: [pluginSourceId],
      exposures: [{
        ...v2Skill.exposures[0]!,
        sourceId: pluginSourceId
      }]
    }],
    inventory: {
      ...v2Report.inventory,
      sources: [{
        ...v2Source,
        id: pluginSourceId,
        kind: "native-plugin" as const,
        plugin: {
          id: "review@vendor",
          ...(sourceVersion === undefined ? {} : { version: sourceVersion })
        },
        path: "/plugins/review"
      }],
      harnesses: [{ ...v2Coverage, sourceIds: [pluginSourceId] }]
    }
  };
}

describe("portfolioReportSchema", () => {
  it("parses visibility-aware v2 reports and legacy v1 reports", () => {
    expect(portfolioReportSchema.parse(v2Report)).toMatchObject({
      schemaVersion: 2,
      workspace: {
        path: "/repo",
        identity: `sha256:${"1".repeat(64)}`
      },
      inventory: {
        harnesses: [{ harness: "codex", status: "verified" }]
      }
    });
    expect(portfolioReportSchema.parse(v1Report).schemaVersion).toBe(1);
  });

  it("rejects an unsupported report schema version", () => {
    const result = portfolioReportSchema.safeParse({
      ...v1Report,
      schemaVersion: 3
    });

    expect(result.success).toBe(false);
  });

  it("strictly rejects fields outside the persisted report contract", () => {
    const legacyResult = portfolioReportSchema.safeParse({
      ...v1Report,
      skills: [{
        id: "skill-1",
        name: "review",
        description: "Review code",
        path: "/skills/review",
        root: "review",
        scope: "global",
        visibleTo: ["agents"],
        fingerprint: `sha256:${"b".repeat(64)}`,
        files: [],
        estimatedTokens: 10,
        body: "private instructions"
      }],
      findings: []
    });
    const visibilityResult = portfolioReportSchema.safeParse({
      ...v2Report,
      unexpected: true
    });

    expect(legacyResult.success).toBe(false);
    expect(visibilityResult.success).toBe(false);
  });

  it("requires stable uppercase exposure reason codes", () => {
    const result = portfolioReportSchema.safeParse({
      ...v2Report,
      skills: [{
        ...v2Report.skills[0]!,
        exposures: [{
          ...v2Report.skills[0]!.exposures[0]!,
          reason: "direct-skill"
        }]
      }]
    });

    expect(result.success).toBe(false);
  });

  it("identifies only schema-v2 reports as visibility reports", () => {
    expect(isVisibilityReport(portfolioReportSchema.parse(v2Report))).toBe(true);
    expect(isVisibilityReport(portfolioReportSchema.parse(v1Report))).toBe(false);
  });

  it("requires native-plugin ownership metadata and forbids it for direct Skills", () => {
    expect(portfolioReportSchema.safeParse({
      ...v2Report,
      skills: [{ ...v2Skill, ownership: "native-plugin" }]
    }).success).toBe(false);
    expect(portfolioReportSchema.safeParse({
      ...v2Report,
      skills: [{
        ...v2Skill,
        plugin: { harness: "codex", id: "review@vendor" }
      }]
    }).success).toBe(false);
  });

  it("requires unique inventory source IDs", () => {
    const report = {
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        sources: [v2Source, { ...v2Source, path: "/repo/alias" }]
      }
    };

    expectVisibilityIssue(report, "DUPLICATE_INVENTORY_SOURCE_ID");
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(false);
  });

  it("requires unique per-Skill and per-coverage source IDs", () => {
    expectVisibilityIssue({
      ...v2Report,
      skills: [{ ...v2Skill, sourceIds: [sourceId, sourceId] }]
    }, "DUPLICATE_SKILL_SOURCE_ID");
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        harnesses: [{
          ...v2Coverage,
          sourceIds: [sourceId, sourceId]
        }]
      }
    }, "DUPLICATE_COVERAGE_SOURCE_ID");
  });

  it("requires every schema-v2 Skill ID to be unique", () => {
    const duplicate = {
      ...v2Skill,
      path: "/repo/.agents/skills/review-copy",
      fingerprint: `sha256:${"d".repeat(64)}`
    };
    const report = { ...v2Report, skills: [v2Skill, duplicate] };

    expectVisibilityIssueAt(
      report,
      "DUPLICATE_SKILL_ID",
      ["skills", 1, "id"]
    );
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(false);
  });

  it("requires shadow targets to resolve to one distinct non-self Skill", () => {
    const shadowedSkill = (id: string, shadowedBy: string) => ({
      ...v2Skill,
      id,
      path: `/repo/.agents/skills/${id}`,
      visibleTo: [],
      fingerprint: `sha256:${(id === "loser" ? "d" : "e").repeat(64)}`,
      exposures: [{
        ...v2Skill.exposures[0]!,
        state: "shadowed" as const,
        shadowedBy
      }]
    });
    const missing = { ...v2Report, skills: [v2Skill, shadowedSkill("loser", "missing")] };
    const self = { ...v2Report, skills: [shadowedSkill("self", "self")] };
    const duplicateWinner = {
      ...v2Skill,
      path: "/repo/.agents/skills/review-copy",
      fingerprint: `sha256:${"f".repeat(64)}`
    };
    const ambiguous = {
      ...v2Report,
      skills: [v2Skill, duplicateWinner, shadowedSkill("loser", v2Skill.id)]
    };

    expectVisibilityIssueAt(
      missing,
      "UNKNOWN_EXPOSURE_SHADOW_TARGET",
      ["skills", 1, "exposures", 0, "shadowedBy"]
    );
    expectVisibilityIssueAt(
      self,
      "SELF_EXPOSURE_SHADOW_TARGET",
      ["skills", 0, "exposures", 0, "shadowedBy"]
    );
    expectVisibilityIssueAt(
      ambiguous,
      "AMBIGUOUS_EXPOSURE_SHADOW_TARGET",
      ["skills", 2, "exposures", 0, "shadowedBy"]
    );
  });

  it("requires each Skill exposure identity tuple to be unique", () => {
    expectVisibilityIssueAt({
      ...v2Report,
      skills: [{
        ...v2Skill,
        exposures: [v2Skill.exposures[0]!, { ...v2Skill.exposures[0]! }]
      }]
    }, "DUPLICATE_SKILL_EXPOSURE_IDENTITY", ["skills", 0, "exposures", 1]);
  });

  it("accepts multiple sources and exposures when every identity tuple is distinct", () => {
    const alternateSourceId = "codex:project:/repo/.codex/skills";
    const valid = {
      ...v2Report,
      skills: [{
        ...v2Skill,
        sourceIds: [sourceId, alternateSourceId],
        exposures: [
          v2Skill.exposures[0]!,
          { ...v2Skill.exposures[0]!, effectiveName: "review-alternate", state: "ambiguous" as const },
          { ...v2Skill.exposures[0]!, sourceId: alternateSourceId, state: "ambiguous" as const }
        ]
      }],
      inventory: {
        ...v2Report.inventory,
        sources: [v2Source, {
          ...v2Source,
          id: alternateSourceId,
          path: "/repo/.codex/skills"
        }],
        harnesses: [{
          ...v2Coverage,
          sourceIds: [sourceId, alternateSourceId]
        }]
      }
    };

    expect(portfolioReportSchema.safeParse(valid).success).toBe(true);
    expect(portfolioReportV2Schema.safeParse(valid).success).toBe(true);
  });

  it("requires every Skill source ID to exist in inventory", () => {
    expectVisibilityIssue({
      ...v2Report,
      skills: [{ ...v2Skill, sourceIds: [sourceId, "missing-source"] }]
    }, "UNKNOWN_SKILL_SOURCE_ID");
  });

  it("requires each exposure source to belong to its Skill", () => {
    const aliasId = "codex:project:/repo/alias";
    expectVisibilityIssue({
      ...v2Report,
      skills: [{
        ...v2Skill,
        exposures: [{ ...v2Skill.exposures[0]!, sourceId: aliasId }]
      }],
      inventory: {
        ...v2Report.inventory,
        sources: [v2Source, { ...v2Source, id: aliasId, path: "/repo/alias" }]
      }
    }, "EXPOSURE_SOURCE_NOT_REFERENCED");
  });

  it("requires each exposure source to exist in inventory", () => {
    expectVisibilityIssue({
      ...v2Report,
      skills: [{
        ...v2Skill,
        sourceIds: [sourceId, "missing-source"],
        exposures: [{
          ...v2Skill.exposures[0]!,
          sourceId: "missing-source"
        }]
      }]
    }, "UNKNOWN_EXPOSURE_SOURCE_ID");
  });

  it("requires each exposure source Harness to match the exposure Harness", () => {
    const claudeSourceId = "claude:project:/repo/.claude/skills";
    expectVisibilityIssue({
      ...v2Report,
      skills: [{
        ...v2Skill,
        sourceIds: [sourceId, claudeSourceId],
        exposures: [{
          ...v2Skill.exposures[0]!,
          sourceId: claudeSourceId
        }]
      }],
      inventory: {
        ...v2Report.inventory,
        sources: [v2Source, {
          ...v2Source,
          id: claudeSourceId,
          harness: "claude",
          path: "/repo/.claude/skills"
        }]
      }
    }, "EXPOSURE_SOURCE_HARNESS_MISMATCH");
  });

  it("requires native-plugin metadata to match a referenced native source", () => {
    const pluginSourceId = "codex:plugin:review@vendor";
    expectVisibilityIssue({
      ...v2Report,
      skills: [{
        ...v2Skill,
        ownership: "native-plugin",
        plugin: { harness: "codex", id: "other@vendor" },
        sourceIds: [pluginSourceId],
        exposures: [{
          ...v2Skill.exposures[0]!,
          sourceId: pluginSourceId
        }]
      }],
      inventory: {
        ...v2Report.inventory,
        sources: [{
          ...v2Source,
          id: pluginSourceId,
          kind: "native-plugin",
          plugin: { id: "review@vendor", version: "1.0.0" },
          path: "/plugins/review"
        }],
        harnesses: [{ ...v2Coverage, sourceIds: [pluginSourceId] }]
      }
    }, "NATIVE_PLUGIN_SOURCE_MISMATCH");
  });

  it.each(["native-plugin", "skills-directory-plugin"] as const)(
    "accepts native-plugin metadata with a matching referenced %s source",
    (pluginSourceKind) => {
      const pluginSourceId = "codex:plugin:review@vendor";
      const report = {
        ...v2Report,
        skills: [{
          ...v2Skill,
          ownership: "native-plugin" as const,
          plugin: { harness: "codex" as const, id: "review@vendor" },
          sourceIds: [pluginSourceId, sourceId],
          exposures: [{
            ...v2Skill.exposures[0]!,
            sourceId: pluginSourceId
          }]
        }],
        inventory: {
          ...v2Report.inventory,
          sources: [
            {
              ...v2Source,
              id: pluginSourceId,
              kind: pluginSourceKind,
              plugin: { id: "review@vendor", version: "1.0.0" },
              path: "/plugins/review"
            },
            v2Source
          ],
          harnesses: [{
            ...v2Coverage,
            sourceIds: [pluginSourceId, sourceId]
          }]
        }
      };

      expect(portfolioReportSchema.safeParse(report).success).toBe(true);
    }
  );

  it("rejects conflicting explicit native-plugin versions at the plugin version", () => {
    const report = nativePluginReport("2.0.0", "1.0.0");
    const result = portfolioReportSchema.safeParse(report);

    expectVisibilityIssueAt(
      report,
      "NATIVE_PLUGIN_VERSION_MISMATCH",
      ["skills", 0, "plugin", "version"]
    );
    if (!result.success) {
      expect(result.error.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "NATIVE_PLUGIN_SOURCE_MISMATCH" })
      ]));
    }
  });

  it.each([
    ["equal explicit versions", "1.0.0", "1.0.0"],
    ["omitted Skill version", undefined, "1.0.0"],
    ["omitted source version", "1.0.0", undefined],
    ["both versions omitted", undefined, undefined]
  ] as const)("accepts native-plugin provenance with %s", (
    _case,
    skillVersion,
    sourceVersion
  ) => {
    expect(portfolioReportSchema.safeParse(
      nativePluginReport(skillVersion, sourceVersion)
    ).success).toBe(true);
  });

  it("forbids direct ownership from referencing plugin sources", () => {
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        sources: [{
          ...v2Source,
          kind: "skills-directory-plugin",
          plugin: { id: "review@vendor" }
        }]
      }
    }, "DIRECT_SKILL_PLUGIN_SOURCE");
  });

  it("requires coverage sources to exist and belong to the coverage Harness", () => {
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        harnesses: [{ ...v2Coverage, sourceIds: ["missing-source"] }]
      }
    }, "UNKNOWN_COVERAGE_SOURCE_ID");
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        harnesses: [{
          ...v2Coverage,
          harness: "claude",
          sourceIds: [sourceId]
        }]
      }
    }, "COVERAGE_SOURCE_HARNESS_MISMATCH");
  });

  it("requires one coverage summary per Harness", () => {
    expectVisibilityIssueAt({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        harnesses: [v2Coverage, { ...v2Coverage, status: "partial" }]
      }
    }, "DUPLICATE_HARNESS_COVERAGE", [
      "inventory",
      "harnesses",
      1,
      "harness"
    ]);
  });

  it("caps effective Skill counts at physical Skill counts", () => {
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        sources: [{ ...v2Source, skillCount: 0, effectiveSkillCount: 1 }]
      }
    }, "SOURCE_EFFECTIVE_SKILL_COUNT_EXCEEDS_SKILL_COUNT");
    expectVisibilityIssue({
      ...v2Report,
      inventory: {
        ...v2Report.inventory,
        harnesses: [{
          ...v2Coverage,
          skillCount: 0,
          effectiveSkillCount: 1
        }]
      }
    }, "COVERAGE_EFFECTIVE_SKILL_COUNT_EXCEEDS_SKILL_COUNT");
  });
});

describe("findingLabelSchema", () => {
  it("accepts the four feedback values used by the alpha", () => {
    for (const label of ["useful", "incorrect", "unclear", "already-known"]) {
      expect(findingLabelSchema.safeParse({
        findingId: "finding-1",
        label,
        createdAt: "2026-07-02T00:00:00.000Z"
      }).success).toBe(true);
    }
  });
});
