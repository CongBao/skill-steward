import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventorySourceSchema } from "../src/domain.js";
import {
  planGitHubCopilotInventory
} from "../src/inventory/adapters/github-copilot.js";
import { walkInventory } from "../src/inventory/walk.js";

const fixtureRoot = fileURLToPath(
  new URL("fixtures/native-inventory/github-copilot", import.meta.url)
);

interface CopilotTree {
  root: string;
  home: string;
  repo: string;
  cwd: string;
  copilotHome: string;
  installed: string;
  config: string;
  userSettings: string;
  projectSettings: string;
  localSettings: string;
  sharedProjectSettings: string;
  sharedLocalSettings: string;
}

async function createTree(): Promise<CopilotTree> {
  const root = await mkdtemp(join(tmpdir(), "steward-copilot-inventory-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  const copilotHome = join(home, ".copilot");
  const installed = join(copilotHome, "installed-plugins");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(installed, { recursive: true });
  return {
    root,
    home,
    repo,
    cwd,
    copilotHome,
    installed,
    config: join(copilotHome, "config.json"),
    userSettings: join(copilotHome, "settings.json"),
    projectSettings: join(repo, ".github", "copilot", "settings.json"),
    localSettings: join(repo, ".github", "copilot", "settings.local.json"),
    sharedProjectSettings: join(repo, ".claude", "settings.json"),
    sharedLocalSettings: join(repo, ".claude", "settings.local.json")
  };
}

function input(tree: CopilotTree, patch: Record<string, unknown> = {}) {
  return {
    home: tree.home,
    cwd: tree.cwd,
    copilotHome: tree.copilotHome,
    installedPluginsPath: tree.installed,
    configPath: tree.config,
    userSettingsPath: tree.userSettings,
    projectSettingsPath: tree.projectSettings,
    localSettingsPath: tree.localSettings,
    sharedProjectSettingsPath: tree.sharedProjectSettings,
    sharedLocalSettingsPath: tree.sharedLocalSettings,
    ...patch
  };
}

async function writeSkill(path: string, name = "review"): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${name}\n`
  );
}

async function writeSettings(
  path: string,
  value: Record<string, unknown>
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function writeConfig(
  tree: CopilotTree,
  installedPlugins: Record<string, { enabled: boolean }>
): Promise<void> {
  await mkdir(join(tree.config, ".."), { recursive: true });
  await writeFile(
    tree.config,
    JSON.stringify({ version: 1, installedPlugins })
  );
}

async function writePlugin(
  tree: CopilotTree,
  marketplace: string,
  plugin: string,
  options: {
    manifestAt?: string;
    manifest?: Record<string, unknown> | string;
    skills?: Array<{ path: string; name?: string }>;
  } = {}
): Promise<string> {
  const root = join(tree.installed, marketplace, plugin);
  const manifestAt = options.manifestAt ?? ".plugin/plugin.json";
  await mkdir(join(root, manifestAt, ".."), { recursive: true });
  await writeFile(
    join(root, manifestAt),
    typeof options.manifest === "string"
      ? options.manifest
      : JSON.stringify(options.manifest ?? { name: plugin })
  );
  for (const skill of options.skills ?? [{ path: "skills/review" }]) {
    await writeSkill(join(root, skill.path), skill.name ?? plugin);
  }
  return root;
}

describe("GitHub Copilot CLI native inventory planning", () => {
  it("plans exact first-found direct-root precedence and preserves aliases", async () => {
    const tree = await createTree();
    const locations = [tree.cwd, join(tree.repo, "packages"), tree.repo];
    for (const location of locations) {
      await writeSkill(join(location, ".github", "skills", "review"));
      await writeSkill(join(location, ".agents", "skills", "review"));
      await writeSkill(join(location, ".claude", "skills", "review"));
    }
    await writeSkill(join(tree.copilotHome, "skills", "review"));
    await writeSkill(join(tree.home, ".agents", "skills", "review"));

    const plan = await planGitHubCopilotInventory(input(tree, {
      copilotSkillsDirs: join(tree.cwd, ".github", "skills")
    }));
    const direct = plan.sources.filter(({ ownership }) => ownership === "direct");

    expect(direct.slice(0, 11).map(({ path }) => path)).toEqual([
      ...locations.flatMap((location) => [
        join(location, ".github", "skills"),
        join(location, ".agents", "skills"),
        join(location, ".claude", "skills")
      ]),
      join(tree.copilotHome, "skills"),
      join(tree.home, ".agents", "skills")
    ].map((path) => resolve(path)));
    expect(direct.slice(0, 11).map(({ precedenceRank }) => precedenceRank))
      .toEqual([...Array(11).keys()]);
    expect(new Set(direct.map(({ id }) => id)).size).toBe(direct.length);

    const walked = await walkInventory(plan);
    const expectedReview = await realpath(
      join(tree.cwd, ".github", "skills", "review")
    );
    const review = walked.candidates.find(({ path }) =>
      path === expectedReview
    );
    expect(review).toBeDefined();
    expect(walked.candidates.reduce((count, candidate) =>
      count + candidate.sourceIds.length, 0
    )).toBeGreaterThan(walked.candidates.length);
  });

  it("coexists user skillDirectories with comma-separated COPILOT_SKILLS_DIRS in one tied custom tier", async () => {
    const tree = await createTree();
    const first = join(tree.root, "custom-a");
    const second = join(tree.root, "custom-b");
    const third = join(tree.root, "custom-c");
    await writeSkill(join(first, "one"));
    await writeSkill(join(second, "two"));
    await writeSkill(join(third, "three"));
    await writeConfig(tree, {});
    await writeSettings(tree.userSettings, {
      skillDirectories: [` ${first} `, second, second]
    });

    const plan = await planGitHubCopilotInventory(input(tree, {
      copilotSkillsDirs: ` ${second}, ${third},${third} `
    }));
    const customPaths = new Set([resolve(first), resolve(second), resolve(third)]);
    const custom = plan.sources.filter(({ path }) => customPaths.has(path));

    expect(custom.map(({ path }) => path).sort()).toEqual(
      [resolve(first), resolve(second), resolve(second), resolve(third)].sort()
    );
    expect(new Set(custom.map(({ precedenceRank }) => precedenceRank)).size).toBe(1);
    expect(plan.runtime?.copilot?.customRoots).toEqual([
      { origin: "environment", path: resolve(second) },
      { origin: "environment", path: resolve(third) },
      { origin: "user-settings", path: resolve(first) },
      { origin: "user-settings", path: resolve(second) }
    ]);
  });

  it("uses comma on every OS, bounds custom work, and keeps IDs stable across reordering", async () => {
    const tree = await createTree();
    await writeSettings(tree.userSettings, {
      skillDirectories: ["C:\\skills", "D:\\shared"]
    });
    const first = await planGitHubCopilotInventory(input(tree, {
      copilotSkillsDirs: "C:\\env,D:\\env"
    }));
    const customFirst = first.runtime?.copilot?.customRoots ?? [];
    expect(customFirst).toHaveLength(4);
    expect(customFirst.filter(({ origin }) => origin === "environment"))
      .toHaveLength(2);
    const idsByPath = new Map(first.sources.filter(({ id }) =>
      id.startsWith("github-copilot:direct:")
    ).map(({ id, path }) => [path, id]));

    await writeSettings(tree.userSettings, {
      skillDirectories: ["D:\\shared", "C:\\skills"]
    });
    const reordered = await planGitHubCopilotInventory(input(tree, {
      copilotSkillsDirs: "D:\\env,C:\\env"
    }));
    for (const source of reordered.sources) {
      if (!customFirst.some(({ path }) => path === source.path)) continue;
      expect(source.id).toBe(idsByPath.get(source.path));
    }

    const excessive = [...Array(1_002).keys()]
      .map((index) => `custom-${index}`).join(",");
    const bounded = await planGitHubCopilotInventory(input(tree, {
      copilotSkillsDirs: excessive
    }));
    expect(bounded.runtime?.copilot?.customRoots.length).toBeLessThanOrEqual(1_000);
    expect(bounded.sources.find(({ diagnostic }) =>
      diagnostic?.code === "COPILOT_CUSTOM_ROOT_LIMIT"
    )).toBeDefined();
  });

  it("uses the first existing manifest path and treats invalid content as terminal", async () => {
    const tree = await createTree();
    const root = await writePlugin(tree, "team", "review-tools", {
      manifest: "{",
      skills: []
    });
    await mkdir(join(root, ".github", "plugin"), { recursive: true });
    await writeFile(
      join(root, ".github", "plugin", "plugin.json"),
      JSON.stringify({ name: "review-tools" })
    );
    await writeSkill(join(root, "skills", "review"));
    await cp(join(fixtureRoot, "config-v1.json"), tree.config);
    await cp(join(fixtureRoot, "settings-user.jsonc"), tree.userSettings);

    const plan = await planGitHubCopilotInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "review-tools@team"
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      status: "invalid",
      manifestPath: await realpath(join(root, ".plugin", "plugin.json")),
      diagnostic: { code: "METADATA_INVALID_JSON" }
    });
    expect(plan.runtime?.copilot?.disabledSkills).toEqual({
      status: "known",
      names: ["legacy-review"]
    });
  });

  it("supports alternate manifests, replacement custom paths, and self layouts", async () => {
    const tree = await createTree();
    const root = await writePlugin(tree, "team", "review-tools", {
      manifestAt: ".claude-plugin/plugin.json",
      manifest: {
        name: "review-tools",
        skills: ["./packs/one/", "packs/two"],
        extensions: { paths: ["./extensions/tool.js"], exclusive: true }
      },
      skills: [
        { path: "packs/one", name: "one" },
        { path: "packs/two/review", name: "two" },
        { path: "skills/ignored", name: "ignored" }
      ]
    });
    await writeConfig(tree, { "review-tools@team": { enabled: true } });

    const plan = await planGitHubCopilotInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "review-tools@team"
    );

    expect(sources.map(({ path, layout }) => ({ path, layout }))).toEqual([
      { path: await realpath(join(root, "packs", "one")), layout: "self" },
      { path: await realpath(join(root, "packs", "two")), layout: "children" }
    ]);
    expect(plan.runtime?.copilot?.extensions).toEqual([{
      status: "declared",
      pluginId: "review-tools@team",
      paths: ["extensions/tool.js"],
      exclusive: true,
      sourceForm: "object"
    }]);
    const walked = await walkInventory(plan);
    expect(walked.candidates.map(({ path }) => path).sort()).toEqual([
      await realpath(join(root, "packs", "one")),
      await realpath(join(root, "packs", "two", "review"))
    ].sort());
  });

  it("records all documented extension forms and invalid forms without scanning them as Skills", async () => {
    const tree = await createTree();
    const declarations: Array<[string, unknown]> = [
      ["ext-string", "./extensions/one.js"],
      ["ext-array", ["./extensions/two.js", "extensions/three.js"]],
      ["ext-object", { paths: ["./extensions/four.js"], exclusive: true }],
      ["ext-invalid", { paths: "not-an-array", exclusive: "yes" }]
    ];
    for (const [name, extensions] of declarations) {
      const root = await writePlugin(tree, "team", name, {
        manifest: { name, skills: [], extensions },
        skills: []
      });
      await writeSkill(join(root, "extensions", "must-not-load"), name);
    }
    await writeSettings(tree.userSettings, {
      enabledPlugins: Object.fromEntries(
        declarations.map(([name]) => [`${name}@team`, true])
      )
    });

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.runtime?.copilot?.extensions).toEqual([
      {
        status: "declared",
        pluginId: "ext-array@team",
        paths: ["extensions/two.js", "extensions/three.js"],
        exclusive: false,
        sourceForm: "array"
      },
      {
        status: "invalid",
        pluginId: "ext-invalid@team",
        paths: [],
        diagnostic: { code: "COPILOT_EXTENSIONS_INVALID", message: expect.any(String) }
      },
      {
        status: "declared",
        pluginId: "ext-object@team",
        paths: ["extensions/four.js"],
        exclusive: true,
        sourceForm: "object"
      },
      {
        status: "declared",
        pluginId: "ext-string@team",
        paths: ["extensions/one.js"],
        exclusive: false,
        sourceForm: "string"
      }
    ]);
    const walked = await walkInventory(plan);
    expect(walked.candidates).toHaveLength(0);
  });

  it("uses enabledPlugins at all supported scopes but only user disabledSkills", async () => {
    const tree = await createTree();
    await writePlugin(tree, "team", "review-tools");
    await writeSettings(tree.userSettings, {
      enabledPlugins: { "review-tools@team": false },
      disabledSkills: ["user-disabled"]
    });
    await writeSettings(tree.projectSettings, {
      enabledPlugins: { "review-tools@team": true },
      disabledSkills: ["project-disabled"]
    });
    await writeSettings(tree.sharedProjectSettings, {
      enabledPlugins: { "review-tools@team": false },
      disabledSkills: ["shared-disabled"]
    });
    await writeConfig(tree, { "review-tools@team": { enabled: true } });

    const ambiguous = await planGitHubCopilotInventory(input(tree));
    expect(ambiguous.sources.find(({ plugin }) =>
      plugin?.id === "review-tools@team"
    )).toMatchObject({ status: "ambiguous" });
    expect(ambiguous.runtime?.copilot?.disabledSkills).toMatchObject({
      status: "known",
      names: ["user-disabled"]
    });

    await writeSettings(tree.localSettings, {
      enabledPlugins: { "review-tools@team": false },
      disabledSkills: ["local-disabled"]
    });
    const disabled = await planGitHubCopilotInventory(input(tree));
    expect(disabled.sources.find(({ plugin }) =>
      plugin?.id === "review-tools@team"
    )).toMatchObject({ status: "disabled" });
    expect(disabled.runtime?.copilot?.disabledSkills).toEqual({
      status: "known",
      names: ["user-disabled"]
    });
  });

  it("ignores unsupported project custom/disabled keys and explicitly rejects invalid user custom roots", async () => {
    const tree = await createTree();
    const ignored = join(tree.root, "ignored-project-root");
    await writeSkill(join(ignored, "review"));
    await writeSettings(tree.projectSettings, {
      skillDirectories: [ignored],
      disabledSkills: ["ignored-project-disabled"]
    });
    await writeSettings(tree.sharedLocalSettings, {
      skillDirectories: "also-ignored",
      disabledSkills: 42
    });
    const ignoredPlan = await planGitHubCopilotInventory(input(tree));
    expect(ignoredPlan.sources.some(({ path }) => path === resolve(ignored))).toBe(false);
    expect(ignoredPlan.runtime?.copilot?.disabledSkills).toEqual({
      status: "known",
      names: []
    });
    expect(ignoredPlan.sources.some(({ diagnostic }) =>
      diagnostic?.code === "COPILOT_SETTINGS_INVALID"
    )).toBe(false);

    await writeSettings(tree.userSettings, { skillDirectories: "not-an-array" });
    const invalid = await planGitHubCopilotInventory(input(tree));
    expect(invalid.sources.find(({ path }) => path === resolve(tree.userSettings)))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "COPILOT_SETTINGS_INVALID" }
      });
  });

  it("accepts only the fixture-locked managed config shape and never guesses unknown state", async () => {
    const tree = await createTree();
    await writePlugin(tree, "team", "review-tools");
    await writeFile(tree.config, JSON.stringify({ installedPlugins: [] }));

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "review-tools@team"
    )).toMatchObject({ status: "ambiguous" });
    expect(plan.sources.find(({ diagnostic }) =>
      diagnostic?.code === "COPILOT_CONFIG_INVALID"
    )).toBeDefined();
    expect(plan.runtime?.copilot?.coverageLimitations).toContain(
      "COPILOT_MDM_STATE_UNOBSERVABLE"
    );
  });

  it("inventories marketplace/direct identities, configured-only entries, and non-directories", async () => {
    const tree = await createTree();
    await writePlugin(tree, "team", "review-tools");
    await writePlugin(tree, "_direct", "local-source", {
      manifest: { name: "local-tools" }
    });
    await writeFile(join(tree.installed, "team", "not-a-plugin"), "file");
    await writeSettings(tree.userSettings, {
      enabledPlugins: {
        "review-tools@team": true,
        "local-source@_direct": true,
        "missing-tools@team": true
      }
    });
    await writeConfig(tree, {
      "review-tools@team": { enabled: true },
      "local-source@_direct": { enabled: true }
    });

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "local-source@_direct"
    )).toMatchObject({ status: "scanned" });
    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "missing-tools@team"
    )).toMatchObject({ status: "missing" });
    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "not-a-plugin@team"
    )).toMatchObject({ status: "invalid" });
  });

  it("bounds plugin manifest reads before parsing and leaves residual walk budget", async () => {
    const module = await import("../src/inventory/adapters/github-copilot.js");
    const planner = module.planGitHubCopilotInventoryWithHooks;
    const tree = await createTree();
    for (let index = 0; index < 8; index += 1) {
      const name = `plugin-${index}`;
      await writePlugin(tree, "team", name);
    }
    await writeConfig(tree, Object.fromEntries(
      [...Array(8).keys()].map((index) => [
        `plugin-${index}@team`,
        { enabled: true }
      ])
    ));
    let reads = 0;

    const plan = await planner(input(tree, {
      limits: { maxPlugins: 3, maxDirectories: 30 }
    }), {
      beforeManifestRead() {
        reads += 1;
      }
    });

    expect(reads).toBeLessThanOrEqual(3);
    expect(plan.sources.filter(({ plugin }) => plugin).every(({ plugin }) =>
      ["plugin-0@team", "plugin-1@team", "plugin-2@team"]
        .includes(plugin!.id)
    )).toBe(true);
    expect(plan.sources.find(({ diagnostic }) =>
      diagnostic?.code === "COPILOT_PLUGIN_LIMIT"
    )).toBeDefined();
    expect(plan.bounds?.maxDirectories).toBeLessThan(30);
  });

  it("ties all installed plugins when local state does not prove installation order", async () => {
    const tree = await createTree();
    await writePlugin(tree, "z-market", "a-tools");
    await writePlugin(tree, "a-market", "z-tools");
    await writeSettings(tree.userSettings, {
      enabledPlugins: {
        "a-tools@z-market": true,
        "z-tools@a-market": true
      }
    });

    const plan = await planGitHubCopilotInventory(input(tree));
    const plugins = plan.sources.filter(({ plugin, status }) =>
      plugin && status === "scanned"
    );
    expect(plugins).toHaveLength(2);
    expect(new Set(plugins.map(({ precedenceRank }) => precedenceRank)).size).toBe(1);
    expect(plan.runtime?.copilot?.pluginOrder).toBe("unverified");
  });

  it("bounds manifest fan-out and keeps source IDs stable across state changes", async () => {
    const tree = await createTree();
    const declared = [...Array(8).keys()].map((index) => `packs/${index}`);
    const root = await writePlugin(tree, "team", "review-tools", {
      manifest: { name: "review-tools", skills: declared },
      skills: declared.map((path, index) => ({
        path: `${path}/review`,
        name: `review-${index}`
      }))
    });
    await writeSettings(tree.localSettings, {
      enabledPlugins: { "review-tools@team": true }
    });
    await writeConfig(tree, { "review-tools@team": { enabled: true } });

    const bounded = await planGitHubCopilotInventory(input(tree, {
      limits: { maxDirectories: 4 }
    }));
    const packsRoot = await realpath(join(root, "packs"));
    expect(bounded.sources.find(({ diagnostic }) =>
      diagnostic?.code === "COPILOT_DIRECTORY_LIMIT"
    )).toBeDefined();
    expect(bounded.sources.filter(({ plugin, path }) =>
      plugin?.id === "review-tools@team" && path.startsWith(packsRoot)
    ).length).toBeLessThan(declared.length);

    const enabled = await planGitHubCopilotInventory(input(tree));
    const enabledSource = enabled.sources.find(({ plugin, path }) =>
      plugin?.id === "review-tools@team" && path.endsWith("/packs/0")
    );
    await writeSettings(tree.localSettings, {
      enabledPlugins: { "review-tools@team": false }
    });
    const disabled = await planGitHubCopilotInventory(input(tree));
    const disabledSource = disabled.sources.find(({ plugin, path }) =>
      plugin?.id === "review-tools@team" && path.endsWith("/packs/0")
    );
    expect(enabledSource).toMatchObject({ status: "scanned" });
    expect(disabledSource).toMatchObject({
      id: enabledSource?.id,
      status: "disabled",
      inspectSkills: true
    });
  });

  it("fails closed when a trusted component changes before walking", async () => {
    const tree = await createTree();
    await writePlugin(tree, "team", "review-tools");
    await writeSettings(tree.localSettings, {
      enabledPlugins: { "review-tools@team": true }
    });
    await writeConfig(tree, { "review-tools@team": { enabled: true } });
    const plan = await planGitHubCopilotInventory(input(tree));
    const source = plan.sources.find(({ plugin, status }) =>
      plugin?.id === "review-tools@team" && status === "scanned"
    );
    expect(source).toBeDefined();
    if (!source) return;

    const moved = `${source.path}-original`;
    const outside = await mkdtemp(join(tmpdir(), "steward-copilot-swap-"));
    await writeSkill(join(outside, "outside"));
    await rename(source.path, moved);
    await symlink(
      outside,
      source.path,
      process.platform === "win32" ? "junction" : "dir"
    );

    const walked = await walkInventory(plan);
    expect(walked.sources.find(({ id }) => id === source.id)).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" }
    });
    expect(walked.candidates.some(({ path }) => path.startsWith(outside))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it("conservatively refuses symlinked direct roots", async () => {
    const tree = await createTree();
    const outside = await mkdtemp(join(tmpdir(), "steward-copilot-direct-"));
    await writeSkill(join(outside, "review"));
    await mkdir(join(tree.cwd, ".github"), { recursive: true });
    const alias = join(tree.cwd, ".github", "skills");
    await symlink(
      outside,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ path }) => path === resolve(alias))).toMatchObject({
      status: "invalid",
      diagnostic: { code: "COPILOT_DIRECT_ROOT_SYMLINK_REFUSED" }
    });
    const walked = await walkInventory(plan);
    expect(walked.candidates.some(({ path }) => path.startsWith(outside))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it("freezes missing/non-directory/unreadable direct-root terminal evidence at plan time", async () => {
    const tree = await createTree();
    const missing = join(tree.cwd, ".github", "skills");
    await writeFile(join(tree.cwd, ".agents"), "not-a-directory");
    await mkdir(join(tree.cwd, ".claude"), { recursive: true });
    await writeFile(join(tree.cwd, ".claude", "skills"), "not-a-directory");

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ path }) => path === resolve(missing))).toMatchObject({
      status: "missing"
    });
    expect(plan.sources.find(({ path }) =>
      path === resolve(join(tree.cwd, ".agents", "skills"))
    )).toMatchObject({ status: "unreadable" });
    expect(plan.sources.find(({ path }) =>
      path === resolve(join(tree.cwd, ".claude", "skills"))
    )).toMatchObject({ status: "invalid" });

    const outside = await mkdtemp(join(tmpdir(), "steward-copilot-late-root-"));
    await writeSkill(join(outside, "outside"));
    await mkdir(join(missing, ".."), { recursive: true });
    await symlink(
      outside,
      missing,
      process.platform === "win32" ? "junction" : "dir"
    );
    const walked = await walkInventory(plan);
    expect(walked.sources.find(({ path }) => path === resolve(missing)))
      .toMatchObject({ status: "missing", skillCount: 0 });
    expect(walked.candidates.some(({ path }) => path.startsWith(outside))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects escaping, over-depth, Windows, and changed manifest/component paths", async () => {
    const tree = await createTree();
    const root = await writePlugin(tree, "team", "review-tools", {
      manifest: {
        name: "review-tools",
        skills: ["../outside", "C:\\outside", "a/".repeat(25)]
      },
      skills: []
    });
    await writeConfig(tree, { "review-tools@team": { enabled: true } });

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "review-tools@team"
    )).toMatchObject({ status: "invalid" });

    const changedRoot = await writePlugin(tree, "other", "change-tools");
    await writeSettings(tree.localSettings, {
      enabledPlugins: { "change-tools@other": true }
    });
    const changedManifest = await realpath(join(
      changedRoot,
      ".plugin",
      "plugin.json"
    ));
    const changed = await modulePlannerWithSwap(input(tree), async (path) => {
      if (path !== changedManifest) return;
      const moved = `${path}.old`;
      await rename(path, moved);
      await writeFile(path, JSON.stringify({ name: "change-tools" }));
    });
    expect(changed.sources.find(({ plugin }) =>
      plugin?.id === "change-tools@other"
    )).toMatchObject({ status: "invalid" });
  });

  it("keeps contained plugin symlinks, refuses escaping aliases, and strips runtime plan fields", async () => {
    const tree = await createTree();
    const target = await writePlugin(tree, "team", "target-tools", {
      manifest: { name: "target-tools" }
    });
    const alias = join(tree.installed, "team", "alias-tools");
    await symlink(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const outside = await mkdtemp(join(tmpdir(), "steward-copilot-outside-"));
    await writeFile(join(outside, "plugin.json"), JSON.stringify({ name: "evil" }));
    await symlink(
      outside,
      join(tree.installed, "team", "evil-tools"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeSettings(tree.userSettings, {
      enabledPlugins: {
        "alias-tools@team": true,
        "evil-tools@team": true
      }
    });
    await writeConfig(tree, {
      "alias-tools@team": { enabled: true },
      "evil-tools@team": { enabled: true }
    });

    const plan = await planGitHubCopilotInventory(input(tree));
    expect(plan.sources.find(({ plugin }) => plugin?.id === "alias-tools@team"))
      .toMatchObject({ status: "scanned" });
    expect(plan.sources.find(({ plugin }) => plugin?.id === "evil-tools@team"))
      .toMatchObject({ status: "invalid" });

    const walked = await walkInventory(plan);
    for (const source of walked.sources) {
      expect(inventorySourceSchema.parse(source)).toEqual(source);
      expect(source).not.toHaveProperty("inspectSkills");
      expect(source).not.toHaveProperty("trustedContainment");
      expect(source).not.toHaveProperty("runtime");
    }
    await rm(outside, { recursive: true, force: true });
  });
});

async function modulePlannerWithSwap(
  plannerInput: ReturnType<typeof input>,
  beforeManifestRead: (path: string) => Promise<void>
) {
  const module = await import("../src/inventory/adapters/github-copilot.js");
  return module.planGitHubCopilotInventoryWithHooks(plannerInput, {
    beforeManifestRead
  });
}
