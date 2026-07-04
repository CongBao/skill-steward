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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventorySourceSchema } from "../src/domain.js";
import { planClaudeCodeInventory } from "../src/inventory/adapters/claude-code.js";
import { walkInventory } from "../src/inventory/walk.js";
import { parseSkill } from "../src/parse-skill.js";

const fixtureRoot = fileURLToPath(
  new URL("fixtures/native-inventory/claude-code", import.meta.url)
);

interface ClaudeTree {
  root: string;
  home: string;
  repo: string;
  cwd: string;
  claudeHome: string;
  cache: string;
  installedPlugins: string;
  userSettings: string;
  projectSettings: string;
  localSettings: string;
}

async function createTree(): Promise<ClaudeTree> {
  const root = await mkdtemp(join(tmpdir(), "steward-claude-inventory-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  const claudeHome = join(home, ".claude");
  const cache = join(claudeHome, "plugins", "cache");
  const installedPlugins = join(claudeHome, "plugins", "installed_plugins.json");
  const userSettings = join(claudeHome, "settings.json");
  const projectSettings = join(repo, ".claude", "settings.json");
  const localSettings = join(repo, ".claude", "settings.local.json");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(cache, { recursive: true });
  return {
    root,
    home,
    repo,
    cwd,
    claudeHome,
    cache,
    installedPlugins,
    userSettings,
    projectSettings,
    localSettings
  };
}

function input(tree: ClaudeTree, limits?: { maxPlugins?: number; maxDirectories?: number }) {
  return {
    home: tree.home,
    cwd: tree.cwd,
    claudeHome: tree.claudeHome,
    pluginCachePath: tree.cache,
    installedPluginsPath: tree.installedPlugins,
    userSettingsPath: tree.userSettings,
    projectSettingsPath: tree.projectSettings,
    localSettingsPath: tree.localSettings,
    ...(limits ? { limits } : {})
  };
}

async function writeSkill(path: string, name = basename(path)): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${name}\n`
  );
}

async function writeCachePlugin(
  tree: ClaudeTree,
  marketplace: string,
  plugin: string,
  version: string,
  options: {
    manifest?: Record<string, unknown> | null;
    roots?: string[];
    rootSkill?: boolean;
  } = {}
): Promise<string> {
  const root = join(tree.cache, marketplace, plugin, version);
  await mkdir(root, { recursive: true });
  if (options.manifest !== null) {
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify(options.manifest ?? { name: plugin })
    );
  }
  for (const component of options.roots ?? ["skills"]) {
    await mkdir(join(root, component), { recursive: true });
  }
  if (options.rootSkill) await writeSkill(root, `${plugin}-root`);
  return root;
}

async function writeSettings(path: string, enabledPlugins: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ enabledPlugins }));
}

async function writeInstalled(
  tree: ClaudeTree,
  plugins: Record<string, Array<{ version: string; installPath: string }>>
): Promise<void> {
  await mkdir(join(tree.installedPlugins, ".."), { recursive: true });
  await writeFile(tree.installedPlugins, JSON.stringify({ version: 2, plugins }));
}

async function writeSkillsDirectoryPlugin(
  root: string,
  name: string,
  options: {
    rootSkill?: boolean;
    defaultSkill?: boolean;
    manifest?: Record<string, unknown>;
  } = { rootSkill: true }
): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, ...options.manifest })
  );
  if (options.rootSkill) await writeSkill(pluginRoot, `${name}-root`);
  if (options.defaultSkill) {
    await writeSkill(join(pluginRoot, "skills", "review"), `${name}-review`);
  }
  return pluginRoot;
}

describe("Claude Code native inventory planning", () => {
  it("loads the documented cache layout and JSONC settings fixture", async () => {
    const tree = await createTree();
    await cp(join(fixtureRoot, "cache"), tree.cache, { recursive: true });
    await cp(join(fixtureRoot, "settings.jsonc"), tree.userSettings);

    const plan = await planClaudeCodeInventory(input(tree));
    const source = plan.sources.find(({ plugin }) => plugin?.id === "review@team");

    expect(source).toMatchObject({
      plugin: { id: "review@team", version: "1.0.0" },
      pluginNamespace: "review-tools",
      status: "scanned",
      layout: "children"
    });
    expect(new Set(plan.sources.map(({ id }) => id)).size)
      .toBe(plan.sources.length);
    const walked = await walkInventory(plan);
    expect(walked.sources.find(({ id }) => id === source?.id)).toMatchObject({
      status: "scanned",
      skillCount: 1
    });
  });

  it("plans user, ancestor, and bounded nested direct Skill roots with distinct provenance", async () => {
    const tree = await createTree();
    const userSkill = join(tree.claudeHome, "skills", "user-review");
    const nestedRoot = join(tree.repo, "packages", "web", ".claude", "skills");
    const nestedSkill = join(nestedRoot, "nested-review");
    await writeSkill(userSkill);
    await writeSkill(nestedSkill);

    const plan = await planClaudeCodeInventory(input(tree));
    const direct = plan.sources.filter(({ ownership }) => ownership === "direct");
    const expectedAncestorPaths = [
      join(tree.claudeHome, "skills"),
      join(tree.cwd, ".claude", "skills"),
      join(tree.repo, "packages", ".claude", "skills"),
      join(tree.repo, ".claude", "skills")
    ].map((path) => resolve(path));

    expect(direct.slice(0, 4).map(({ path }) => path)).toEqual(expectedAncestorPaths);
    expect(direct.slice(0, 4).map(({ kind }) => kind)).toEqual([
      "direct-root",
      "direct-root",
      "inherited-root",
      "inherited-root"
    ]);
    expect(direct.slice(0, 4).map(({ precedenceRank }) => precedenceRank))
      .toEqual([0, 1, 2, 3]);
    const physicalNestedRoot = await realpath(nestedRoot);
    const nested = direct.find(({ path }) => path === physicalNestedRoot);
    expect(nested).toMatchObject({
      harness: "claude",
      scope: "project",
      kind: "inherited-root",
      layout: "children",
      status: "scanned",
      pathQualification: "packages/web"
    });
    expect(new Set(direct.map(({ id }) => id)).size).toBe(direct.length);

    const walked = await walkInventory(plan);
    expect(walked.candidates.map(({ path }) => path)).toEqual([
      await realpath(userSkill),
      await realpath(nestedSkill)
    ].sort());
  });

  it("does not duplicate an existing ancestor root as an on-demand nested root", async () => {
    const tree = await createTree();
    const root = join(tree.repo, ".claude", "skills");
    await writeSkill(join(root, "review"));

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.filter(({ ownership, path }) =>
      ownership === "direct" && resolve(path) === resolve(root)
    )).toHaveLength(1);
  });

  it("fails closed when a discovered nested root changes before trust attachment", async () => {
    const module = await import("../src/inventory/adapters/claude-code.js");
    const planner = (module as unknown as {
      planClaudeCodeInventoryWithHooks?: (
        plannerInput: ReturnType<typeof input>,
        hooks: {
          afterNestedDiscovery(paths: string[]): Promise<void>;
        }
      ) => ReturnType<typeof planClaudeCodeInventory>;
    }).planClaudeCodeInventoryWithHooks;
    expect(planner).toBeTypeOf("function");
    if (!planner) return;

    const tree = await createTree();
    const nestedRoot = join(tree.repo, "packages", "web", ".claude", "skills");
    const moved = join(tree.repo, "packages", "web", ".claude", "skills-original");
    const outside = await mkdtemp(join(tmpdir(), "steward-claude-nested-swap-"));
    await writeSkill(join(nestedRoot, "inside"));
    await writeSkill(join(outside, "outside"));

    const plan = await planner(input(tree), {
      async afterNestedDiscovery(paths) {
        expect(paths).toContain(await realpath(nestedRoot));
        await rename(nestedRoot, moved);
        await symlink(
          outside,
          nestedRoot,
          process.platform === "win32" ? "junction" : "dir"
        );
      }
    });
    const source = plan.sources.find(({ diagnostic }) =>
      diagnostic?.code === "CLAUDE_NESTED_ROOT_CHANGED"
    );

    expect(source).toMatchObject({
      status: "invalid",
      diagnostic: { code: "CLAUDE_NESTED_ROOT_CHANGED" }
    });
    const walked = await walkInventory(plan);
    expect(walked.candidates.map(({ path }) => path))
      .not.toContain(await realpath(outside));
  });

  it("applies local > project > user exact-boolean settings and proven active versions", async () => {
    const tree = await createTree();
    const oldRoot = await writeCachePlugin(tree, "team", "format", "1");
    const activeRoot = await writeCachePlugin(tree, "team", "format", "2");
    await writeSkill(join(oldRoot, "skills", "review"));
    await writeSkill(join(activeRoot, "skills", "review"));
    await writeSettings(tree.userSettings, { "format@team": true });
    await writeSettings(tree.projectSettings, { "format@team": false });
    await writeSettings(tree.localSettings, { "format@team": true });
    await writeInstalled(tree, {
      "format@team": [{ version: "2", installPath: activeRoot }]
    });

    const plan = await planClaudeCodeInventory(input(tree));
    const versions = plan.sources.filter(({ plugin }) => plugin?.id === "format@team");

    expect(versions.map(({ plugin }) => plugin?.version)).toEqual(["1", "2"]);
    expect(versions.map(({ status }) => status)).toEqual(["stale", "scanned"]);
    expect(versions[0]).toMatchObject({ inspectSkills: true });
    const walked = await walkInventory(plan);
    expect(walked.sources.filter(({ plugin }) => plugin?.id === "format@team")
      .map(({ status, skillCount }) => ({ status, skillCount }))).toEqual([
      { status: "stale", skillCount: 1 },
      { status: "scanned", skillCount: 1 }
    ]);
  });

  it("does not mask an invalid manifest when the plugin is disabled", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "broken", "1");
    await writeFile(join(root, ".claude-plugin", "plugin.json"), "not-json");
    await writeSettings(tree.userSettings, { "broken@team": false });

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "broken@team"))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "METADATA_INVALID_JSON" }
      });
  });

  it("does not mask an illegal custom root when the cache version is stale", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "stale-broken", "1", {
      manifest: { name: "stale-broken", skills: "../outside" },
      roots: []
    });
    const activeRoot = await writeCachePlugin(tree, "team", "stale-broken", "2");
    await writeSettings(tree.userSettings, { "stale-broken@team": true });
    await writeInstalled(tree, {
      "stale-broken@team": [{ version: "2", installPath: activeRoot }]
    });

    const plan = await planClaudeCodeInventory(input(tree));
    const old = plan.sources.find(({ plugin }) =>
      plugin?.id === "stale-broken@team" && plugin.version === "1"
    );

    expect(old).toMatchObject({
      status: "invalid",
      diagnostic: { code: "CLAUDE_MANIFEST_SKILLS_INVALID" }
    });
  });

  it("does not coerce a higher-precedence non-boolean plugin setting", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "format", "1");
    await writeSettings(tree.userSettings, { "format@team": true });
    await writeSettings(tree.localSettings, { "format@team": "yes" });

    const plan = await planClaudeCodeInventory(input(tree));
    expect(plan.sources.find(({ plugin }) => plugin?.id === "format@team")).toMatchObject({
      status: "ambiguous",
      diagnostic: { code: "CLAUDE_PLUGIN_ENABLEMENT_UNKNOWN" }
    });
  });

  it("never selects a newest-looking cache version without local active proof", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "review", "2.0.0");
    await writeCachePlugin(tree, "team", "review", "10.0.0");
    await writeSettings(tree.userSettings, { "review@team": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const versions = plan.sources.filter(({ plugin }) => plugin?.id === "review@team");

    expect(versions.map(({ plugin }) => plugin?.version)).toEqual(["10.0.0", "2.0.0"]);
    expect(versions.every(({ status }) => status === "ambiguous")).toBe(true);
    expect(versions.every(({ inspectSkills }) => inspectSkills === true)).toBe(true);
  });

  it("refuses active-install metadata that points outside the plugin cache", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "orphan", "1");
    const activeElsewhere = join(tree.root, "active-elsewhere");
    await mkdir(activeElsewhere, { recursive: true });
    await writeSettings(tree.userSettings, { "orphan@team": true });
    await writeInstalled(tree, {
      "orphan@team": [{ version: "2", installPath: activeElsewhere }]
    });

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ path }) => path === resolve(tree.installedPlugins)))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "CLAUDE_ACTIVE_METADATA_INVALID" }
      });
    expect(plan.sources.find(({ plugin }) => plugin?.id === "orphan@team"))
      .toMatchObject({ status: "scanned" });
  });

  it("adds default and portable manifest Skill roots and uses the manifest name", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "quality-pack", "1", {
      manifest: { name: "quality", skills: ["./second", "./custom"] },
      roots: ["skills", "custom", "second"]
    });
    await writeSettings(tree.userSettings, { "quality-pack@team": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const components = plan.sources.filter(({ plugin }) => plugin?.id === "quality-pack@team");

    expect(components.every(({ pluginNamespace }) => pluginNamespace === "quality"))
      .toBe(true);
    expect(components.map(({ path }) => path)).toEqual([
      await realpath(join(root, "skills")),
      await realpath(join(root, "custom")),
      await realpath(join(root, "second"))
    ]);
    expect(components.every(({ layout }) => layout === "children")).toBe(true);
  });

  it("requires a present manifest to declare a valid kebab-case name", async () => {
    for (const manifest of [{}, { name: "Bad Name" }, { name: "UpperCase" }]) {
      const tree = await createTree();
      await writeCachePlugin(tree, "team", "invalid-name", "1", {
        manifest,
        roots: ["skills"]
      });
      await writeSettings(tree.userSettings, { "invalid-name@team": true });

      const plan = await planClaudeCodeInventory(input(tree));
      expect(plan.sources.find(({ plugin }) =>
        plugin?.id === "invalid-name@team"
      )).toMatchObject({
        status: "invalid",
        diagnostic: { code: "CLAUDE_MANIFEST_NAME_INVALID" }
      });
    }
  });

  it("normalizes ./ and trailing-slash custom roots and chooses self versus children", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "layouts", "1", {
      manifest: {
        name: "layouts",
        skills: ["./", "./custom/direct/", "./custom/children/"]
      },
      roots: ["skills", "custom/direct", "custom/children"]
    });
    await writeSkill(root, "root-layout");
    await writeFile(
      join(root, "custom", "direct", "SKILL.md"),
      "---\nname: direct\ndescription: direct\n---\n"
    );
    await writeSkill(join(root, "custom", "children", "nested"), "nested");
    await writeSettings(tree.userSettings, { "layouts@team": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const components = plan.sources.filter(({ plugin }) =>
      plugin?.id === "layouts@team"
    );
    const byPath = new Map(components.map((source) => [source.path, source.layout]));

    expect(byPath.get(await realpath(root))).toBe("self");
    expect(byPath.get(await realpath(join(root, "custom", "direct")))).toBe("self");
    expect(byPath.get(await realpath(join(root, "custom", "children"))))
      .toBe("children");
    expect(byPath.get(await realpath(join(root, "skills")))).toBe("children");
  });

  it("keeps a custom component source ID stable when its physical layout changes", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "layout-stable", "1", {
      manifest: { name: "layout-stable", skills: "./custom" },
      roots: ["skills", "custom"]
    });
    await writeSettings(tree.userSettings, { "layout-stable@team": true });

    const before = await planClaudeCodeInventory(input(tree));
    await writeSkill(join(root, "custom"), "custom");
    const after = await planClaudeCodeInventory(input(tree));
    const custom = (plan: Awaited<ReturnType<typeof planClaudeCodeInventory>>) =>
      plan.sources.find(({ plugin, path }) =>
        plugin?.id === "layout-stable@team" && basename(path) === "custom"
      );

    expect([custom(before)?.layout, custom(after)?.layout]).toEqual([
      "children",
      "self"
    ]);
    expect(custom(before)?.id).toBe(custom(after)?.id);
  });

  it("accepts an empty custom-root array and deduplicates ./skills against the default", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "empty", "1", {
      manifest: { name: "empty", skills: [] }
    });
    await writeCachePlugin(tree, "team", "duplicate", "1", {
      manifest: { name: "duplicate", skills: "./skills" }
    });
    await writeSettings(tree.userSettings, {
      "empty@team": true,
      "duplicate@team": true
    });

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.filter(({ plugin }) => plugin?.id === "empty@team"))
      .toHaveLength(1);
    expect(plan.sources.filter(({ plugin }) => plugin?.id === "duplicate@team"))
      .toHaveLength(1);
  });

  it("keeps configured identities distinct when manifests share a namespace", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "alpha", "quality", "1", {
      manifest: { name: "shared" }
    });
    await writeCachePlugin(tree, "beta", "quality", "1", {
      manifest: { name: "shared" }
    });
    await writeSettings(tree.userSettings, {
      "quality@alpha": true,
      "quality@beta": true
    });

    const plan = await planClaudeCodeInventory(input(tree));
    const shared = plan.sources.filter(({ pluginNamespace }) =>
      pluginNamespace === "shared"
    );

    expect(shared.map(({ plugin }) => plugin?.id)).toEqual([
      "quality@alpha",
      "quality@beta"
    ]);
    expect(new Set(shared.map(({ id }) => id)).size).toBe(2);
  });

  it("bounds manifest component fan-out with one truncation sentinel", async () => {
    const tree = await createTree();
    const declared = Array.from(
      { length: 2_000 },
      (_, index) => `./component-${String(index).padStart(4, "0")}`
    );
    await writeCachePlugin(tree, "team", "fanout", "1", {
      manifest: { name: "fanout", skills: declared },
      roots: []
    });
    await writeSettings(tree.userSettings, { "fanout@team": true });

    const plan = await planClaudeCodeInventory(input(tree, { maxDirectories: 20 }));
    const pluginSources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "fanout@team"
    );

    expect(pluginSources.length).toBeLessThanOrEqual(20);
    expect(pluginSources.filter(({ diagnostic }) =>
      diagnostic?.code === "CLAUDE_DIRECTORY_LIMIT"
    )).toHaveLength(1);
  });

  it("uses root SKILL.md only when neither default nor manifest Skill roots exist", async () => {
    const tree = await createTree();
    const fallback = await writeCachePlugin(tree, "team", "fallback", "1", {
      manifest: null,
      roots: [],
      rootSkill: true
    });
    const defaulted = await writeCachePlugin(tree, "team", "defaulted", "1", {
      manifest: null,
      roots: ["skills"],
      rootSkill: true
    });
    await writeSettings(tree.userSettings, {
      "fallback@team": true,
      "defaulted@team": true
    });

    const plan = await planClaudeCodeInventory(input(tree));
    const fallbackSource = plan.sources.find(({ plugin }) => plugin?.id === "fallback@team");
    const defaultedSources = plan.sources.filter(({ plugin }) => plugin?.id === "defaulted@team");

    expect(fallbackSource).toMatchObject({ path: await realpath(fallback), layout: "self" });
    expect(defaultedSources).toHaveLength(1);
    expect(defaultedSources[0]).toMatchObject({
      path: await realpath(join(defaulted, "skills")),
      layout: "children"
    });
  });

  it.each(["custom", "../outside", "./../outside", ".\\windows"])(
    "rejects non-portable manifest component path %s",
    async (declaredPath) => {
      const tree = await createTree();
      await writeCachePlugin(tree, "team", "unsafe", "1", {
        manifest: { name: "unsafe", skills: declaredPath },
        roots: []
      });
      await writeSettings(tree.userSettings, { "unsafe@team": true });

      const plan = await planClaudeCodeInventory(input(tree));
      expect(plan.sources.find(({ plugin }) => plugin?.id === "unsafe@team")).toMatchObject({
        status: "invalid",
        diagnostic: { code: "CLAUDE_MANIFEST_SKILLS_INVALID" }
      });
    }
  );

  it("rejects a portable-looking manifest path whose symlink escapes the plugin", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "escape", "1", {
      manifest: { name: "escape", skills: "./custom" },
      roots: ["skills"]
    });
    const outside = await mkdtemp(join(tmpdir(), "steward-claude-component-outside-"));
    await symlink(
      outside,
      join(root, "custom"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeSettings(tree.userSettings, { "escape@team": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const custom = plan.sources.find(({ plugin, path }) =>
      plugin?.id === "escape@team" && basename(path) !== "skills"
    );

    expect(custom).toMatchObject({
      status: "invalid",
      diagnostic: { code: "COMPONENT_REALPATH_ESCAPE" }
    });
  });

  it("marks an over-depth portable manifest path truncated", async () => {
    const tree = await createTree();
    const deepPath = `./${Array.from({ length: 25 }, () => "nested").join("/")}`;
    await writeCachePlugin(tree, "team", "deep", "1", {
      manifest: { name: "deep", skills: deepPath },
      roots: []
    });
    await writeSettings(tree.userSettings, { "deep@team": true });

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ plugin, diagnostic }) =>
      plugin?.id === "deep@team" &&
      diagnostic?.code === "COMPONENT_PATH_DEPTH_LIMIT"
    )).toMatchObject({ status: "truncated" });
  });

  it("recognizes a skills-directory plugin without also returning it as a plain direct Skill", async () => {
    const tree = await createTree();
    const pluginRoot = join(tree.claudeHome, "skills", "local-tools");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "localtools" })
    );
    await writeSkill(pluginRoot, "review");
    await writeSettings(tree.userSettings, { "localtools@skills-dir": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const pluginSource = plan.sources.find(({ kind }) =>
      kind === "skills-directory-plugin"
    );
    const directSource = plan.sources.find(({ path }) =>
      path === resolve(tree.claudeHome, "skills")
    );
    expect(pluginSource).toMatchObject({
      plugin: { id: "localtools@skills-dir" },
      pluginNamespace: "localtools",
      layout: "self",
      ownership: "native-plugin",
      status: "scanned"
    });

    const walked = await walkInventory(plan);
    const physicalPluginRoot = await realpath(pluginRoot);
    const candidate = walked.candidates.find(({ path }) => path === physicalPluginRoot);
    expect(candidate?.sourceIds).toEqual([pluginSource?.id]);
    expect(candidate?.sourceIds).not.toContain(directSource?.id);
    expect(() => inventorySourceSchema.parse(
      walked.sources.find(({ id }) => id === pluginSource?.id)
    )).not.toThrow();
    expect(walked.sources.find(({ id }) => id === pluginSource?.id))
      .not.toHaveProperty("pluginNamespace");
  });

  it("keeps a manifestless child as a plain direct Skill", async () => {
    const tree = await createTree();
    const pluginRoot = join(tree.claudeHome, "skills", "manifestless-tools");
    await writeSkill(pluginRoot, "manifestless-tools");
    await writeSkill(join(pluginRoot, "skills", "review"));

    const plan = await planClaudeCodeInventory(input(tree));
    const walked = await walkInventory(plan);
    const physicalPluginRoot = await realpath(pluginRoot);
    const directSource = plan.sources.find(({ path }) =>
      path === resolve(tree.claudeHome, "skills")
    );

    expect(plan.sources.some(({ kind }) => kind === "skills-directory-plugin"))
      .toBe(false);
    expect(walked.candidates.find(({ path }) => path === physicalPluginRoot))
      .toMatchObject({
        sourceIds: expect.arrayContaining([directSource?.id])
      });
  });

  it("classifies every skills-directory plugin but disables ancestor and nested scopes", async () => {
    const tree = await createTree();
    const userRoot = join(tree.claudeHome, "skills");
    const cwdRoot = join(tree.cwd, ".claude", "skills");
    const ancestorRoot = join(tree.repo, "packages", ".claude", "skills");
    const nestedRoot = join(tree.repo, "packages", "web", ".claude", "skills");
    await writeSkillsDirectoryPlugin(userRoot, "user-tools");
    await writeSkillsDirectoryPlugin(cwdRoot, "cwd-tools");
    const ancestorPlugin = await writeSkillsDirectoryPlugin(
      ancestorRoot,
      "ancestor-tools"
    );
    const nestedPlugin = await writeSkillsDirectoryPlugin(
      nestedRoot,
      "nested-tools"
    );
    await writeSettings(tree.userSettings, {
      "user-tools@skills-dir": true,
      "cwd-tools@skills-dir": true,
      "ancestor-tools@skills-dir": true,
      "nested-tools@skills-dir": true
    });

    const plan = await planClaudeCodeInventory(input(tree));
    const plugins = plan.sources.filter(({ kind }) =>
      kind === "skills-directory-plugin"
    );

    expect(new Set(plugins.map(({ plugin }) => plugin?.id))).toEqual(new Set([
      "user-tools@skills-dir",
      "cwd-tools@skills-dir",
      "ancestor-tools@skills-dir",
      "nested-tools@skills-dir"
    ]));
    expect(plugins.filter(({ scope }) => scope === "project")
      .filter(({ plugin }) =>
        plugin?.id === "ancestor-tools@skills-dir" ||
        plugin?.id === "nested-tools@skills-dir"
      )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "disabled",
        inspectSkills: true,
        diagnostic: expect.objectContaining({
          code: "CLAUDE_SKILLS_DIRECTORY_SCOPE_INACTIVE"
        })
      }),
      expect.objectContaining({
        status: "disabled",
        inspectSkills: true,
        diagnostic: expect.objectContaining({
          code: "CLAUDE_SKILLS_DIRECTORY_SCOPE_INACTIVE"
        })
      })
    ]));
    const walked = await walkInventory(plan);
    for (const pluginRoot of [ancestorPlugin, nestedPlugin]) {
      const candidate = walked.candidates.find(({ path }) =>
        path === resolve(pluginRoot) || basename(path) === basename(pluginRoot)
      );
      expect(candidate).toBeDefined();
      const pluginSourceIds = new Set(plugins.map(({ id }) => id));
      expect(candidate?.sourceIds.every((id) => pluginSourceIds.has(id))).toBe(true);
    }
  });

  it("excludes classified plugin children even when the plugin cap is zero", async () => {
    const tree = await createTree();
    const pluginRoot = await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "zero-cap"
    );
    await writeSettings(tree.userSettings, { "zero-cap@skills-dir": true });

    const plan = await planClaudeCodeInventory(input(tree, { maxPlugins: 0 }));
    const walked = await walkInventory(plan);

    expect(plan.sources.some(({ plugin }) => plugin?.id === "zero-cap@skills-dir"))
      .toBe(false);
    expect(plan.sources).toContainEqual(expect.objectContaining({
      status: "truncated",
      diagnostic: expect.objectContaining({ code: "CLAUDE_PLUGIN_LIMIT" })
    }));
    expect(walked.candidates.map(({ path }) => path))
      .not.toContain(await realpath(pluginRoot));
  });

  it("excludes every classified child when N+1 skills-directory plugins overflow the cap", async () => {
    const tree = await createTree();
    const root = join(tree.claudeHome, "skills");
    const first = await writeSkillsDirectoryPlugin(root, "alpha-tools");
    const second = await writeSkillsDirectoryPlugin(root, "beta-tools");
    await writeSettings(tree.userSettings, {
      "alpha-tools@skills-dir": true,
      "beta-tools@skills-dir": true
    });

    const plan = await planClaudeCodeInventory(input(tree, { maxPlugins: 1 }));
    const walked = await walkInventory(plan);
    const detailed = plan.sources.filter(({ kind }) =>
      kind === "skills-directory-plugin"
    );
    const directSourceIds = new Set(plan.sources.filter(({ ownership }) =>
      ownership === "direct"
    ).map(({ id }) => id));

    expect(new Set(detailed.map(({ plugin }) => plugin?.id)).size).toBe(1);
    expect(plan.sources.some(({ diagnostic }) =>
      diagnostic?.code === "CLAUDE_PLUGIN_LIMIT"
    )).toBe(true);
    for (const path of [await realpath(first), await realpath(second)]) {
      const candidate = walked.candidates.find((entry) => entry.path === path);
      expect(candidate?.sourceIds.some((id) => directSourceIds.has(id)) ?? false)
        .toBe(false);
    }
  });

  it("reads manifest content only for skills-directory candidates retained by the plugin cap", async () => {
    const module = await import("../src/inventory/adapters/claude-code.js");
    const planner = (module as unknown as {
      planClaudeCodeInventoryWithHooks: (
        plannerInput: ReturnType<typeof input>,
        hooks: {
          beforeSkillsDirectoryManifestRead(path: string): Promise<void> | void;
        }
      ) => ReturnType<typeof planClaudeCodeInventory>;
    }).planClaudeCodeInventoryWithHooks;
    const tree = await createTree();
    const root = join(tree.claudeHome, "skills");
    await writeSkillsDirectoryPlugin(root, "alpha-tools");
    await writeSkillsDirectoryPlugin(root, "beta-tools");

    const oneRead: string[] = [];
    await planner(input(tree, { maxPlugins: 1 }), {
      beforeSkillsDirectoryManifestRead(path) {
        oneRead.push(path);
      }
    });
    expect(oneRead).toHaveLength(1);
    expect(oneRead[0]).toContain("alpha-tools");

    const zeroReads: string[] = [];
    await planner(input(tree, { maxPlugins: 0 }), {
      beforeSkillsDirectoryManifestRead(path) {
        zeroReads.push(path);
      }
    });
    expect(zeroReads).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "propagates plugin exclusions and provenance across physical-root aliases",
    async () => {
      const tree = await createTree();
      const sharedRoot = join(tree.root, "shared-claude-skills");
      const pluginRoot = await writeSkillsDirectoryPlugin(sharedRoot, "alias-tools");
      const userRoot = join(tree.claudeHome, "skills");
      const cwdRoot = join(tree.cwd, ".claude", "skills");
      await mkdir(join(userRoot, ".."), { recursive: true });
      await mkdir(join(cwdRoot, ".."), { recursive: true });
      await symlink(sharedRoot, userRoot, "dir");
      await symlink(sharedRoot, cwdRoot, "dir");
      await writeSettings(tree.userSettings, { "alias-tools@skills-dir": true });

      const plan = await planClaudeCodeInventory(input(tree));
      const physicalPluginRoot = await realpath(pluginRoot);
      const directAliases = plan.sources.filter(({ ownership, path }) =>
        ownership === "direct" && (path === userRoot || path === cwdRoot)
      );
      const pluginAliases = plan.sources.filter(({ plugin }) =>
        plugin?.id === "alias-tools@skills-dir"
      );

      expect(directAliases).toHaveLength(2);
      expect(directAliases.every(({ excludedChildPaths }) =>
        excludedChildPaths?.includes(physicalPluginRoot) === true
      )).toBe(true);
      expect(pluginAliases.map(({ scope }) => scope)).toEqual(["global", "project"]);
      expect(new Set(pluginAliases.map(({ id }) => id)).size).toBe(2);

      const walked = await walkInventory(plan);
      expect(directAliases.map(({ id }) =>
        walked.sources.find((source) => source.id === id)?.status
      )).toEqual(["scanned", "scanned"]);
      const candidate = walked.candidates.find(({ path }) =>
        path === physicalPluginRoot
      );
      const directSourceIds = new Set(directAliases.map(({ id }) => id));
      const pluginSourceIds = new Set(pluginAliases.map(({ id }) => id));
      expect(candidate?.sourceIds.some((id) => directSourceIds.has(id)) ?? false)
        .toBe(false);
      expect(new Set(candidate?.sourceIds)).toEqual(pluginSourceIds);
    }
  );

  it("applies settings precedence to a skills-directory plugin", async () => {
    const tree = await createTree();
    await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "local-tools"
    );
    await writeSettings(tree.userSettings, { "local-tools@skills-dir": true });
    await writeSettings(tree.localSettings, { "local-tools@skills-dir": false });

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "local-tools@skills-dir"
    )).toMatchObject({
      status: "disabled",
      inspectSkills: true,
      pluginNamespace: "local-tools"
    });
  });

  it("uses skills-directory manifest defaultEnabled only after scoped settings", async () => {
    const defaultTree = await createTree();
    await writeSkillsDirectoryPlugin(
      join(defaultTree.claudeHome, "skills"),
      "default-on"
    );
    const defaultPlan = await planClaudeCodeInventory(input(defaultTree));
    expect(defaultPlan.sources.find(({ plugin }) =>
      plugin?.id === "default-on@skills-dir"
    )).toMatchObject({ status: "scanned" });

    const offTree = await createTree();
    await writeSkillsDirectoryPlugin(
      join(offTree.claudeHome, "skills"),
      "default-off",
      { rootSkill: true, manifest: { defaultEnabled: false } }
    );
    const offPlan = await planClaudeCodeInventory(input(offTree));
    expect(offPlan.sources.find(({ plugin }) =>
      plugin?.id === "default-off@skills-dir"
    )).toMatchObject({ status: "disabled", inspectSkills: true });

    await writeSettings(offTree.userSettings, { "default-off@skills-dir": true });
    const overridden = await planClaudeCodeInventory(input(offTree));
    expect(overridden.sources.find(({ plugin }) =>
      plugin?.id === "default-off@skills-dir"
    )).toMatchObject({ status: "scanned" });
  });

  it("rejects a non-boolean skills-directory defaultEnabled", async () => {
    const tree = await createTree();
    await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "bad-default",
      { rootSkill: true, manifest: { defaultEnabled: "yes" } }
    );

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ kind }) => kind === "skills-directory-plugin"))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "CLAUDE_MANIFEST_DEFAULT_ENABLED_INVALID" }
      });
  });

  it("requires a classified skills-directory manifest to remain present", async () => {
    const module = await import("../src/inventory/adapters/claude-code.js");
    const planner = (module as unknown as {
      planClaudeCodeInventoryWithHooks: (
        plannerInput: ReturnType<typeof input>,
        hooks: {
          afterSkillsDirectoryClassification(
            plugins: Array<{ id: string; path: string }>
          ): Promise<void>;
        }
      ) => ReturnType<typeof planClaudeCodeInventory>;
    }).planClaudeCodeInventoryWithHooks;
    const tree = await createTree();
    const pluginRoot = await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "manifest-race"
    );
    await writeSettings(tree.userSettings, { "manifest-race@skills-dir": true });

    const plan = await planner(input(tree), {
      async afterSkillsDirectoryClassification(plugins) {
        expect(plugins).toContainEqual(expect.objectContaining({
          id: "manifest-race@skills-dir"
        }));
        await rm(join(pluginRoot, ".claude-plugin", "plugin.json"));
      }
    });

    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "manifest-race@skills-dir"
    )).toMatchObject({
      status: "missing",
      diagnostic: { code: "CLAUDE_PLUGIN_MANIFEST_MISSING" }
    });
    const walked = await walkInventory(plan);
    expect(walked.candidates.map(({ path }) => path))
      .not.toContain(await realpath(pluginRoot));
  });

  it("rejects a classified skills-directory manifest replaced by another valid file", async () => {
    const module = await import("../src/inventory/adapters/claude-code.js");
    const planner = (module as unknown as {
      planClaudeCodeInventoryWithHooks: (
        plannerInput: ReturnType<typeof input>,
        hooks: {
          afterSkillsDirectoryClassification(
            plugins: Array<{ id: string; path: string }>
          ): Promise<void>;
        }
      ) => ReturnType<typeof planClaudeCodeInventory>;
    }).planClaudeCodeInventoryWithHooks;
    const tree = await createTree();
    const pluginRoot = await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "manifest-swap"
    );
    await writeSettings(tree.userSettings, { "manifest-swap@skills-dir": true });

    const plan = await planner(input(tree), {
      async afterSkillsDirectoryClassification() {
        const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
        await rm(manifestPath);
        await writeFile(manifestPath, JSON.stringify({ name: "replacement" }));
      }
    });

    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "manifest-swap@skills-dir"
    )).toMatchObject({
      status: "invalid",
      diagnostic: { code: "CLAUDE_PLUGIN_MANIFEST_CHANGED" }
    });
  });

  it("keeps skills-directory and cache origins distinct when their IDs collide", async () => {
    const tree = await createTree();
    await writeSkillsDirectoryPlugin(join(tree.claudeHome, "skills"), "foo");
    await writeCachePlugin(tree, "skills-dir", "foo", "1", {
      manifest: { name: "cache-foo" }
    });
    await writeSettings(tree.userSettings, { "foo@skills-dir": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const collisions = plan.sources.filter(({ plugin }) =>
      plugin?.id === "foo@skills-dir"
    );

    expect(new Set(collisions.map(({ kind }) => kind))).toEqual(new Set([
      "skills-directory-plugin",
      "native-plugin"
    ]));
    expect(new Set(collisions.map(({ id }) => id)).size).toBe(2);
    expect(new Set(collisions.map(({ pluginNamespace }) => pluginNamespace)))
      .toEqual(new Set(["foo", "cache-foo"]));
  });

  it("keeps configured-only skills-directory provenance independent from a cache collision", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "skills-dir", "foo", "1", {
      manifest: { name: "cache-foo" }
    });
    await writeSettings(tree.userSettings, { "foo@skills-dir": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const collisions = plan.sources.filter(({ plugin }) =>
      plugin?.id === "foo@skills-dir"
    );
    const missingSkillsDirectory = collisions.filter(({ kind }) =>
      kind === "skills-directory-plugin"
    );

    expect(missingSkillsDirectory).toHaveLength(2);
    expect(missingSkillsDirectory.map(({ scope }) => scope))
      .toEqual(["global", "project"]);
    expect(missingSkillsDirectory.every(({ status, diagnostic }) =>
      status === "missing" &&
      diagnostic?.code === "CLAUDE_SKILLS_DIR_PLUGIN_MISSING"
    )).toBe(true);
    expect(missingSkillsDirectory.map(({ path }) => path)).toEqual([
      join(tree.claudeHome, "skills", "foo"),
      join(tree.cwd, ".claude", "skills", "foo")
    ]);
    expect(collisions.some(({ kind, pluginNamespace }) =>
      kind === "native-plugin" && pluginNamespace === "cache-foo"
    )).toBe(true);
  });

  it("reports disabled configured-only skills-directory provenance at active roots", async () => {
    const tree = await createTree();
    await writeSettings(tree.userSettings, { "disabled-tools@skills-dir": false });

    const plan = await planClaudeCodeInventory(input(tree));
    const configured = plan.sources.filter(({ plugin }) =>
      plugin?.id === "disabled-tools@skills-dir"
    );

    expect(configured).toHaveLength(2);
    expect(configured.every(({ kind, status, diagnostic }) =>
      kind === "skills-directory-plugin" && status === "disabled" &&
      diagnostic?.code === "CLAUDE_PLUGIN_DISABLED"
    )).toBe(true);
  });

  it("preserves user-before-project provenance for same-name skills-directory plugins", async () => {
    const tree = await createTree();
    await writeSkillsDirectoryPlugin(
      join(tree.claudeHome, "skills"),
      "shared-tools"
    );
    await writeSkillsDirectoryPlugin(
      join(tree.cwd, ".claude", "skills"),
      "shared-tools"
    );
    await writeSettings(tree.userSettings, { "shared-tools@skills-dir": true });

    const plan = await planClaudeCodeInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "shared-tools@skills-dir"
    );

    expect(sources.map(({ scope }) => scope)).toEqual(["global", "project"]);
    expect(new Set(sources.map(({ id }) => id)).size).toBe(2);
  });

  it("always reports unobservable enterprise policy as an explicit limitation", async () => {
    const tree = await createTree();

    const first = await planClaudeCodeInventory(input(tree));
    const second = await planClaudeCodeInventory(input(tree));
    const limitation = first.sources.find(({ diagnostic }) =>
      diagnostic?.code === "CLAUDE_MANAGED_STATE_UNOBSERVED"
    );

    expect(limitation).toMatchObject({
      status: "ambiguous",
      harness: "claude",
      ownership: "native-plugin"
    });
    expect(second.sources.find(({ diagnostic }) =>
      diagnostic?.code === "CLAUDE_MANAGED_STATE_UNOBSERVED"
    )?.id).toBe(limitation?.id);
  });

  it("bounds configured and discovered identities under one deterministic plugin cap", async () => {
    const tree = await createTree();
    const enabledPlugins = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [
        `plugin-${String(index).padStart(3, "0")}@team`,
        true
      ])
    );
    await writeSettings(tree.userSettings, enabledPlugins);
    await writeCachePlugin(tree, "team", "zz-cache-only", "1");

    const plan = await planClaudeCodeInventory(input(tree, { maxPlugins: 100 }));
    const identitySources = plan.sources.filter(({ plugin }) => plugin);

    expect(new Set(identitySources.map(({ plugin }) => plugin?.id)).size)
      .toBeLessThanOrEqual(100);
    expect(plan.sources).toContainEqual(expect.objectContaining({
      status: "truncated",
      diagnostic: expect.objectContaining({ code: "CLAUDE_PLUGIN_LIMIT" })
    }));
  });

  it("keeps real component source IDs stable across settings transitions", async () => {
    const tree = await createTree();
    await writeCachePlugin(tree, "team", "stable", "1");
    await writeSettings(tree.userSettings, { "stable@team": true });
    const enabled = await planClaudeCodeInventory(input(tree));
    await writeSettings(tree.userSettings, { "stable@team": false });
    const disabled = await planClaudeCodeInventory(input(tree));

    const enabledSource = enabled.sources.find(({ plugin }) => plugin?.id === "stable@team");
    const disabledSource = disabled.sources.find(({ plugin }) => plugin?.id === "stable@team");
    expect([enabledSource?.status, disabledSource?.status]).toEqual(["scanned", "disabled"]);
    expect(enabledSource?.id).toBe(disabledSource?.id);
  });

  it("rejects a plugin component replaced by an escaping link after planning", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "swap", "1");
    const component = join(root, "skills");
    const moved = join(root, "skills-original");
    const outside = await mkdtemp(join(tmpdir(), "steward-claude-swap-outside-"));
    await writeSkill(join(component, "inside"));
    await writeSkill(join(outside, "outside"));
    await writeSettings(tree.userSettings, { "swap@team": true });
    const plan = await planClaudeCodeInventory(input(tree));
    const source = plan.sources.find(({ plugin }) => plugin?.id === "swap@team");
    expect(source).toBeDefined();

    await rename(component, moved);
    await symlink(outside, component, process.platform === "win32" ? "junction" : "dir");
    const walked = await walkInventory({ sources: [source!] });

    expect(walked.candidates).toEqual([]);
    expect(walked.sources[0]).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" }
    });
  });

  it("rejects a Skill replaced by an escaping link between walk and parse", async () => {
    const tree = await createTree();
    const root = await writeCachePlugin(tree, "team", "parse-swap", "1");
    const skill = join(root, "skills", "review");
    const moved = join(root, "skills", "review-original");
    const outside = await mkdtemp(join(tmpdir(), "steward-claude-parse-outside-"));
    await writeSkill(skill);
    await writeSkill(outside, "outside");
    await writeSettings(tree.userSettings, { "parse-swap@team": true });
    const plan = await planClaudeCodeInventory(input(tree));
    const walked = await walkInventory(plan);
    const physicalSkill = await realpath(skill);
    const candidate = walked.candidates.find(({ path }) => path === physicalSkill);
    expect(candidate?.trustedProof).toBeDefined();

    await rename(skill, moved);
    await symlink(outside, skill, process.platform === "win32" ? "junction" : "dir");

    await expect(parseSkill(candidate!)).rejects.toMatchObject({
      code: "INVENTORY_CANDIDATE_CONTAINMENT_CHANGED"
    });
  });

  it("loads standalone directory symlink aliases once with parse-time identity proof", async () => {
    const tree = await createTree();
    const directRoot = join(tree.claudeHome, "skills");
    const target = join(tree.root, "shared", "review");
    await mkdir(directRoot, { recursive: true });
    await writeSkill(target, "review");
    for (const alias of ["review-a", "review-b"]) {
      await symlink(
        target,
        join(directRoot, alias),
        process.platform === "win32" ? "junction" : "dir"
      );
    }

    const plan = await planClaudeCodeInventory(input(tree));
    const walked = await walkInventory(plan);
    const physicalTarget = await realpath(target);
    const matches = walked.candidates.filter(({ path }) => path === physicalTarget);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.trustedProof).toBeDefined();
    const parsed = await parseSkill(matches[0]!);
    expect(parsed).toMatchObject({ name: "review" });
    expect(parsed).not.toHaveProperty("trustedProof");
    expect(parsed).not.toHaveProperty("candidateContainment");
    const persistedDirect = walked.sources.find(({ path }) =>
      path === resolve(directRoot)
    );
    expect(() => inventorySourceSchema.parse(persistedDirect)).not.toThrow();
    expect(persistedDirect).not.toHaveProperty("symlinkPolicy");
  });

  it("rejects a standalone symlink target replaced between walk and parse", async () => {
    const tree = await createTree();
    const directRoot = join(tree.claudeHome, "skills");
    const target = join(tree.root, "shared", "review");
    const moved = join(tree.root, "shared", "review-original");
    const replacement = join(tree.root, "replacement");
    await mkdir(directRoot, { recursive: true });
    await writeSkill(target, "review");
    await writeSkill(replacement, "replacement");
    await symlink(
      target,
      join(directRoot, "review"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const plan = await planClaudeCodeInventory(input(tree));
    const walked = await walkInventory(plan);
    const physicalTarget = await realpath(target);
    const candidate = walked.candidates.find(({ path }) => path === physicalTarget);
    expect(candidate?.trustedProof).toBeDefined();

    await rename(target, moved);
    await symlink(
      replacement,
      target,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(parseSkill(candidate!)).rejects.toMatchObject({
      code: "INVENTORY_CANDIDATE_CONTAINMENT_CHANGED"
    });
  });

  it("allows plugin Skill symlinks only when their physical target stays in the plugin root", async () => {
    const insideTree = await createTree();
    const insideRoot = await writeCachePlugin(insideTree, "team", "inside-link", "1");
    const insideTarget = join(insideRoot, "shared", "review");
    await writeSkill(insideTarget, "inside-review");
    await symlink(
      insideTarget,
      join(insideRoot, "skills", "review"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeSettings(insideTree.userSettings, { "inside-link@team": true });

    const insideWalk = await walkInventory(
      await planClaudeCodeInventory(input(insideTree))
    );
    expect(insideWalk.candidates.map(({ path }) => path))
      .toContain(await realpath(insideTarget));

    const outsideTree = await createTree();
    const outsideRoot = await writeCachePlugin(outsideTree, "team", "outside-link", "1");
    const outsideTarget = join(outsideTree.root, "outside", "review");
    await writeSkill(outsideTarget, "outside-review");
    await symlink(
      outsideTarget,
      join(outsideRoot, "skills", "review"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeSettings(outsideTree.userSettings, { "outside-link@team": true });

    const outsidePlan = await planClaudeCodeInventory(input(outsideTree));
    const outsideSource = outsidePlan.sources.find(({ plugin }) =>
      plugin?.id === "outside-link@team"
    );
    const outsideWalk = await walkInventory(outsidePlan);
    expect(outsideWalk.candidates.map(({ path }) => path))
      .not.toContain(await realpath(outsideTarget));
    expect(outsideWalk.sources.find(({ id }) => id === outsideSource?.id))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" }
      });
  });

  it.skipIf(process.platform !== "win32")(
    "deduplicates standalone Windows junction aliases",
    async () => {
      const tree = await createTree();
      const directRoot = join(tree.claudeHome, "skills");
      const target = join(tree.root, "junction-target");
      await mkdir(directRoot, { recursive: true });
      await writeSkill(target, "junction-target");
      await symlink(target, join(directRoot, "a"), "junction");
      await symlink(target, join(directRoot, "b"), "junction");

      const walked = await walkInventory(await planClaudeCodeInventory(input(tree)));
      const physicalTarget = await realpath(target);
      expect(walked.candidates.filter(({ path }) => path === physicalTarget))
        .toHaveLength(1);
    }
  );

  it("reports settings, active metadata, and cache failures as bounded evidence", async () => {
    const tree = await createTree();
    await writeFile(tree.userSettings, "{ invalid jsonc");
    await writeFile(tree.installedPlugins, "[]");
    await rm(tree.cache, { recursive: true });

    const plan = await planClaudeCodeInventory(input(tree));
    expect(plan.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "invalid",
        diagnostic: expect.objectContaining({ code: "CLAUDE_SETTINGS_INVALID" })
      }),
      expect.objectContaining({
        status: "invalid",
        diagnostic: expect.objectContaining({ code: "METADATA_NOT_OBJECT" })
      }),
      expect.objectContaining({
        status: "missing",
        diagnostic: expect.objectContaining({ code: "CLAUDE_CACHE_MISSING" })
      })
    ]));
  });

  it("preserves the metadata-size failure code for oversized settings", async () => {
    const tree = await createTree();
    await mkdir(join(tree.userSettings, ".."), { recursive: true });
    await writeFile(tree.userSettings, " ".repeat(256 * 1024 + 1));

    const plan = await planClaudeCodeInventory(input(tree));

    expect(plan.sources.find(({ path }) => path === resolve(tree.userSettings)))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "METADATA_TOO_LARGE" }
      });
  });

  it.each([
    ["maxPlugins", Number.NaN],
    ["maxPlugins", 101],
    ["maxDirectories", Number.POSITIVE_INFINITY],
    ["maxDirectories", 20_001]
  ] as const)("rejects invalid adapter bound %s=%s", async (field, value) => {
    const tree = await createTree();
    await expect(planClaudeCodeInventory(input(tree, { [field]: value })))
      .rejects.toMatchObject({ code: "INVENTORY_INVALID_BOUNDS" });
  });
});
