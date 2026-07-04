import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultInventoryScanBounds,
  inventorySourceSchema,
  type InventoryPlanSource
} from "../src/index.js";
import { walkInventory, walkLegacyInventory } from "../src/inventory/walk.js";

function source(
  id: string,
  path: string,
  layout: InventoryPlanSource["layout"] = "children"
): InventoryPlanSource {
  return {
    id,
    harness: "codex",
    scope: "project",
    kind: "direct-root",
    path,
    layout,
    ownership: "direct",
    precedenceRank: 100,
    status: "scanned"
  };
}

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`
  );
}

describe("source-aware inventory walking", () => {
  it("uses the accepted native inventory limits", () => {
    expect(defaultInventoryScanBounds).toEqual({
      maxDepth: 24,
      maxDirectories: 20_000,
      maxSkills: 1_000
    });
  });

  it.each([
    ["maxDepth", Number.NaN],
    ["maxDepth", Number.POSITIVE_INFINITY],
    ["maxDepth", -1],
    ["maxDepth", 1.5],
    ["maxDirectories", Number.NaN],
    ["maxDirectories", Number.POSITIVE_INFINITY],
    ["maxDirectories", -1],
    ["maxDirectories", 1.5],
    ["maxSkills", Number.NaN],
    ["maxSkills", Number.POSITIVE_INFINITY],
    ["maxSkills", -1],
    ["maxSkills", 1.5]
  ] as const)(
    "rejects invalid global bound %s=%s before discovery",
    async (field, value) => {
      const bounds = { maxDepth: 10, maxDirectories: 10, maxSkills: 10 };
      bounds[field] = value;
      await expect(walkInventory({
        sources: [],
        bounds
      })).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
    }
  );

  it("rejects invalid per-source and legacy bounds", async () => {
    const invalidSource = source("invalid-bounds", join(tmpdir(), "not-read"));
    invalidSource.bounds = { maxDepth: 1, maxDirectories: -1, maxSkills: 1 };

    await expect(walkInventory({ sources: [invalidSource] })).rejects.toMatchObject({
      code: "INVENTORY_INVALID_BOUNDS"
    });
    await expect(walkLegacyInventory({
      sources: [],
      bounds: { maxDepth: 1, maxDirectories: 1, maxSkills: 0.5 }
    })).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
  });

  it.each([
    ["maxDepth", 25],
    ["maxDirectories", 20_001],
    ["maxSkills", 1_001]
  ] as const)(
    "rejects global hard-max overflow %s=%s",
    async (field, value) => {
      const bounds = {
        maxDepth: 24,
        maxDirectories: 20_000,
        maxSkills: 1_000
      };
      bounds[field] = value;

      await expect(walkInventory({ sources: [], bounds })).rejects.toMatchObject({
        code: "INVENTORY_INVALID_BOUNDS"
      });
    }
  );

  it.each([
    ["maxDepth", 25],
    ["maxDirectories", 20_001],
    ["maxSkills", 1_001]
  ] as const)(
    "rejects per-source hard-max overflow %s=%s",
    async (field, value) => {
      const invalidSource = source(
        "over-max",
        join(tmpdir(), "must-not-be-read")
      );
      const bounds = {
        maxDepth: 24,
        maxDirectories: 20_000,
        maxSkills: 1_000
      };
      bounds[field] = value;
      invalidSource.bounds = bounds;

      await expect(
        walkInventory({ sources: [invalidSource] })
      ).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
    }
  );

  it.each([
    ["maxDepth", 25],
    ["maxDirectories", 20_001],
    ["maxSkills", 1_001]
  ] as const)(
    "rejects legacy hard-max overflow %s=%s",
    async (field, value) => {
      const bounds = {
        maxDepth: 24,
        maxDirectories: 20_000,
        maxSkills: 1_000
      };
      bounds[field] = value;

      await expect(
        walkLegacyInventory({ sources: [], bounds })
      ).rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
    }
  );

  it("supports a source root that is itself a Skill", async () => {
    const skill = await mkdtemp(join(tmpdir(), "steward-self-skill-"));
    await writeSkill(skill, "self");

    const result = await walkInventory({ sources: [source("self", skill, "self")] });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceIds: ["self"],
      path: await realpath(skill)
    });
    expect(result.sources[0]).toMatchObject({
      id: "self",
      status: "scanned",
      skillCount: 1,
      effectiveSkillCount: 0
    });
  });

  it("discovers only direct child Skills and never recurses through a discovered Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-child-skills-"));
    await writeSkill(join(root, "review"), "review");
    await writeSkill(join(root, "review", "nested"), "nested");
    await mkdir(join(root, "group", "deep"), { recursive: true });
    await writeSkill(join(root, "group", "deep"), "deep");

    const result = await walkInventory({ sources: [source("children", root)] });

    expect(result.candidates.map(({ path }) => path)).toEqual([
      await realpath(join(root, "review"))
    ]);
  });

  it.skipIf(process.platform === "win32")("preserves distinct planned source-root aliases while deduplicating physical candidates", async () => {
    const skill = await mkdtemp(join(tmpdir(), "steward-alias-skill-"));
    const alias = join(await mkdtemp(join(tmpdir(), "steward-alias-root-")), "alias");
    await writeSkill(skill, "alias");
    await symlink(skill, alias, "dir");

    const result = await walkInventory({
      sources: [source("first", skill, "self"), source("second", alias, "self")]
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceIds).toEqual(["first", "second"]);
    expect(result.candidates[0]?.roots).toHaveLength(2);
    expect(result.sources.map(({ skillCount }) => skillCount)).toEqual([1, 1]);
    expect(result.sources.map(({ path }) => path)).toEqual([skill, alias]);
  });

  it.skipIf(process.platform === "win32")("refuses child directory and SKILL.md symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-symlink-skill-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-outside-skill-"));
    await writeSkill(outside, "outside");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linkedFile = join(root, "linked-file");
    await mkdir(linkedFile);
    await symlink(join(outside, "SKILL.md"), join(linkedFile, "SKILL.md"), "file");

    const result = await walkInventory({ sources: [source("safe", root)] });

    expect(result.candidates).toEqual([]);
    expect(result.sources[0]?.status).toBe("scanned");
  });

  it("enforces a none root-symlink policy even without a trusted proof", async () => {
    const outside = await mkdtemp(join(tmpdir(), "steward-none-policy-outside-"));
    await writeSkill(join(outside, "review"), "review");
    const parent = await mkdtemp(join(tmpdir(), "steward-none-policy-alias-"));
    const alias = join(parent, "skills");
    await symlink(
      outside,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const planned = source("none-policy", alias);
    planned.symlinkPolicy = "none";

    const result = await walkInventory({ sources: [planned] });

    expect(result.candidates).toHaveLength(0);
    expect(result.sources[0]).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_SYMLINK" }
    });
  });

  it.skipIf(process.platform === "win32")("keeps refusing a symlinked SKILL.md in native inventory", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-native-marker-"));
    const root = join(base, "skills");
    const skill = join(root, "review");
    const marker = join(base, "shared-SKILL.md");
    await mkdir(skill, { recursive: true });
    await writeFile(marker, "---\nname: review\ndescription: Review code\n---\n");
    await symlink(marker, join(skill, "SKILL.md"), "file");

    const result = await walkInventory({ sources: [source("native", root)] });

    expect(result.candidates).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: "scanned", skillCount: 0 });
  });

  it("uses terminal statuses for missing, unreadable, and invalid sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-source-status-"));
    const invalid = join(root, "not-a-directory");
    await writeFile(invalid, "not a directory");

    const result = await walkInventory({
      sources: [
        source("missing", join(root, "missing")),
        source("unreadable", join(invalid, "child")),
        source("invalid", invalid)
      ]
    });

    expect(result.sources.map(({ status }) => status)).toEqual([
      "missing",
      "unreadable",
      "invalid"
    ]);
    expect(result.sources.map(({ diagnostic }) => diagnostic?.code)).toEqual([
      "INVENTORY_SOURCE_MISSING",
      "INVENTORY_SOURCE_UNREADABLE",
      "INVENTORY_SOURCE_NOT_DIRECTORY"
    ]);
  });

  it("keeps non-scanned sources non-walkable by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-inactive-default-"));
    await writeSkill(join(root, "inactive"), "inactive");
    const inactive = source("inactive", root);
    inactive.status = "disabled";

    const result = await walkInventory({ sources: [inactive] });

    expect(result.candidates).toEqual([]);
    expect(result.sources[0]).toMatchObject({
      status: "disabled",
      skillCount: 0
    });
  });

  it("walks explicitly inspectable non-effective roots and preserves terminal status", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-inactive-inspect-"));
    const skill = join(root, "inactive");
    await writeSkill(skill, "inactive");
    const inactive = source("inactive", root);
    inactive.status = "disabled";
    inactive.inspectSkills = true;

    const result = await walkInventory({ sources: [inactive] });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        path: await realpath(skill),
        sourceIds: ["inactive"]
      })
    ]);
    expect(result.sources[0]).toMatchObject({
      status: "disabled",
      skillCount: 1
    });
  });

  it("marks cap hits truncated while preserving already proven candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-skill-cap-"));
    await writeSkill(join(root, "a"), "a");
    await writeSkill(join(root, "b"), "b");

    const capped = source("capped", root);
    capped.bounds = { maxDepth: 1, maxDirectories: 10, maxSkills: 1 };
    const result = await walkInventory({ sources: [capped] });

    expect(result.candidates).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ status: "truncated", skillCount: 1 });
  });

  it("selects tight-cap children by locale-independent code-unit order", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-code-unit-order-"));
    for (const name of ["a", "Á", "B"]) await writeSkill(join(root, name), name);

    const ordered = source("ordered", root);
    ordered.bounds = { maxDepth: 1, maxDirectories: 3, maxSkills: 10 };
    const result = await walkInventory({ sources: [ordered] });

    expect(result.candidates.map(({ path }) => basename(path))).toEqual(["B", "a"]);
    expect(result.sources[0]?.status).toBe("truncated");
  });

  it("enforces directory and depth limits with stable truncation diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-directory-cap-"));
    await writeSkill(join(root, "a"), "a");
    await writeSkill(join(root, "b"), "b");

    const directoryCapped = source("directory", root);
    directoryCapped.bounds = { maxDepth: 1, maxDirectories: 2, maxSkills: 10 };
    const depthCapped = source("depth", root);
    depthCapped.bounds = { maxDepth: 0, maxDirectories: 10, maxSkills: 10 };
    const result = await walkInventory({ sources: [directoryCapped, depthCapped] });

    expect(result.candidates).toHaveLength(1);
    expect(result.sources).toEqual([
      expect.objectContaining({
        status: "truncated",
        skillCount: 1,
        diagnostic: expect.objectContaining({ code: "INVENTORY_DIRECTORY_LIMIT" })
      }),
      expect.objectContaining({
        status: "truncated",
        skillCount: 0,
        diagnostic: expect.objectContaining({ code: "INVENTORY_DEPTH_LIMIT" })
      })
    ]);
  });

  it("enforces Skill limits across sources in one inventory plan", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "steward-global-cap-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "steward-global-cap-second-"));
    await writeSkill(join(firstRoot, "first"), "first");
    await writeSkill(join(secondRoot, "second"), "second");

    const result = await walkInventory({
      sources: [source("first", firstRoot), source("second", secondRoot)],
      bounds: { maxDepth: 24, maxDirectories: 20_000, maxSkills: 1 }
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.sources.map(({ status }) => status)).toEqual(["scanned", "truncated"]);
  });

  it("retains aliases to a proven physical Skill at the unique-Skill cap", async () => {
    const skill = await mkdtemp(join(tmpdir(), "steward-capped-alias-"));
    await writeSkill(skill, "alias");

    const result = await walkInventory({
      sources: [source("first", skill, "self"), source("second", skill, "self")],
      bounds: { maxDepth: 24, maxDirectories: 20_000, maxSkills: 1 }
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceIds).toEqual(["first", "second"]);
    expect(result.sources.map(({ status }) => status)).toEqual(["scanned", "scanned"]);
  });

  it("continues bounded child inspection for known aliases after the unique-Skill cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-late-alias-"));
    const known = join(root, "z-known");
    await writeSkill(join(root, "a-new"), "new");
    await writeSkill(known, "known");

    const result = await walkInventory({
      sources: [source("known", known, "self"), source("children", root)],
      bounds: { maxDepth: 24, maxDirectories: 20_000, maxSkills: 1 }
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceIds).toEqual(["known", "children"]);
    expect(result.sources[1]).toMatchObject({
      status: "truncated",
      skillCount: 1,
      diagnostic: { code: "INVENTORY_SKILL_LIMIT" }
    });
  });

  it("persists schema-valid bounded diagnostics for long paths and adapter messages", async () => {
    const longPath = join(tmpdir(), "x".repeat(4_096));
    const preplanned = source("preplanned", join(tmpdir(), "unused"));
    preplanned.status = "invalid";
    preplanned.diagnostic = {
      code: "CUSTOM_ADAPTER_WARNING",
      message: "m".repeat(3_000)
    };

    const result = await walkInventory({
      sources: [source("long-path", longPath), preplanned]
    });

    for (const inventorySource of result.sources) {
      expect(() => inventorySourceSchema.parse(inventorySource)).not.toThrow();
      expect(inventorySource.diagnostic?.message.length).toBeLessThanOrEqual(2_000);
    }
    expect(result.sources[1]?.diagnostic).toMatchObject({
      code: "CUSTOM_ADAPTER_WARNING"
    });
    expect(result.sources[1]?.diagnostic?.message.endsWith("…")).toBe(true);
  });
});
