import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { portfolioReportV2Schema } from "../src/domain.js";
import {
  scanInventory,
  scanInventoryPlan,
  scanInventoryWithDiscovery,
  scanPortfolio
} from "../src/analyze.js";
import { buildInventoryPlan } from "../src/inventory/plan.js";

describe("scanPortfolio", () => {
  it("returns valid skills and a finding for an invalid skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-scan-"));
    await mkdir(join(root, "valid"));
    await mkdir(join(root, "invalid"));
    await writeFile(join(root, "valid", "SKILL.md"), "---\nname: valid\ndescription: Valid skill\n---\n");
    await writeFile(join(root, "invalid", "SKILL.md"), "invalid");

    const report = await scanPortfolio(
      [{ path: root, scope: "project", visibleTo: ["agents"] }],
      new Date("2026-07-02T00:00:00.000Z")
    );

    expect(report.skills).toHaveLength(1);
    expect(report.schemaVersion).toBe(2);
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(true);
    expect(report.skills[0]).not.toHaveProperty("body");
    expect(report.findings.some((finding) => finding.code === "SKILL_PARSE_FAILED")).toBe(true);
    expect(report.inventory.sources).toEqual([
      expect.objectContaining({
        status: "scanned",
        skillCount: 1,
        effectiveSkillCount: 0
      })
    ]);
    expect(report.inventory.harnesses).toEqual([
      expect.objectContaining({
        harness: "agents",
        status: "convention-only",
        skillCount: 1,
        effectiveSkillCount: 0
      })
    ]);
  });

  it("produces the same portfolio fingerprint for unchanged content", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-stable-"));
    await mkdir(join(root, "stable"));
    await writeFile(join(root, "stable", "SKILL.md"), "---\nname: stable\ndescription: Stable skill\n---\n");

    const first = await scanPortfolio([{ path: root, scope: "project", visibleTo: ["agents"] }]);
    const second = await scanPortfolio([{ path: root, scope: "project", visibleTo: ["agents"] }]);

    expect(first.portfolioFingerprint).toBe(second.portfolioFingerprint);
    expect(first.generatedAt).not.toBe("");
  });

  it("changes the portfolio fingerprint when visibility evidence changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-visibility-fingerprint-"));
    await mkdir(join(root, "stable"));
    await writeFile(
      join(root, "stable", "SKILL.md"),
      "---\nname: stable\ndescription: Stable skill\n---\n"
    );

    const agents = await scanPortfolio([
      { path: root, scope: "project", visibleTo: ["agents"] }
    ]);
    const cursor = await scanPortfolio([
      { path: root, scope: "project", visibleTo: ["cursor"] }
    ]);

    expect(agents.skills[0]?.fingerprint).toBe(cursor.skills[0]?.fingerprint);
    expect(agents.portfolioFingerprint).not.toBe(cursor.portfolioFingerprint);
  });

  it("scans a composed native plan once and emits a strict v2 report", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "steward-native-scan-"));
    const root = join(workspace, ".agents", "skills");
    await mkdir(join(root, "review"), { recursive: true });
    await writeFile(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\n"
    );
    const report = await scanInventory({
      home: workspace,
      cwd: workspace,
      plannerOverrides: {
        codex: async () => ({
          sources: [{
            id: "codex:test",
            harness: "codex",
            scope: "project",
            kind: "direct-root",
            path: root,
            layout: "children",
            ownership: "direct",
            precedenceRank: 0,
            status: "scanned"
          }]
        }),
        claude: async () => ({ sources: [] }),
        copilot: async () => ({ sources: [] })
      }
    }, new Date("2026-07-04T00:00:00.000Z"));

    expect(report.workspace.path).toBe(await realpath(workspace));
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.visibleTo).toEqual(["codex"]);
    expect(portfolioReportV2Schema.safeParse(report).success).toBe(true);
  });

  it("returns malformed physical candidates while retaining parse findings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "steward-native-discovery-"));
    const root = join(workspace, "native-skills");
    const broken = join(root, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "SKILL.md"), "invalid frontmatter");
    const calls: string[] = [];

    const result = await scanInventoryWithDiscovery({
      home: workspace,
      cwd: workspace,
      plannerOverrides: {
        codex: async () => {
          calls.push("codex");
          return { sources: [{
            id: "codex:broken",
            harness: "codex",
            scope: "global",
            kind: "native-plugin",
            path: root,
            layout: "children",
            ownership: "native-plugin",
            plugin: { id: "broken@fixture", version: "1" },
            precedenceRank: 0,
            status: "scanned"
          }] };
        },
        claude: async () => {
          calls.push("claude");
          return { sources: [] };
        },
        copilot: async () => {
          calls.push("copilot");
          return { sources: [] };
        }
      }
    });

    expect(calls).toEqual(["codex", "claude", "copilot"]);
    expect(result.discoveries).toEqual([{
      path: await realpath(broken),
      roots: [{ path: root, scope: "global", visibleTo: ["codex"] }]
    }]);
    expect(result.report.skills).toEqual([]);
    expect(result.report.findings).toContainEqual(expect.objectContaining({
      code: "SKILL_PARSE_FAILED"
    }));
  });

  it("refuses a prebuilt plan outside its canonical home and workspace authority", async () => {
    const first = await mkdtemp(join(tmpdir(), "steward-plan-authority-a-"));
    const second = await mkdtemp(join(tmpdir(), "steward-plan-authority-b-"));
    const plan = await buildInventoryPlan({ home: first, cwd: first });

    await expect(scanInventoryPlan({
      home: first,
      cwd: second,
      plan
    })).rejects.toMatchObject({
      code: "INVENTORY_PLAN_AUTHORITY_MISMATCH"
    });
    await expect(scanInventoryPlan({
      home: second,
      cwd: first,
      plan
    })).rejects.toMatchObject({
      code: "INVENTORY_PLAN_AUTHORITY_MISMATCH"
    });
    await expect(scanInventoryPlan({
      home: first,
      cwd: first,
      plan: { sources: plan.sources }
    })).rejects.toMatchObject({
      code: "INVENTORY_PLAN_AUTHORITY_MISMATCH"
    });
  });

  it("cannot redirect adapter home or cwd through child options", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "steward-plan-paths-"));
    const escaped = await mkdtemp(join(tmpdir(), "steward-plan-escape-"));
    const observed: Array<{ adapter: string; home: string; cwd: string }> = [];
    const report = await scanInventory({
      home: workspace,
      cwd: workspace,
      codex: { home: escaped, cwd: escaped } as never,
      claude: { home: escaped, cwd: escaped } as never,
      copilot: { home: escaped, cwd: escaped } as never,
      plannerOverrides: {
        codex: async (input) => {
          observed.push({ adapter: "codex", home: input.home, cwd: input.cwd });
          return { sources: [] };
        },
        claude: async (input) => {
          observed.push({ adapter: "claude", home: input.home, cwd: input.cwd });
          return { sources: [] };
        },
        copilot: async (input) => {
          observed.push({ adapter: "copilot", home: input.home, cwd: input.cwd });
          return { sources: [] };
        }
      }
    });

    expect(observed).toEqual([
      { adapter: "codex", home: workspace, cwd: workspace },
      { adapter: "claude", home: workspace, cwd: workspace },
      { adapter: "copilot", home: workspace, cwd: workspace }
    ]);
    expect(report.workspace.path).toBe(await realpath(workspace));
    expect(report.workspace.path).not.toBe(await realpath(escaped));
  });

  it("keeps multi-owner portfolio fingerprints stable without self-conflicts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "steward-multi-owner-"));
    const root = join(workspace, "native-skills");
    await mkdir(join(root, "review"), { recursive: true });
    await writeFile(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\n"
    );
    const scan = () => scanInventory({
      home: workspace,
      cwd: workspace,
      plannerOverrides: {
        codex: async () => ({
          sources: [{
            id: "codex:direct",
            harness: "codex",
            scope: "project",
            kind: "direct-root",
            path: root,
            layout: "children",
            ownership: "direct",
            precedenceRank: 0,
            status: "scanned"
          }, {
            id: "codex:plugin",
            harness: "codex",
            scope: "global",
            kind: "native-plugin",
            path: root,
            layout: "children",
            ownership: "native-plugin",
            plugin: { id: "review@vendor", version: "1" },
            precedenceRank: 1,
            status: "scanned"
          }]
        }),
        claude: async () => ({
          sources: [{
            id: "claude:plugin",
            harness: "claude",
            scope: "global",
            kind: "native-plugin",
            path: root,
            layout: "children",
            ownership: "native-plugin",
            plugin: { id: "quality@team", version: "2" },
            pluginNamespace: "quality",
            precedenceRank: 0,
            status: "scanned"
          }]
        }),
        copilot: async () => ({ sources: [] })
      }
    });
    const first = await scan();
    const second = await scan();

    expect(first.portfolioFingerprint).toBe(second.portfolioFingerprint);
    expect(portfolioReportV2Schema.safeParse(first).success).toBe(true);
    expect(first.inventory.harnesses.find(({ harness }) => harness === "codex"))
      .toMatchObject({ skillCount: 1, effectiveSkillCount: 1 });
    const selfConflictCodes = new Set([
      "DUPLICATE_SKILL_CONTENT",
      "DUPLICATE_SKILL_NAME",
      "HIGH_DESCRIPTION_OVERLAP",
      "SCOPE_SHADOWING"
    ]);
    expect(first.findings.some(({ code }) => selfConflictCodes.has(code)))
      .toBe(false);
  });
});
