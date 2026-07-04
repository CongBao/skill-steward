import { describe, expect, it } from "vitest";
import {
  portfolioReportV2Schema,
  type HarnessId,
  type InventorySource,
  type ParsedSkill
} from "../src/domain.js";
import type {
  InventoryCandidate,
  InventoryPlan,
  InventoryPlanSource
} from "../src/inventory/domain.js";
import { activeMutableRoots, buildInventoryPlan } from "../src/index.js";
import {
  resolveInventory,
  type ParsedInventoryCandidate
} from "../src/inventory/resolve.js";
import { analyzeOverlap } from "../src/overlap.js";
import * as engineApi from "../src/index.js";

const fingerprint = `sha256:${"a".repeat(64)}`;

function planSource(input: {
  id: string;
  harness: HarnessId;
  path: string;
  scope?: "global" | "project";
  kind?: InventoryPlanSource["kind"];
  ownership?: InventoryPlanSource["ownership"];
  status?: InventoryPlanSource["status"];
  rank?: number;
  plugin?: { id: string; version?: string };
  namespace?: string;
  qualification?: string;
  excludedChildPaths?: string[];
}): InventoryPlanSource {
  return {
    id: input.id,
    harness: input.harness,
    scope: input.scope ?? "project",
    kind: input.kind ?? "direct-root",
    path: input.path,
    layout: "children",
    ownership: input.ownership ?? "direct",
    ...(input.plugin ? { plugin: input.plugin } : {}),
    ...(input.namespace ? { pluginNamespace: input.namespace } : {}),
    ...(input.qualification ? { pathQualification: input.qualification } : {}),
    ...(input.excludedChildPaths
      ? { excludedChildPaths: input.excludedChildPaths }
      : {}),
    precedenceRank: input.rank ?? 0,
    status: input.status ?? "scanned"
  };
}

function persisted(source: InventoryPlanSource): InventorySource {
  return {
    id: source.id,
    harness: source.harness,
    scope: source.scope,
    kind: source.kind,
    path: source.path,
    ...(source.plugin ? { plugin: source.plugin } : {}),
    status: source.status,
    skillCount: 0,
    effectiveSkillCount: 0,
    ...(source.diagnostic ? { diagnostic: source.diagnostic } : {})
  };
}

function candidate(
  path: string,
  name: string,
  sources: InventoryPlanSource[]
): ParsedInventoryCandidate {
  const inventoryCandidate: InventoryCandidate = {
    path,
    sourceIds: sources.map(({ id }) => id),
    roots: sources.map((source) => ({
      path: source.path,
      scope: source.scope,
      visibleTo: [source.harness]
    }))
  };
  const skill: ParsedSkill = {
    id: `skill:${path}`,
    name,
    description: `Use ${name} to review changes`,
    path,
    root: name,
    scope: sources[0]?.scope ?? "unknown",
    visibleTo: sources.map(({ harness }) => harness),
    fingerprint,
    files: [{ relativePath: "SKILL.md", sha256: fingerprint, bytes: 10 }],
    estimatedTokens: 10,
    body: "Review the change."
  };
  return { candidate: inventoryCandidate, skill };
}

function resolve(
  sources: InventoryPlanSource[],
  candidates: ParsedInventoryCandidate[],
  runtime?: InventoryPlan["runtime"]
) {
  return resolveInventory(
    { sources, ...(runtime ? { runtime } : {}) },
    sources.map(persisted),
    candidates
  );
}

function states(result: ReturnType<typeof resolveInventory>, harness: HarnessId) {
  return result.skills.flatMap((skill) => skill.exposures
    .filter((exposure) => exposure.harness === harness)
    .map((exposure) => ({
      skill: skill.name,
      effectiveName: exposure.effectiveName,
      state: exposure.state,
      shadowedBy: exposure.shadowedBy
    })));
}

describe("resolveInventory", () => {
  it("keeps same-name Codex instances effective", () => {
    const first = planSource({ id: "codex:first", harness: "codex", path: "/one" });
    const second = planSource({ id: "codex:second", harness: "codex", path: "/two", rank: 1 });
    const result = resolve(
      [first, second],
      [candidate("/one/review", "review", [first]), candidate("/two/review", "review", [second])]
    );

    expect(states(result, "codex").map(({ state }) => state)).toEqual([
      "effective",
      "effective"
    ]);
  });

  it("namespaces Claude plugins while global direct Skills beat project direct Skills", () => {
    const global = planSource({
      id: "claude:global",
      harness: "claude",
      path: "/global",
      scope: "global"
    });
    const project = planSource({
      id: "claude:project",
      harness: "claude",
      path: "/project",
      scope: "project",
      rank: 1
    });
    const plugin = planSource({
      id: "claude:plugin",
      harness: "claude",
      path: "/plugin",
      scope: "global",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "quality@team", version: "1.0.0" },
      namespace: "quality",
      rank: 2
    });
    const result = resolve(
      [global, project, plugin],
      [
        candidate("/global/review", "review", [global]),
        candidate("/project/review", "review", [project]),
        candidate("/plugin/review", "review", [plugin])
      ]
    );
    const claude = states(result, "claude");

    expect(claude).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectiveName: "review", state: "effective" }),
      expect.objectContaining({ effectiveName: "review", state: "shadowed" }),
      expect.objectContaining({ effectiveName: "quality:review", state: "effective" })
    ]));
    const winner = result.skills.find(({ path }) => path === "/global/review");
    expect(claude.find(({ state }) => state === "shadowed")?.shadowedBy).toBe(winner?.id);
  });

  it("keeps qualified nested Claude Skills distinct and fails same-tier direct ties closed", () => {
    const one = planSource({ id: "claude:one", harness: "claude", path: "/one", rank: 3 });
    const two = planSource({ id: "claude:two", harness: "claude", path: "/two", rank: 4 });
    const nested = planSource({
      id: "claude:nested",
      harness: "claude",
      path: "/repo/pkg/.claude/skills",
      rank: 5,
      qualification: "pkg"
    });
    const result = resolve(
      [one, two, nested],
      [
        candidate("/one/review", "review", [one]),
        candidate("/two/review", "review", [two]),
        candidate("/repo/pkg/.claude/skills/review", "review", [nested])
      ]
    );
    const claude = states(result, "claude");

    expect(claude.filter(({ effectiveName }) => effectiveName === "review")
      .map(({ state }) => state)).toEqual(["ambiguous", "ambiguous"]);
    expect(claude).toContainEqual(expect.objectContaining({
      effectiveName: "pkg:review",
      state: "effective"
    }));
  });

  it("uses Copilot first-found precedence and leaves tied plugin names ambiguous", () => {
    const project = planSource({
      id: "copilot:project",
      harness: "github-copilot",
      path: "/project",
      rank: 0
    });
    const pluginOne = planSource({
      id: "copilot:plugin-one",
      harness: "github-copilot",
      path: "/plugin-one",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "one@market" },
      rank: 10
    });
    const pluginTwo = planSource({
      id: "copilot:plugin-two",
      harness: "github-copilot",
      path: "/plugin-two",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "two@market" },
      rank: 10
    });
    const withProject = resolve(
      [project, pluginOne],
      [
        candidate("/project/review", "review", [project]),
        candidate("/plugin-one/review", "review", [pluginOne])
      ],
      {
        copilot: {
          disabledSkills: { status: "known", names: [] },
          extensions: [],
          customRoots: [],
          pluginOrder: "unverified",
          coverageLimitations: []
        }
      }
    );
    const pluginTie = resolve(
      [pluginOne, pluginTwo],
      [
        candidate("/plugin-one/review", "review", [pluginOne]),
        candidate("/plugin-two/review", "review", [pluginTwo])
      ],
      {
        copilot: {
          disabledSkills: { status: "known", names: [] },
          extensions: [],
          customRoots: [],
          pluginOrder: "unverified",
          coverageLimitations: []
        }
      }
    );

    expect(states(withProject, "github-copilot").map(({ state }) => state))
      .toEqual(["shadowed", "effective"]);
    expect(states(pluginTie, "github-copilot").map(({ state }) => state))
      .toEqual(["ambiguous", "ambiguous"]);
  });

  it("applies only known Copilot disabledSkills and treats unknown settings as ambiguity", () => {
    const source = planSource({
      id: "copilot:direct",
      harness: "github-copilot",
      path: "/direct"
    });
    const parsed = [candidate("/direct/review", "review", [source])];
    const known = resolve([source], parsed, {
      copilot: {
        disabledSkills: { status: "known", names: ["review"] },
        extensions: [],
        customRoots: [],
        pluginOrder: "unverified",
        coverageLimitations: []
      }
    });
    const unknown = resolve([source], parsed, {
      copilot: {
        disabledSkills: { status: "ambiguous" },
        extensions: [],
        customRoots: [],
        pluginOrder: "unverified",
        coverageLimitations: []
      }
    });

    expect(states(known, "github-copilot")[0]?.state).toBe("inactive");
    expect(states(unknown, "github-copilot")[0]?.state).toBe("ambiguous");
  });

  it("preserves aliases and plugin ownership without persisting runtime planning fields", () => {
    const plugin = planSource({
      id: "claude:plugin",
      harness: "claude",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "quality@team", version: "1.0.0" },
      namespace: "quality"
    });
    const direct = planSource({
      id: "codex:direct",
      harness: "codex",
      path: "/shared"
    });
    const result = resolve(
      [plugin, direct],
      [candidate("/shared/review", "review", [plugin, direct])]
    );
    const skill = result.skills[0];

    expect(skill).toMatchObject({
      ownership: "native-plugin",
      plugin: { harness: "claude", id: "quality@team", version: "1.0.0" },
      sourceIds: ["claude:plugin", "codex:direct"]
    });
    expect(JSON.stringify(result)).not.toContain("pluginNamespace");
  });

  it("splits conflicting physical plugin owners and makes every exposure ambiguous", () => {
    const codex = planSource({
      id: "codex:plugin",
      harness: "codex",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "review@vendor", version: "1" }
    });
    const claude = planSource({
      id: "claude:plugin",
      harness: "claude",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "quality@team", version: "2" },
      namespace: "quality"
    });
    const result = resolve(
      [codex, claude],
      [candidate("/shared/review", "review", [codex, claude])]
    );

    expect(result.skills).toHaveLength(2);
    expect(result.skills.every(({ ownership }) => ownership === "native-plugin")).toBe(true);
    expect(result.skills.flatMap(({ exposures }) => exposures)
      .every(({ state, reason }) =>
        state === "ambiguous" && reason === "PHYSICAL_PLUGIN_OWNERSHIP_AMBIGUOUS"
      )).toBe(true);
  });

  it("isolates a direct record from every conflicting plugin owner", () => {
    const direct = planSource({
      id: "codex:direct",
      harness: "codex",
      path: "/shared",
      ownership: "direct"
    });
    const codexPlugin = planSource({
      id: "codex:plugin",
      harness: "codex",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "review@vendor", version: "1" }
    });
    const claudePlugin = planSource({
      id: "claude:plugin",
      harness: "claude",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "quality@team", version: "2" },
      namespace: "quality"
    });
    const sources = [direct, codexPlugin, claudePlugin];
    const parsed = [candidate("/shared/review", "review", sources)];
    const first = resolve(sources, parsed);
    const second = resolve(sources, parsed);
    const directRecord = first.skills.find(({ ownership }) => ownership === "direct");
    const pluginRecords = first.skills.filter(({ ownership }) =>
      ownership === "native-plugin"
    );

    expect(first.skills).toHaveLength(3);
    expect(first.skills.map(({ id }) => id)).toEqual(second.skills.map(({ id }) => id));
    expect(directRecord).toMatchObject({
      sourceIds: ["codex:direct"],
      visibleTo: ["codex"],
      exposures: [expect.objectContaining({
        sourceId: "codex:direct",
        state: "effective"
      })]
    });
    expect(pluginRecords.map(({ sourceIds }) => sourceIds[0]).sort()).toEqual([
      "claude:plugin",
      "codex:plugin"
    ]);
    expect(pluginRecords.flatMap(({ exposures }) => exposures)
      .every(({ state, reason }) =>
        state === "ambiguous" && reason === "PHYSICAL_PLUGIN_OWNERSHIP_AMBIGUOUS"
      )).toBe(true);
    expect(first.sources.find(({ id }) => id === "codex:direct")).toMatchObject({
      skillCount: 1,
      effectiveSkillCount: 1
    });
    const overlapCodes = analyzeOverlap(first.skills).map(({ code }) => code);
    expect(overlapCodes).not.toContain("DUPLICATE_SKILL_CONTENT");
    expect(overlapCodes).not.toContain("DUPLICATE_SKILL_NAME");
    expect(overlapCodes).not.toContain("HIGH_DESCRIPTION_OVERLAP");
    expect(overlapCodes).not.toContain("SCOPE_SHADOWING");
    expect(first.coverage.find(({ harness }) => harness === "codex"))
      .toMatchObject({ skillCount: 1, effectiveSkillCount: 1 });
    expect(first.coverage).toEqual(second.coverage);

    const report = {
      schemaVersion: 2 as const,
      generatedAt: "2026-07-04T00:00:00.000Z",
      portfolioFingerprint: fingerprint,
      workspace: { path: "/repo", identity: fingerprint },
      skills: first.skills,
      findings: [],
      inventory: { sources: first.sources, harnesses: first.coverage }
    };
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(true);
  });

  it("counts same-path ambiguous plugin provenance once per Harness", () => {
    const firstPlugin = planSource({
      id: "codex:first-plugin",
      harness: "codex",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "first@vendor", version: "1" }
    });
    const secondPlugin = planSource({
      id: "codex:second-plugin",
      harness: "codex",
      path: "/shared",
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: "second@vendor", version: "1" }
    });
    const result = resolve(
      [firstPlugin, secondPlugin],
      [candidate("/shared/review", "review", [firstPlugin, secondPlugin])]
    );

    expect(result.coverage).toEqual([expect.objectContaining({
      harness: "codex",
      skillCount: 1,
      effectiveSkillCount: 0
    })]);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex:first-plugin",
        skillCount: 1,
        effectiveSkillCount: 0
      }),
      expect.objectContaining({
        id: "codex:second-plugin",
        skillCount: 1,
        effectiveSkillCount: 0
      })
    ]));
    expect(analyzeOverlap(result.skills)).toEqual([]);
  });

  it("maps terminal statuses to inactive or ambiguous and omits unproven terminal sources", () => {
    const disabled = planSource({
      id: "codex:disabled",
      harness: "codex",
      path: "/disabled",
      status: "disabled"
    });
    const stale = planSource({
      id: "claude:stale",
      harness: "claude",
      path: "/stale",
      status: "stale"
    });
    const truncated = planSource({
      id: "copilot:truncated",
      harness: "github-copilot",
      path: "/truncated",
      status: "truncated"
    });
    const invalid = planSource({
      id: "codex:invalid",
      harness: "codex",
      path: "/invalid",
      status: "invalid"
    });
    const result = resolve(
      [disabled, stale, truncated, invalid],
      [
        candidate("/disabled/review", "review", [disabled]),
        candidate("/stale/review", "review", [stale]),
        candidate("/truncated/review", "review", [truncated]),
        candidate("/invalid/review", "review", [invalid])
      ]
    );

    expect(states(result, "codex").find(({ skill }) => skill === "review")?.state)
      .toBe("inactive");
    expect(states(result, "claude")[0]?.state).toBe("inactive");
    expect(states(result, "github-copilot")[0]?.state).toBe("ambiguous");
    expect(result.skills.find(({ path }) => path === "/invalid/review")?.exposures)
      .toEqual([]);
  });

  it("uses the walker's terminal source status rather than stale plan-time status", () => {
    const source = planSource({
      id: "codex:walk-truncated",
      harness: "codex",
      path: "/partial",
      status: "scanned"
    });
    const walkedSource = {
      ...persisted(source),
      status: "truncated" as const,
      diagnostic: {
        code: "INVENTORY_SKILL_LIMIT",
        message: "Inventory Skill limit reached"
      }
    };
    const result = resolveInventory(
      { sources: [source] },
      [walkedSource],
      [candidate("/partial/review", "review", [source])]
    );

    expect(states(result, "codex")[0]).toMatchObject({
      state: "ambiguous"
    });
  });

  it("computes complete truthful coverage and schema-valid relationships", () => {
    const scanned = planSource({ id: "codex:scanned", harness: "codex", path: "/one" });
    const invalid = planSource({
      id: "codex:invalid",
      harness: "codex",
      path: "/bad",
      status: "invalid"
    });
    const convention = planSource({
      id: "cursor:root",
      harness: "cursor",
      path: "/cursor",
      kind: "convention-root"
    });
    const result = resolve(
      [scanned, invalid, convention],
      [
        candidate("/one/review", "review", [scanned]),
        candidate("/cursor/review", "review", [convention])
      ]
    );

    expect(result.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        harness: "codex",
        status: "partial",
        sourceIds: ["codex:invalid", "codex:scanned"],
        skillCount: 1,
        effectiveSkillCount: 1
      }),
      expect.objectContaining({
        harness: "cursor",
        status: "convention-only",
        sourceIds: ["cursor:root"],
        skillCount: 1,
        effectiveSkillCount: 0
      })
    ]));

    const report = {
      schemaVersion: 2 as const,
      generatedAt: "2026-07-04T00:00:00.000Z",
      portfolioFingerprint: fingerprint,
      workspace: { path: "/repo", identity: fingerprint },
      skills: result.skills,
      findings: [],
      inventory: { sources: result.sources, harnesses: result.coverage }
    };
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(true);
  });
});

describe("buildInventoryPlan", () => {
  it("shares plugin and directory budgets across all three adapters", async () => {
    const calls: Array<{ adapter: string; plugins: number; directories: number }> = [];
    const nativeSource = (
      id: string,
      harness: "codex" | "claude" | "github-copilot",
      pluginId: string
    ): InventoryPlanSource => planSource({
      id,
      harness,
      path: `/${id}`,
      kind: "native-plugin",
      ownership: "native-plugin",
      plugin: { id: pluginId }
    });
    const plan = await buildInventoryPlan({
      home: "/home/test",
      cwd: "/repo",
      limits: { maxPlugins: 3, maxDirectories: 10, maxSkills: 5 },
      plannerOverrides: {
        codex: async (input) => {
          calls.push({
            adapter: "codex",
            plugins: input.limits?.maxPlugins ?? -1,
            directories: input.limits?.maxDirectories ?? -1
          });
          return {
            sources: [
              nativeSource("codex:one", "codex", "one@market"),
              nativeSource("codex:two", "codex", "two@market")
            ],
            bounds: { maxDepth: 24, maxDirectories: 8, maxSkills: 1_000 }
          };
        },
        claude: async (input) => {
          calls.push({
            adapter: "claude",
            plugins: input.limits?.maxPlugins ?? -1,
            directories: input.limits?.maxDirectories ?? -1
          });
          return {
            sources: [nativeSource("claude:one", "claude", "one@team")],
            bounds: { maxDepth: 24, maxDirectories: 6, maxSkills: 1_000 }
          };
        },
        copilot: async (input) => {
          calls.push({
            adapter: "copilot",
            plugins: input.limits?.maxPlugins ?? -1,
            directories: input.limits?.maxDirectories ?? -1
          });
          return {
            sources: [],
            bounds: { maxDepth: 24, maxDirectories: 5, maxSkills: 1_000 }
          };
        }
      }
    });

    expect(calls).toEqual([
      { adapter: "codex", plugins: 3, directories: 10 },
      { adapter: "claude", plugins: 1, directories: 8 },
      { adapter: "copilot", plugins: 0, directories: 6 }
    ]);
    expect(plan.bounds).toEqual({ maxDepth: 24, maxDirectories: 5, maxSkills: 5 });
    expect(plan.sources.some(({ harness, kind }) =>
      harness === "cursor" && kind === "convention-root"
    )).toBe(true);
    expect(plan.sources.some(({ harness, kind }) =>
      harness === "codex" && kind === "convention-root"
    )).toBe(false);
  });

  it("returns only deduplicated active direct roots as mutable", () => {
    const codex = planSource({
      id: "codex:direct",
      harness: "codex",
      path: "/shared",
      scope: "global",
      excludedChildPaths: ["/shared/excluded-bundle"]
    });
    const agents = planSource({
      id: "agents:direct",
      harness: "agents",
      path: "/shared",
      scope: "global",
      kind: "convention-root"
    });
    const ambiguous = planSource({
      id: "claude:ambiguous",
      harness: "claude",
      path: "/ambiguous",
      status: "ambiguous"
    });
    const plugin = planSource({
      id: "codex:plugin",
      harness: "codex",
      path: "/shared/native-plugin",
      ownership: "native-plugin",
      kind: "native-plugin",
      plugin: { id: "review@vendor" }
    });
    const unsafeNativeKind = planSource({
      id: "unsafe:native-kind",
      harness: "codex",
      path: "/unsafe-native-kind",
      ownership: "direct",
      kind: "native-plugin"
    });

    expect(activeMutableRoots({
      sources: [plugin, unsafeNativeKind, ambiguous, codex, agents]
    }))
      .toEqual([{
        path: "/shared",
        scope: "global",
        visibleTo: ["agents", "codex"],
        excludedPaths: [
          "/shared/excluded-bundle",
          "/shared/native-plugin"
        ]
      }]);
  });

  it.each([
    ["equal", "/shared", "/shared"],
    ["native ancestor", "/shared/skills", "/shared"]
  ])("drops a direct mutable root when the native path is %s", (_label, direct, native) => {
    const root = planSource({
      id: "direct",
      harness: "agents",
      path: direct,
      scope: "global"
    });
    const plugin = planSource({
      id: "native",
      harness: "codex",
      path: native,
      scope: "global",
      ownership: "native-plugin",
      kind: "native-plugin"
    });

    expect(activeMutableRoots({ sources: [root, plugin] })).toEqual([]);
  });

  it("keeps overlap results stable across source and root ordering", () => {
    const outer = planSource({
      id: "outer",
      harness: "agents",
      path: "/shared",
      scope: "global"
    });
    const inner = planSource({
      id: "inner",
      harness: "codex",
      path: "/shared/team",
      scope: "global"
    });
    const nestedNative = planSource({
      id: "nested-native",
      harness: "codex",
      path: "/shared/team/native",
      scope: "global",
      ownership: "native-plugin",
      kind: "native-plugin"
    });
    const equalNative = planSource({
      id: "equal-native",
      harness: "claude",
      path: "/shared/team",
      scope: "global",
      ownership: "native-plugin",
      kind: "native-plugin"
    });
    const forward = activeMutableRoots({
      sources: [outer, inner, nestedNative, equalNative]
    });
    const reverse = activeMutableRoots({
      sources: [equalNative, nestedNative, inner, outer]
    });

    expect(reverse).toEqual(forward);
    expect(forward).toEqual([{
      path: "/shared",
      scope: "global",
      visibleTo: ["agents"],
      excludedPaths: ["/shared/team"]
    }]);
  });

  it("normalizes Windows case and separators in portable path relations", () => {
    const relation = Reflect.get(engineApi, "classifyPathRelation") as
      | ((root: string, candidate: string, platform: "win32") => string)
      | undefined;

    expect(relation).toBeTypeOf("function");
    expect(relation?.("C:\\Skills", "c:/skills", "win32")).toBe("equal");
    expect(relation?.("C:\\Skills", "c:/skills/plugin", "win32"))
      .toBe("candidate-descendant");
    expect(relation?.("C:\\Skills\\nested", "c:/skills", "win32"))
      .toBe("candidate-ancestor");
  });
});
