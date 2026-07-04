import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventorySourceSchema } from "../src/domain.js";
import { planCodexInventory } from "../src/inventory/adapters/codex.js";
import { resolveInventory } from "../src/inventory/resolve.js";
import { walkInventory } from "../src/inventory/walk.js";
import { parseSkill } from "../src/parse-skill.js";

const fixtureRoot = fileURLToPath(
  new URL("fixtures/native-inventory/codex", import.meta.url)
);

interface CodexTree {
  root: string;
  home: string;
  repo: string;
  cwd: string;
  codexHome: string;
  cache: string;
  config: string;
  admin: string;
}

async function createTree(): Promise<CodexTree> {
  const root = await mkdtemp(join(tmpdir(), "steward-codex-inventory-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  const codexHome = join(home, ".codex");
  const cache = join(codexHome, "plugins", "cache");
  const config = join(codexHome, "config.toml");
  const admin = join(root, "etc", "codex", "skills");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(cache, { recursive: true });
  await mkdir(admin, { recursive: true });
  return { root, home, repo, cwd, codexHome, cache, config, admin };
}

async function writeManifestPlugin(
  tree: CodexTree,
  marketplace: string,
  plugin: string,
  version: string,
  manifest: unknown = {},
  roots: string[] = ["skills"]
): Promise<string> {
  const pluginRoot = join(tree.cache, marketplace, plugin, version);
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify(manifest)
  );
  for (const root of roots) {
    await mkdir(join(pluginRoot, root), { recursive: true });
  }
  return pluginRoot;
}

function input(tree: CodexTree) {
  return {
    home: tree.home,
    cwd: tree.cwd,
    codexHome: tree.codexHome,
    configPath: tree.config,
    pluginCachePath: tree.cache,
    adminSkillsPath: tree.admin
  };
}

describe("Codex native inventory planning", () => {
  it("plans every project ancestor plus user and admin direct Skill roots", async () => {
    const tree = await createTree();

    const plan = await planCodexInventory(input(tree));
    const direct = plan.sources.filter(({ ownership }) => ownership === "direct");

    expect(direct.map(({ path }) => path)).toEqual([
      join(tree.cwd, ".agents", "skills"),
      join(tree.repo, "packages", ".agents", "skills"),
      join(tree.repo, ".agents", "skills"),
      join(tree.home, ".agents", "skills"),
      tree.admin
    ]);
    expect(direct).toEqual([
      expect.objectContaining({
        harness: "codex",
        scope: "project",
        kind: "direct-root",
        layout: "children",
        ownership: "direct",
        status: "scanned"
      }),
      expect.objectContaining({ kind: "inherited-root", scope: "project" }),
      expect.objectContaining({ kind: "inherited-root", scope: "project" }),
      expect.objectContaining({ kind: "direct-root", scope: "global" }),
      expect.objectContaining({ kind: "admin-root", scope: "global" })
    ]);
    expect(new Set(direct.map(({ id }) => id)).size).toBe(direct.length);
    expect(direct.map(({ precedenceRank }) => precedenceRank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("uses the exact cache fixture for an enabled single version", async () => {
    const tree = await createTree();
    await cp(join(fixtureRoot, "cache"), tree.cache, { recursive: true });
    await cp(join(fixtureRoot, "config.toml"), tree.config);

    const plan = await planCodexInventory(input(tree));
    const plugin = plan.sources.find(({ plugin }) => plugin?.id === "review@vendor");

    expect(plugin).toMatchObject({
      harness: "codex",
      kind: "native-plugin",
      scope: "global",
      layout: "children",
      ownership: "native-plugin",
      plugin: { id: "review@vendor", version: "1.2.0" },
      status: "scanned",
      path: await realpath(join(tree.cache, "vendor", "review", "1.2.0", "skills"))
    });
    expect(plugin?.manifestPath).toBe(
      await realpath(
        join(tree.cache, "vendor", "review", "1.2.0", ".codex-plugin", "plugin.json")
      )
    );

    const walked = await walkInventory(plan);
    const fixtureSkill = join(
      await realpath(join(tree.cache, "vendor", "review", "1.2.0", "skills")),
      "review"
    );
    const fixtureCandidate = walked.candidates.find(({ path }) => path ===
      fixtureSkill
    );
    expect(fixtureCandidate?.sourceIds).toContain(plugin?.id);
  });

  it("keeps explicit false disabled and malformed enablement ambiguous", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "disabled", "1.0.0");
    const unknownRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "unknown",
      "1.0.0"
    );
    await mkdir(join(unknownRoot, "skills", "unknown-skill"));
    await writeFile(
      join(unknownRoot, "skills", "unknown-skill", "SKILL.md"),
      "---\nname: unknown-skill\ndescription: unknown\n---\n"
    );
    await writeFile(
      tree.config,
      '[plugins."disabled@vendor"]\nenabled = false\n\n[plugins."unknown@vendor"]\nenabled = "yes"\n'
    );

    const plan = await planCodexInventory(input(tree));
    const byPlugin = new Map(
      plan.sources.filter(({ plugin }) => plugin).map((source) => [source.plugin?.id, source])
    );

    expect(byPlugin.get("disabled@vendor")).toMatchObject({
      status: "disabled",
      diagnostic: { code: "CODEX_PLUGIN_DISABLED" }
    });
    expect(byPlugin.get("unknown@vendor")).toMatchObject({
      status: "ambiguous",
      diagnostic: { code: "CODEX_PLUGIN_ENABLEMENT_UNKNOWN" },
      inspectSkills: true
    });
    const walked = await walkInventory(plan);
    expect(walked.candidates).toContainEqual(expect.objectContaining({
      sourceIds: expect.arrayContaining([byPlugin.get("unknown@vendor")?.id])
    }));
  });

  it("keeps a real component source ID stable across enablement transitions", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "stable", "1");

    await writeFile(tree.config, '[plugins."stable@vendor"]\nenabled = true\n');
    const enabled = await planCodexInventory(input(tree));
    await writeFile(tree.config, '[plugins."stable@vendor"]\nenabled = false\n');
    const disabled = await planCodexInventory(input(tree));
    await rm(tree.config);
    const defaulted = await planCodexInventory(input(tree));

    const component = (plan: Awaited<ReturnType<typeof planCodexInventory>>) =>
      plan.sources.find(({ plugin, path }) =>
        plugin?.id === "stable@vendor" && basename(path) === "skills"
      );
    expect([
      component(enabled)?.status,
      component(disabled)?.status,
      component(defaulted)?.status
    ]).toEqual(["scanned", "disabled", "scanned"]);
    expect(new Set([
      component(enabled)?.id,
      component(disabled)?.id,
      component(defaulted)?.id
    ]).size).toBe(1);
  });

  it("retains disabled status while reporting unavailable manifests", async () => {
    const tree = await createTree();
    await mkdir(join(tree.cache, "vendor", "disabled", "1"), { recursive: true });
    await mkdir(join(tree.cache, "vendor", "disabled", "2", ".codex-plugin"), {
      recursive: true
    });
    await writeFile(
      join(tree.cache, "vendor", "disabled", "2", ".codex-plugin", "plugin.json"),
      "not-json"
    );
    await writeFile(tree.config, '[plugins."disabled@vendor"]\nenabled = false\n');

    const plan = await planCodexInventory(input(tree));
    const versions = plan.sources.filter(({ plugin }) =>
      plugin?.id === "disabled@vendor"
    );

    expect(versions.map(({ plugin }) => plugin?.version)).toEqual(["1", "2"]);
    expect(versions.every(({ status }) => status === "disabled")).toBe(true);
    expect(versions.map(({ diagnostic }) => diagnostic?.code)).toEqual([
      "CODEX_PLUGIN_MANIFEST_MISSING",
      "METADATA_INVALID_JSON"
    ]);
    expect(versions.every(({ inspectSkills }) => inspectSkills !== true)).toBe(true);
  });

  it("defaults a single installed version on when config is missing or omits the plugin", async () => {
    const missingConfig = await createTree();
    await writeManifestPlugin(missingConfig, "vendor", "review", "1.0.0");

    const absentKey = await createTree();
    await writeManifestPlugin(absentKey, "vendor", "review", "1.0.0");
    await writeFile(absentKey.config, "[plugins.other]\nenabled = true\n");

    for (const tree of [missingConfig, absentKey]) {
      const plan = await planCodexInventory(input(tree));
      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
        .toMatchObject({
          status: "scanned"
        });
      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor")?.diagnostic)
        .toBeUndefined();
    }
  });

  it("makes globally disabled plugin sources inactive despite per-plugin, version, or metadata state", async () => {
    const tree = await createTree();
    const installedRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "installed",
      "1"
    );
    const installedSkill = join(installedRoot, "skills", "global-gated");
    await mkdir(installedSkill);
    await writeFile(
      join(installedSkill, "SKILL.md"),
      "---\nname: global-gated\ndescription: Globally gated Skill\n---\n"
    );
    await writeManifestPlugin(tree, "vendor", "multi", "1");
    await writeManifestPlugin(tree, "vendor", "multi", "2");
    await mkdir(join(tree.cache, "vendor", "broken", "1"), { recursive: true });
    await mkdir(join(tree.cache, "vendor", "empty"), { recursive: true });
    await writeFile(
      tree.config,
      [
        "[features]",
        "plugins = false",
        "",
        '[plugins."multi@vendor"]',
        "enabled = true",
        "",
        '[plugins."broken@vendor"]',
        "enabled = true",
        "",
        '[plugins."not-installed@vendor"]',
        "enabled = true"
      ].join("\n")
    );

    const plan = await planCodexInventory(input(tree));
    const pluginSources = plan.sources.filter(({ plugin }) =>
      plugin && ["installed@vendor", "multi@vendor", "broken@vendor"].includes(plugin.id)
    );

    expect(pluginSources).not.toHaveLength(0);
    expect(pluginSources.every(({ status }) => status === "disabled")).toBe(true);
    expect(pluginSources.some(({ status }) => status === "scanned")).toBe(false);
    expect(pluginSources.find(({ plugin }) => plugin?.id === "installed@vendor"))
      .toMatchObject({
        status: "disabled",
        diagnostic: {
          code: "CODEX_PLUGINS_FEATURE_DISABLED",
          message: "Codex plugin support is disabled in config.toml"
        },
        inspectSkills: true
      });
    expect(pluginSources.filter(({ plugin }) => plugin?.id === "multi@vendor"))
      .toHaveLength(2);
    expect(pluginSources.find(({ plugin }) => plugin?.id === "broken@vendor"))
      .toMatchObject({
        status: "disabled",
        diagnostic: { code: "CODEX_PLUGIN_MANIFEST_MISSING" }
      });
    expect(plan.sources.find(({ plugin }) => plugin?.id === "empty@vendor"))
      .toMatchObject({
        status: "missing",
        diagnostic: { code: "CODEX_PLUGIN_VERSION_MISSING" }
      });
    expect(plan.sources.find(({ plugin }) => plugin?.id === "not-installed@vendor"))
      .toMatchObject({
        status: "missing",
        diagnostic: { code: "CODEX_PLUGIN_CACHE_MISSING" }
      });
    expect(JSON.stringify(pluginSources.map(({ diagnostic }) => diagnostic)))
      .not.toContain(tree.root);

    const walked = await walkInventory(plan);
    const parsed = await Promise.all(walked.candidates.map(async (candidate) => ({
      candidate,
      skill: await parseSkill(candidate)
    })));
    const resolved = resolveInventory(plan, walked.sources, parsed);
    const gated = resolved.skills.find(({ name }) => name === "global-gated");
    expect(gated).toMatchObject({
      visibleTo: [],
      exposures: [expect.objectContaining({
        harness: "codex",
        state: "inactive",
        reason: "SOURCE_DISABLED"
      })]
    });
  });

  it("disables only regular-marker remote roots when remote plugins are off", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "remote-market", "remote", "1");
    const remoteRoot = join(tree.cache, "remote-market", "remote");
    await writeFile(
      join(remoteRoot, ".codex-remote-plugin-install.json"),
      JSON.stringify({ schema_version: 1, remote_plugin_id: "remote" })
    );
    await writeManifestPlugin(tree, "bundled-market", "bundled", "1");
    await writeFile(tree.config, "[features]\nremote_plugin = false\n");

    const plan = await planCodexInventory(input(tree));
    const remote = plan.sources.find(({ plugin }) =>
      plugin?.id === "remote@remote-market" && plugin.version === "1"
    );
    const bundled = plan.sources.find(({ plugin }) =>
      plugin?.id === "bundled@bundled-market" && plugin.version === "1"
    );

    expect(remote).toMatchObject({
      status: "disabled",
      diagnostic: {
        code: "CODEX_REMOTE_PLUGIN_FEATURE_DISABLED",
        message: "Codex remote plugin support is disabled in config.toml"
      }
    });
    expect(bundled).toMatchObject({ status: "scanned" });
    expect(bundled?.diagnostic).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "does not treat a symlinked remote marker as remote-root proof",
    async () => {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "linked-marker", "1");
      const pluginRoot = join(tree.cache, "vendor", "linked-marker");
      await symlink("1", join(pluginRoot, ".codex-remote-plugin-install.json"), "dir");
      await writeFile(tree.config, "[features]\nremote_plugin = false\n");

      const plan = await planCodexInventory(input(tree));
      const physicalVersion = plan.sources.find(({ plugin }) =>
        plugin?.id === "linked-marker@vendor" && plugin.version === "1"
      );
      const marker = plan.sources.find(({ plugin }) =>
        plugin?.id === "linked-marker@vendor" &&
        plugin.version === ".codex-remote-plugin-install.json"
      );

      expect(physicalVersion).toMatchObject({ status: "scanned" });
      expect(marker).toMatchObject({
        status: "invalid",
        diagnostic: { code: "CODEX_CACHE_SYMLINK_REFUSED" }
      });
    }
  );

  it("fails closed only for malformed relevant feature configuration", async () => {
    const malformedConfigs = [
      'features = false\n\n[plugins."review@vendor"]\nenabled = true\n',
      '[features]\nplugins = "no"\n\n[plugins."review@vendor"]\nenabled = true\n',
      '[features]\nremote_plugin = []\n\n[plugins."review@vendor"]\nenabled = true\n'
    ];

    for (const config of malformedConfigs) {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "review", "1");
      await writeFile(tree.config, config);

      const plan = await planCodexInventory(input(tree));
      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
        .toMatchObject({
          status: "ambiguous",
          diagnostic: { code: "CODEX_CONFIG_INVALID" }
        });
    }

    const unrelated = await createTree();
    await writeManifestPlugin(unrelated, "vendor", "review", "1");
    await writeFile(
      unrelated.config,
      "[features]\nunrelated_future_flag = \"not-our-schema\"\n"
    );
    const unrelatedPlan = await planCodexInventory(input(unrelated));
    expect(unrelatedPlan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
      .toMatchObject({ status: "scanned" });
  });

  it("marks conflicting selectable profile gates ambiguous when selection is unknown", async () => {
    for (const [baseEnabled, profileEnabled] of [[true, false], [false, true]]) {
      const tree = await createTree();
      const pluginRoot = await writeManifestPlugin(tree, "vendor", "review", "1");
      const skill = join(pluginRoot, "skills", "profile-gated");
      await mkdir(skill);
      await writeFile(
        join(skill, "SKILL.md"),
        "---\nname: profile-gated\ndescription: Profile gated Skill\n---\n"
      );
      await writeFile(
        tree.config,
        `[features]\nplugins = ${String(baseEnabled)}\n`
      );
      await writeFile(
        join(tree.codexHome, "conflict.config.toml"),
        `[features]\nplugins = ${String(profileEnabled)}\n`
      );

      const plan = await planCodexInventory(input(tree));
      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
        .toMatchObject({
          status: "ambiguous",
          diagnostic: {
            code: "CODEX_PROFILE_SELECTION_UNKNOWN",
            message: "Codex profile selection can change plugin feature state"
          },
          inspectSkills: true
        });

      const walked = await walkInventory(plan);
      const parsed = await Promise.all(walked.candidates.map(async (candidate) => ({
        candidate,
        skill: await parseSkill(candidate)
      })));
      const resolved = resolveInventory(plan, walked.sources, parsed);
      expect(resolved.skills.find(({ name }) => name === "profile-gated"))
        .toMatchObject({
          visibleTo: [],
          exposures: [expect.objectContaining({
            harness: "codex",
            state: "ambiguous",
            reason: "SOURCE_AMBIGUOUS"
          })]
        });
    }
  });

  it("limits remote profile uncertainty to proven remote plugin roots", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "remote-market", "remote", "1");
    await writeFile(
      join(
        tree.cache,
        "remote-market",
        "remote",
        ".codex-remote-plugin-install.json"
      ),
      JSON.stringify({ schema_version: 1, remote_plugin_id: "remote" })
    );
    await writeManifestPlugin(tree, "bundled-market", "bundled", "1");
    await writeFile(tree.config, "[features]\nremote_plugin = true\n");
    await writeFile(
      join(tree.codexHome, "remote-off.config.toml"),
      "[features]\nremote_plugin = false\n"
    );

    const plan = await planCodexInventory(input(tree));
    expect(plan.sources.find(({ plugin }) => plugin?.id === "remote@remote-market"))
      .toMatchObject({
        status: "ambiguous",
        diagnostic: { code: "CODEX_PROFILE_SELECTION_UNKNOWN" }
      });
    expect(plan.sources.find(({ plugin }) => plugin?.id === "bundled@bundled-market"))
      .toMatchObject({ status: "scanned" });
  });

  it("keeps an invariant global disable ahead of remote-only profile uncertainty", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "remote-market", "remote", "1");
    await writeFile(
      join(
        tree.cache,
        "remote-market",
        "remote",
        ".codex-remote-plugin-install.json"
      ),
      JSON.stringify({ schema_version: 1, remote_plugin_id: "remote" })
    );
    await writeFile(
      tree.config,
      "[features]\nplugins = false\nremote_plugin = true\n"
    );
    await writeFile(
      join(tree.codexHome, "remote-off.config.toml"),
      "[features]\nremote_plugin = false\n"
    );

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "remote@remote-market"))
      .toMatchObject({
        status: "disabled",
        diagnostic: { code: "CODEX_PLUGINS_FEATURE_DISABLED" }
      });
  });

  it("ignores model-only profiles and obsolete embedded profile selectors", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "review", "1");
    await writeFile(
      tree.config,
      'profile = "obsolete"\n\n[profiles.obsolete.features]\nplugins = false\n'
    );
    await writeFile(
      join(tree.codexHome, "model-only.config.toml"),
      'model = "gpt-example"\n'
    );

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
      .toMatchObject({ status: "scanned" });
  });

  it("overlays only relevant gates from an explicit active profile", async () => {
    for (const [baseEnabled, profileEnabled, expected] of [
      [true, false, "disabled"],
      [false, true, "scanned"]
    ] as const) {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "review", "1");
      await writeFile(
        tree.config,
        `[features]\nplugins = ${String(baseEnabled)}\n`
      );
      await writeFile(
        join(tree.codexHome, "selected.config.toml"),
        `[features]\nplugins = ${String(profileEnabled)}\n`
      );

      const plan = await planCodexInventory({
        ...input(tree),
        activeProfile: "selected"
      });
      const source = plan.sources.find(({ plugin }) => plugin?.id === "review@vendor");

      expect(source).toMatchObject({ status: expected });
      if (expected === "scanned") expect(source?.diagnostic).toBeUndefined();
    }
  });

  it("fails closed for unsafe, missing, invalid, or truncated profile discovery", async () => {
    for (const activeProfile of ["../escape", "missing", "x".repeat(129)]) {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "review", "1");
      const plan = await planCodexInventory({
        ...input(tree),
        activeProfile
      });
      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
        .toMatchObject({
          status: "ambiguous",
          diagnostic: { code: "CODEX_PROFILE_SELECTION_UNKNOWN" }
        });
    }

    const invalid = await createTree();
    await writeManifestPlugin(invalid, "vendor", "review", "1");
    await writeFile(join(invalid.codexHome, "broken.config.toml"), "[features\n");
    const invalidPlan = await planCodexInventory(input(invalid));
    expect(invalidPlan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
      .toMatchObject({
        status: "ambiguous",
        diagnostic: { code: "CODEX_PROFILE_SELECTION_UNKNOWN" }
      });

    const bounded = await createTree();
    await writeManifestPlugin(bounded, "vendor", "review", "1");
    await writeFile(join(bounded.codexHome, "a.config.toml"), 'model = "gpt"\n');
    await writeFile(
      join(bounded.codexHome, "z.config.toml"),
      "[features]\nplugins = false\n"
    );
    const boundedPlan = await planCodexInventory({
      ...input(bounded),
      limits: { maxProfiles: 1 }
    });
    expect(boundedPlan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
      .toMatchObject({
        status: "ambiguous",
        diagnostic: { code: "CODEX_PROFILE_SELECTION_UNKNOWN" }
      });
  });

  it("excludes a profile-shaped base config before applying the profile cap", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "review", "1");
    const shapedBase = join(tree.codexHome, "base.config.toml");
    await writeFile(shapedBase, "[features]\nplugins = true\n");

    const plan = await planCodexInventory({
      ...input(tree),
      configPath: shapedBase,
      limits: { maxProfiles: 0 }
    });

    expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
      .toMatchObject({ status: "scanned" });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink as the explicit active profile file",
    async () => {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "review", "1");
      const outside = join(tree.root, "outside-profile.toml");
      await writeFile(outside, "[features]\nplugins = false\n");
      await symlink(outside, join(tree.codexHome, "linked.config.toml"), "file");

      const plan = await planCodexInventory({
        ...input(tree),
        activeProfile: "linked"
      });

      expect(plan.sources.find(({ plugin }) => plugin?.id === "review@vendor"))
        .toMatchObject({
          status: "ambiguous",
          diagnostic: { code: "CODEX_PROFILE_SELECTION_UNKNOWN" }
        });
    }
  );

  it("makes malformed regular remote markers ambiguous without consuming version capacity", async () => {
    const malformedMarkers = [
      "not-json",
      JSON.stringify({ schema_version: 2, remote_plugin_id: "remote" }),
      JSON.stringify({ schema_version: 1, remote_plugin_id: "" }),
      JSON.stringify({ schema_version: 1, remote_plugin_id: "x".repeat(257) }),
      "x".repeat((256 * 1024) + 1)
    ];

    for (const marker of malformedMarkers) {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "remote", "1");
      await writeFile(
        join(tree.cache, "vendor", "remote", ".codex-remote-plugin-install.json"),
        marker
      );

      const plan = await planCodexInventory({
        ...input(tree),
        limits: { maxDirectories: 5 }
      });
      const pluginSources = plan.sources.filter(({ plugin }) =>
        plugin?.id === "remote@vendor"
      );

      expect(pluginSources).toEqual([
        expect.objectContaining({
          plugin: { id: "remote@vendor", version: "1" },
          status: "ambiguous",
          diagnostic: {
            code: "CODEX_REMOTE_PLUGIN_MARKER_INVALID",
            message: "Codex remote plugin marker is invalid"
          }
        })
      ]);
      expect(plan.sources.some(({ diagnostic }) =>
        diagnostic?.code === "CODEX_DIRECTORY_LIMIT"
      )).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "ignores exact Codex version metadata and scans the lone physical bundle",
    async () => {
      const tree = await createTree();
      const versionRoot = await writeManifestPlugin(
        tree,
        "openai-curated-remote",
        "github",
        "0.1.5"
      );
      const pluginRoot = join(tree.cache, "openai-curated-remote", "github");
      const marker = join(pluginRoot, ".codex-remote-plugin-install.json");
      const latest = join(pluginRoot, "latest");
      const skill = join(versionRoot, "skills", "github");
      await writeFile(
        marker,
        JSON.stringify({
          schema_version: 1,
          remote_plugin_id: "github"
        })
      );
      await symlink("0.1.5", latest, "dir");
      await mkdir(skill);
      await writeFile(
        join(skill, "SKILL.md"),
        "---\nname: github\ndescription: GitHub workflows\n---\n"
      );

      const plan = await planCodexInventory(input(tree));
      const physicalPluginRoot = await realpath(pluginRoot);
      const pluginSources = plan.sources.filter(({ plugin }) =>
        plugin?.id === "github@openai-curated-remote"
      );

      expect(pluginSources).toEqual([
        expect.objectContaining({
          plugin: {
            id: "github@openai-curated-remote",
            version: "0.1.5"
          },
          path: await realpath(join(versionRoot, "skills")),
          status: "scanned"
        })
      ]);
      expect(pluginSources[0]?.diagnostic).toBeUndefined();
      expect(plan.sources.some(({ path }) =>
        path === join(physicalPluginRoot, basename(marker)) ||
        path === join(physicalPluginRoot, basename(latest))
      )).toBe(false);
      expect(plan.sources.some(({ plugin }) =>
        plugin?.version === ".codex-remote-plugin-install.json" ||
        plugin?.version === "latest"
      )).toBe(false);

      const walked = await walkInventory(plan);
      expect(walked.candidates).toContainEqual(expect.objectContaining({
        path: await realpath(skill),
        sourceIds: [pluginSources[0]?.id]
      }));
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not charge known version metadata against a tight directory budget",
    async () => {
      const tree = await createTree();
      await writeManifestPlugin(tree, "vendor", "bounded", "1");
      const pluginRoot = join(tree.cache, "vendor", "bounded");
      await writeFile(
        join(pluginRoot, ".codex-remote-plugin-install.json"),
        JSON.stringify({ schema_version: 1, remote_plugin_id: "bounded" })
      );
      await symlink("1", join(pluginRoot, "latest"), "dir");

      const plan = await planCodexInventory({
        ...input(tree),
        limits: { maxDirectories: 5 }
      });
      const pluginSources = plan.sources.filter(({ plugin }) =>
        plugin?.id === "bounded@vendor"
      );

      expect(pluginSources).toEqual([
        expect.objectContaining({
          plugin: { id: "bounded@vendor", version: "1" },
          status: "scanned"
        })
      ]);
      expect(plan.sources.some(({ diagnostic }) =>
        diagnostic?.code === "CODEX_DIRECTORY_LIMIT"
      )).toBe(false);
    }
  );

  it("keeps unknown version-root files invalid without making the physical version ambiguous", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "review", "1.0.0");
    const unknown = join(tree.cache, "vendor", "review", "notes.json");
    await writeFile(unknown, "{}\n");

    const plan = await planCodexInventory(input(tree));
    const pluginSources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "review@vendor"
    );

    expect(pluginSources.find(({ plugin }) => plugin?.version === "1.0.0"))
      .toMatchObject({ status: "scanned" });
    expect(pluginSources.find(({ plugin }) => plugin?.version === basename(unknown)))
      .toMatchObject({
        plugin: { id: "review@vendor", version: "notes.json" },
        status: "invalid",
        diagnostic: { code: "CODEX_CACHE_ENTRY_NOT_DIRECTORY" }
      });
    expect(pluginSources.some(({ status, diagnostic }) =>
      status === "ambiguous" || diagnostic?.code === "CODEX_PLUGIN_VERSION_AMBIGUOUS"
    )).toBe(false);
  });

  it("never guesses among multiple plausible cache versions", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "review", "2.0.0");
    await writeManifestPlugin(tree, "vendor", "review", "10.0.0");
    await writeFile(tree.config, '[plugins."review@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));
    const versions = plan.sources.filter(({ plugin }) => plugin?.id === "review@vendor");

    expect(versions.map(({ plugin }) => plugin?.version)).toEqual(["10.0.0", "2.0.0"]);
    expect(versions.every(({ status }) => status === "ambiguous")).toBe(true);
    expect(versions.every(({ diagnostic }) =>
      diagnostic?.code === "CODEX_PLUGIN_VERSION_AMBIGUOUS"
    )).toBe(true);
    expect(versions.every(({ inspectSkills }) => inspectSkills === true)).toBe(true);
  });

  it("keeps mixed-quality plausible versions ambiguous without selecting a winner", async () => {
    const tree = await createTree();
    await mkdir(join(tree.cache, "vendor", "mixed", "1"), { recursive: true });
    await writeManifestPlugin(tree, "vendor", "mixed", "2");
    await writeFile(tree.config, '[plugins."mixed@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));
    const versions = plan.sources.filter(({ plugin }) => plugin?.id === "mixed@vendor");

    expect(versions.map(({ plugin }) => plugin?.version)).toEqual(["1", "2"]);
    expect(versions.every(({ status }) => status === "ambiguous")).toBe(true);
    expect(versions.map(({ diagnostic }) => diagnostic?.code)).toEqual([
      "CODEX_PLUGIN_MANIFEST_MISSING",
      "CODEX_PLUGIN_VERSION_AMBIGUOUS"
    ]);
    expect(versions.find(({ plugin }) => plugin?.version === "1")?.inspectSkills)
      .not.toBe(true);
    expect(versions.find(({ plugin }) => plugin?.version === "2")?.inspectSkills)
      .toBe(true);
  });

  it("walks valid disabled and multi-version components without making them effective", async () => {
    const disabledTree = await createTree();
    const disabledRoot = await writeManifestPlugin(
      disabledTree,
      "vendor",
      "disabled",
      "1"
    );
    await mkdir(join(disabledRoot, "skills", "disabled-skill"));
    await writeFile(
      join(disabledRoot, "skills", "disabled-skill", "SKILL.md"),
      "---\nname: disabled-skill\ndescription: disabled\n---\n"
    );
    await writeFile(
      disabledTree.config,
      '[plugins."disabled@vendor"]\nenabled = false\n'
    );

    const multiTree = await createTree();
    for (const version of ["1", "2"]) {
      const root = await writeManifestPlugin(multiTree, "vendor", "multi", version);
      await mkdir(join(root, "skills", `skill-${version}`));
      await writeFile(
        join(root, "skills", `skill-${version}`, "SKILL.md"),
        `---\nname: skill-${version}\ndescription: multi\n---\n`
      );
    }
    await writeFile(multiTree.config, '[plugins."multi@vendor"]\nenabled = true\n');

    const disabledPlan = await planCodexInventory(input(disabledTree));
    const multiPlan = await planCodexInventory(input(multiTree));
    const disabledWalk = await walkInventory(disabledPlan);
    const multiWalk = await walkInventory(multiPlan);
    const disabledSource = disabledPlan.sources.find(({ plugin }) =>
      plugin?.id === "disabled@vendor"
    );
    const multiSources = multiPlan.sources.filter(({ plugin }) =>
      plugin?.id === "multi@vendor"
    );

    expect(disabledSource).toMatchObject({ status: "disabled", inspectSkills: true });
    expect(disabledWalk.candidates).toContainEqual(expect.objectContaining({
      sourceIds: expect.arrayContaining([disabledSource?.id])
    }));
    expect(disabledWalk.sources.find(({ id }) => id === disabledSource?.id))
      .toMatchObject({ status: "disabled", skillCount: 1 });
    expect(multiSources).toHaveLength(2);
    expect(multiSources.every(({ status, inspectSkills }) =>
      status === "ambiguous" && inspectSkills === true
    )).toBe(true);
    expect(multiWalk.candidates).toHaveLength(2);
    expect(new Set(multiWalk.candidates.flatMap(({ sourceIds }) => sourceIds)))
      .toEqual(new Set(multiSources.map(({ id }) => id)));
    expect(multiWalk.sources.filter(({ id }) =>
      multiSources.some((source) => source.id === id)
    ).every(({ status, skillCount }) =>
      status === "ambiguous" && skillCount === 1
    )).toBe(true);
  });

  it("accepts default, custom string, and custom array Skill roots", async () => {
    const tree = await createTree();
    const defaults = await writeManifestPlugin(tree, "vendor", "defaults", "1", {});
    const custom = await writeManifestPlugin(
      tree,
      "vendor",
      "custom",
      "1",
      { skills: "components/skills" },
      ["components/skills"]
    );
    const multiple = await writeManifestPlugin(
      tree,
      "vendor",
      "multiple",
      "1",
      { skills: ["z-skills", "a-skills"] },
      ["z-skills", "a-skills"]
    );
    await writeFile(
      tree.config,
      ["defaults", "custom", "multiple"]
        .map((name) => `[plugins."${name}@vendor"]\nenabled = true`)
        .join("\n\n")
    );

    const plan = await planCodexInventory(input(tree));
    const pluginPaths = (id: string) => plan.sources
      .filter(({ plugin }) => plugin?.id === id)
      .map(({ path }) => path);

    expect(pluginPaths("defaults@vendor")).toEqual([await realpath(join(defaults, "skills"))]);
    expect(pluginPaths("custom@vendor")).toEqual([
      await realpath(join(custom, "components", "skills"))
    ]);
    expect(pluginPaths("multiple@vendor")).toEqual([
      await realpath(join(multiple, "a-skills")),
      await realpath(join(multiple, "z-skills"))
    ]);
    const multipleIds = plan.sources
      .filter(({ plugin }) => plugin?.id === "multiple@vendor")
      .map(({ id }) => id);
    expect(new Set(multipleIds).size).toBe(2);
  });

  it("bounds large manifest component fan-out with deterministic truncation evidence", async () => {
    const tree = await createTree();
    const declared = Array.from(
      { length: 2_000 },
      (_, index) => `component-${String(index).padStart(4, "0")}`
    );
    const pluginRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "fanout",
      "1",
      { skills: declared },
      []
    );
    for (const path of declared.slice(0, 3)) {
      await mkdir(join(pluginRoot, path));
    }
    await writeFile(tree.config, '[plugins."fanout@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory({
      ...input(tree),
      limits: { maxDirectories: 7 }
    });
    const pluginSources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "fanout@vendor"
    );

    expect(pluginSources.filter(({ diagnostic }) =>
      diagnostic?.code !== "CODEX_DIRECTORY_LIMIT"
    ).map(({ path }) => basename(path))).toEqual(declared.slice(0, 3));
    expect(pluginSources).toHaveLength(4);
    expect(pluginSources).toContainEqual(expect.objectContaining({
      status: "truncated",
      diagnostic: expect.objectContaining({ code: "CODEX_DIRECTORY_LIMIT" })
    }));
    expect(plan.bounds?.maxDirectories).toBe(0);
    expect(plan.sources.length).toBeLessThanOrEqual(10);
  });

  it("rejects deeply nested component declarations before ancestor probing", async () => {
    const tree = await createTree();
    const deeplyNested = `${Array.from({ length: 200 }, () => "nested").join("/")}/missing`;
    const pluginRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "deep-component",
      "1",
      { skills: deeplyNested },
      []
    );
    await writeFile(
      tree.config,
      '[plugins."deep-component@vendor"]\nenabled = true\n'
    );

    const plan = await planCodexInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "deep-component@vendor"
    );

    expect(sources).toEqual([
      expect.objectContaining({
        path: await realpath(pluginRoot),
        status: "truncated",
        diagnostic: expect.objectContaining({ code: "CODEX_COMPONENT_DEPTH_LIMIT" })
      })
    ]);
    expect(sources[0]?.path.length).toBeLessThan(deeplyNested.length);
  });

  it("isolates missing and invalid manifests without losing direct roots", async () => {
    const tree = await createTree();
    const missing = join(tree.cache, "vendor", "missing", "1");
    await mkdir(missing, { recursive: true });
    const invalid = join(tree.cache, "vendor", "invalid", "1", ".codex-plugin");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, "plugin.json"), "[]");
    await writeManifestPlugin(tree, "vendor", "bad-field", "1", { skills: 42 });
    await writeManifestPlugin(tree, "vendor", "empty-field", "1", { skills: [""] });
    await writeFile(
      tree.config,
      ["missing", "invalid", "bad-field", "empty-field"]
        .map((name) => `[plugins."${name}@vendor"]\nenabled = true`)
        .join("\n\n")
    );

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.filter(({ ownership }) => ownership === "direct")).toHaveLength(5);
    expect(plan.sources.filter(({ plugin }) => plugin).map((source) => ({
      plugin: source.plugin?.id,
      status: source.status,
      code: source.diagnostic?.code
    }))).toEqual([
      { plugin: "bad-field@vendor", status: "invalid", code: "CODEX_MANIFEST_SKILLS_INVALID" },
      { plugin: "empty-field@vendor", status: "invalid", code: "CODEX_MANIFEST_SKILLS_INVALID" },
      { plugin: "invalid@vendor", status: "invalid", code: "METADATA_NOT_OBJECT" },
      { plugin: "missing@vendor", status: "invalid", code: "CODEX_PLUGIN_MANIFEST_MISSING" }
    ]);
  });

  it("retains a plugin directory that has no real cached version", async () => {
    const tree = await createTree();
    const emptyPlugin = join(tree.cache, "vendor", "empty");
    await mkdir(emptyPlugin, { recursive: true });
    await writeFile(tree.config, '[plugins."empty@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "empty@vendor"))
      .toMatchObject({
        path: await realpath(emptyPlugin),
        status: "missing",
        diagnostic: { code: "CODEX_PLUGIN_VERSION_MISSING" }
      });
  });

  it("rejects a manifest component that resolves to a regular file", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "file-root",
      "1",
      { skills: "skills.txt" },
      []
    );
    await writeFile(join(pluginRoot, "skills.txt"), "not a directory");
    await writeFile(tree.config, '[plugins."file-root@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "file-root@vendor"))
      .toMatchObject({
        status: "invalid",
        diagnostic: { code: "CODEX_COMPONENT_NOT_DIRECTORY" }
      });
  });

  it("preserves disabled disposition for missing, file, and escaping components", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(
      tree,
      "vendor",
      "disabled-components",
      "1",
      { skills: ["missing", "skills.txt", "../escape"] },
      []
    );
    await writeFile(join(pluginRoot, "skills.txt"), "not a directory");
    await writeFile(
      tree.config,
      '[plugins."disabled-components@vendor"]\nenabled = false\n'
    );

    const plan = await planCodexInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "disabled-components@vendor"
    );

    expect(sources).toHaveLength(3);
    expect(sources.every(({ status, inspectSkills }) =>
      status === "disabled" && inspectSkills !== true
    )).toBe(true);
    expect(new Set(sources.map(({ diagnostic }) => diagnostic?.code))).toEqual(
      new Set([
        "COMPONENT_PATH_ESCAPE",
        "COMPONENT_PATH_MISSING",
        "CODEX_COMPONENT_NOT_DIRECTORY"
      ])
    );
  });

  it("preserves multi-version ambiguity for missing components", async () => {
    const tree = await createTree();
    for (const version of ["1", "2"]) {
      await writeManifestPlugin(
        tree,
        "vendor",
        "missing-components",
        version,
        { skills: "missing" },
        []
      );
    }
    await writeFile(
      tree.config,
      '[plugins."missing-components@vendor"]\nenabled = true\n'
    );

    const plan = await planCodexInventory(input(tree));
    const sources = plan.sources.filter(({ plugin }) =>
      plugin?.id === "missing-components@vendor"
    );

    expect(sources).toHaveLength(2);
    expect(sources.every(({ status, diagnostic, inspectSkills }) =>
      status === "ambiguous" &&
      diagnostic?.code === "COMPONENT_PATH_MISSING" &&
      inspectSkills !== true
    )).toBe(true);
  });

  it("turns invalid config into explicit plugin ambiguity while retaining direct roots", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "review", "1");
    await writeFile(tree.config, '[plugins."review@vendor"\nenabled = true');

    const plan = await planCodexInventory(input(tree));
    const plugin = plan.sources.find(({ plugin }) => plugin?.id === "review@vendor");

    expect(plugin).toMatchObject({
      status: "ambiguous",
      diagnostic: { code: "CODEX_CONFIG_INVALID" }
    });
    expect(plan.sources.filter(({ ownership }) => ownership === "direct"))
      .toHaveLength(5);
  });

  it("retains invalid config evidence even when the cache has no plugins", async () => {
    const tree = await createTree();
    await writeFile(tree.config, "[plugins.broken\nenabled = true");

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources).toContainEqual(expect.objectContaining({
      path: tree.config,
      status: "invalid",
      diagnostic: expect.objectContaining({ code: "CODEX_CONFIG_INVALID" })
    }));
  });

  it("never walks terminal config, cache, or limit sentinels", async () => {
    const tree = await createTree();
    await writeFile(tree.config, "[plugins.broken\nenabled = true");

    const plan = await planCodexInventory(input(tree));
    const walked = await walkInventory(plan);
    const terminalIds = new Set(plan.sources
      .filter(({ diagnostic }) => diagnostic?.code === "CODEX_CONFIG_INVALID")
      .map(({ id }) => id));

    expect(walked.candidates.flatMap(({ sourceIds }) => sourceIds)
      .some((id) => terminalIds.has(id))).toBe(false);
    expect(walked.sources.filter(({ id }) => terminalIds.has(id)))
      .toEqual([expect.objectContaining({ skillCount: 0, status: "invalid" })]);
  });

  it("retains an explicitly missing cache source without configured plugins", async () => {
    const tree = await createTree();
    await rm(tree.cache, { recursive: true });

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources).toContainEqual(expect.objectContaining({
      path: tree.cache,
      status: "missing",
      diagnostic: expect.objectContaining({ code: "CODEX_CACHE_MISSING" })
    }));
  });

  it("does not turn escaping configured plugin IDs into cache paths", async () => {
    const tree = await createTree();
    await writeFile(tree.config, '[plugins."..@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));
    const configured = plan.sources.find(({ plugin }) => plugin?.id === "..@vendor");

    expect(configured).toMatchObject({
      path: tree.cache,
      status: "invalid",
      diagnostic: { code: "CODEX_CONFIG_PLUGIN_ID_INVALID" }
    });
    expect(configured?.path).toBe(tree.cache);
  });

  it("rejects Windows drive-relative, reserved, and non-portable plugin segments", async () => {
    const tree = await createTree();
    const driveRelative = `${win32.parse("C:plugin").root}plugin`;
    const invalidIds = [
      `${driveRelative}@vendor`,
      "plugin@C:vendor",
      "CON@vendor",
      "CONOUT$@vendor",
      "plugin@NUL.txt",
      "plugin.@vendor",
      "plugin@vendor ",
      "aux.txt@market"
    ];
    await writeFile(
      tree.config,
      invalidIds.map((id) => `[plugins.${JSON.stringify(id)}]\nenabled = true`)
        .join("\n\n")
    );

    const plan = await planCodexInventory(input(tree));
    const invalid = plan.sources.filter(({ plugin }) =>
      plugin && invalidIds.includes(plugin.id)
    );

    expect(invalid).toHaveLength(invalidIds.length);
    expect(invalid.every(({ path, status, diagnostic }) =>
      path === tree.cache &&
      status === "invalid" &&
      diagnostic?.code === "CODEX_CONFIG_PLUGIN_ID_INVALID"
    )).toBe(true);
  });

  it("retains every configured identity under the shared 100-plugin cap", async () => {
    const tree = await createTree();
    const entries: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const id = `configured-${String(index).padStart(3, "0")}@vendor`;
      entries.push(index % 2 === 0
        ? `[plugins."${id}"]\nenabled = false`
        : `[plugins."${id}"]\nenabled = "unknown"`);
    }
    await writeFile(tree.config, entries.join("\n\n"));

    const plan = await planCodexInventory(input(tree));
    const configured = plan.sources.filter(({ plugin }) =>
      plugin?.id.startsWith("configured-")
    );

    expect(new Set(configured.map(({ plugin }) => plugin?.id)).size).toBe(100);
    expect(configured.some(({ status }) => status === "disabled")).toBe(true);
    expect(configured.some(({ status }) => status === "ambiguous")).toBe(true);
    expect(configured.some(({ plugin }) =>
      plugin?.id === "configured-100@vendor"
    )).toBe(false);
    expect(plan.sources).toContainEqual(expect.objectContaining({
      status: "truncated",
      diagnostic: expect.objectContaining({ code: "CODEX_PLUGIN_LIMIT" })
    }));
  });

  it("marks a configured cache entry that is a file invalid", async () => {
    const tree = await createTree();
    const vendor = join(tree.cache, "vendor");
    await mkdir(vendor);
    await writeFile(join(vendor, "not-directory"), "not a plugin directory");
    await writeFile(
      tree.config,
      '[plugins."not-directory@vendor"]\nenabled = true\n'
    );

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) =>
      plugin?.id === "not-directory@vendor"
    )).toMatchObject({
      status: "invalid",
      diagnostic: { code: "CODEX_CACHE_ENTRY_NOT_DIRECTORY" }
    });
  });

  it("distinguishes contained missing roots from lexical and symlink escapes", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "missing", "1", { skills: "not-installed" }, []);
    await writeManifestPlugin(tree, "vendor", "parent", "1", { skills: "../outside" }, []);
    await writeManifestPlugin(tree, "vendor", "absolute", "1", { skills: resolve(tree.root, "outside") }, []);
    const linked = await writeManifestPlugin(tree, "vendor", "linked", "1", { skills: "linked" }, []);
    const outside = join(tree.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(linked, "linked"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      tree.config,
      ["missing", "parent", "absolute", "linked"]
        .map((name) => `[plugins."${name}@vendor"]\nenabled = true`)
        .join("\n\n")
    );

    const plan = await planCodexInventory(input(tree));
    const source = (id: string) => plan.sources.find(({ plugin }) => plugin?.id === id);

    expect(source("missing@vendor")).toMatchObject({
      status: "missing",
      diagnostic: { code: "COMPONENT_PATH_MISSING" }
    });
    expect(source("parent@vendor")).toMatchObject({
      status: "invalid",
      diagnostic: { code: "COMPONENT_PATH_ESCAPE" }
    });
    expect(source("absolute@vendor")).toMatchObject({
      status: "invalid",
      diagnostic: { code: "COMPONENT_PATH_ABSOLUTE" }
    });
    expect(source("linked@vendor")).toMatchObject({
      status: "invalid",
      diagnostic: { code: "COMPONENT_REALPATH_ESCAPE" }
    });
  });

  it("caps native plugins at 100 with explicit truncation evidence", async () => {
    const tree = await createTree();
    const config: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const name = `plugin-${String(index).padStart(3, "0")}`;
      await writeManifestPlugin(tree, "vendor", name, "1");
      config.push(`[plugins."${name}@vendor"]\nenabled = true`);
    }
    await writeFile(tree.config, config.join("\n\n"));

    const plan = await planCodexInventory(input(tree));
    const pluginSources = plan.sources.filter(({ plugin }) =>
      plugin?.id.endsWith("@vendor")
    );

    expect(new Set(pluginSources.map(({ plugin }) => plugin?.id)).size).toBe(100);
    expect(pluginSources.some(({ plugin }) => plugin?.id === "plugin-100@vendor")).toBe(false);
    expect(plan.sources).toContainEqual(expect.objectContaining({
      status: "truncated",
      diagnostic: expect.objectContaining({ code: "CODEX_PLUGIN_LIMIT" })
    }));
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "counts refused symlink entries toward the native plugin evidence cap",
    async () => {
      const tree = await createTree();
      const outside = join(tree.root, "outside-plugin");
      await mkdir(outside);
      const marketplace = join(tree.cache, "vendor");
      await mkdir(marketplace);
      for (let index = 0; index < 100; index += 1) {
        await symlink(
          outside,
          join(marketplace, `linked-${String(index).padStart(3, "0")}`),
          "dir"
        );
      }
      await writeFile(
        tree.config,
        '[plugins."configured-but-missing@vendor"]\nenabled = true\n'
      );

      const plan = await planCodexInventory(input(tree));
      const pluginIds = new Set(
        plan.sources.flatMap(({ plugin }) => plugin ? [plugin.id] : [])
      );

      expect(pluginIds.size).toBe(100);
      expect(plan.sources).toContainEqual(expect.objectContaining({
        status: "truncated",
        diagnostic: expect.objectContaining({ code: "CODEX_PLUGIN_LIMIT" })
      }));
    }
  );

  it("rejects a planned component replaced by a symlink or Windows junction", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(tree, "vendor", "swap", "1");
    await mkdir(join(pluginRoot, "skills", "before"));
    await writeFile(
      join(pluginRoot, "skills", "before", "SKILL.md"),
      "---\nname: before\ndescription: before\n---\n"
    );
    await writeFile(tree.config, '[plugins."swap@vendor"]\nenabled = true\n');
    const plan = await planCodexInventory(input(tree));
    const source = plan.sources.find(({ plugin }) => plugin?.id === "swap@vendor");
    const outside = join(tree.root, "outside-component");
    await mkdir(join(outside, "escaped"), { recursive: true });
    await writeFile(
      join(outside, "escaped", "SKILL.md"),
      "---\nname: escaped\ndescription: escaped\n---\n"
    );
    await rm(join(pluginRoot, "skills"), { recursive: true });
    await symlink(
      outside,
      join(pluginRoot, "skills"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const walked = await walkInventory(plan);
    const persisted = walked.sources.find(({ id }) => id === source?.id);

    expect(walked.candidates.flatMap(({ sourceIds }) => sourceIds))
      .not.toContain(source?.id);
    expect(persisted).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" },
      skillCount: 0
    });
    expect(inventorySourceSchema.safeParse(persisted).success).toBe(true);
    expect(persisted && "trustedContainment" in persisted).toBe(false);
  });

  it("rejects a planned component replaced by a different physical directory", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(tree, "vendor", "identity", "1");
    await writeFile(tree.config, '[plugins."identity@vendor"]\nenabled = true\n');
    const plan = await planCodexInventory(input(tree));
    const source = plan.sources.find(({ plugin }) => plugin?.id === "identity@vendor");
    await rm(join(pluginRoot, "skills"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "replacement"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "replacement", "SKILL.md"),
      "---\nname: replacement\ndescription: replacement\n---\n"
    );

    const walked = await walkInventory(plan);

    expect(walked.candidates.flatMap(({ sourceIds }) => sourceIds))
      .not.toContain(source?.id);
    expect(walked.sources.find(({ id }) => id === source?.id)).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" }
    });
  });

  it("rejects a planned Skill candidate replaced by an escaping symlink or junction", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(tree, "vendor", "candidate-swap", "1");
    const candidate = join(pluginRoot, "skills", "candidate");
    await mkdir(candidate);
    await writeFile(
      join(candidate, "SKILL.md"),
      "---\nname: candidate\ndescription: candidate\n---\n"
    );
    await writeFile(
      tree.config,
      '[plugins."candidate-swap@vendor"]\nenabled = true\n'
    );
    const plan = await planCodexInventory(input(tree));
    const source = plan.sources.find(({ plugin }) =>
      plugin?.id === "candidate-swap@vendor"
    );
    const outside = join(tree.root, "outside-candidate");
    await mkdir(outside);
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: escaped\n---\n"
    );
    await rm(candidate, { recursive: true });
    await symlink(
      outside,
      candidate,
      process.platform === "win32" ? "junction" : "dir"
    );

    const walked = await walkInventory(plan);

    expect(walked.candidates.flatMap(({ sourceIds }) => sourceIds))
      .not.toContain(source?.id);
    expect(walked.sources.find(({ id }) => id === source?.id)).toMatchObject({
      status: "invalid",
      diagnostic: { code: "INVENTORY_SOURCE_CONTAINMENT_CHANGED" }
    });
  });

  it("rejects a walked candidate replaced before parseSkill reopens it", async () => {
    const tree = await createTree();
    const pluginRoot = await writeManifestPlugin(tree, "vendor", "parse-swap", "1");
    const skill = join(pluginRoot, "skills", "candidate");
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: candidate\ndescription: candidate\n---\n"
    );
    await writeFile(tree.config, '[plugins."parse-swap@vendor"]\nenabled = true\n');
    const plan = await planCodexInventory(input(tree));
    const walked = await walkInventory(plan);
    const physicalSkill = await realpath(skill);
    const candidate = walked.candidates.find(({ path }) => path === physicalSkill);
    expect(candidate).toBeDefined();
    const parsed = await parseSkill(candidate!);
    expect("trustedProof" in parsed).toBe(false);

    const outside = join(tree.root, "outside-parse-candidate");
    await mkdir(outside);
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: escaped\n---\n"
    );
    await rm(skill, { recursive: true });
    await symlink(
      outside,
      skill,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(parseSkill(candidate!)).rejects.toMatchObject({
      code: "INVENTORY_CANDIDATE_CONTAINMENT_CHANGED"
    });
  });

  it("returns stable code-unit ordering and source IDs", async () => {
    const tree = await createTree();
    for (const name of ["zeta", "Alpha", "beta"]) {
      await writeManifestPlugin(tree, "vendor", name, "1");
    }
    await writeFile(
      tree.config,
      ["zeta", "Alpha", "beta"]
        .map((name) => `[plugins."${name}@vendor"]\nenabled = true`)
        .join("\n\n")
    );

    const first = await planCodexInventory(input(tree));
    const second = await planCodexInventory(input(tree));

    expect(first).toEqual(second);
    expect(first.sources.filter(({ plugin }) => plugin).map(({ plugin }) => plugin?.id))
      .toEqual(["Alpha@vendor", "beta@vendor", "zeta@vendor"]);
  });

  it("keeps source IDs unique when plugin and directory limits both fire", async () => {
    const tree = await createTree();
    await writeManifestPlugin(tree, "vendor", "a", "1");
    await writeManifestPlugin(tree, "vendor", "b", "1");
    await writeFile(
      tree.config,
      '[plugins."a@vendor"]\nenabled = true\n\n[plugins."b@vendor"]\nenabled = true\n'
    );

    const plan = await planCodexInventory({
      ...input(tree),
      limits: { maxPlugins: 1, maxDirectories: 3 }
    });
    const terminalCodes = plan.sources.flatMap(({ diagnostic }) =>
      diagnostic ? [diagnostic.code] : []
    );

    expect(terminalCodes).toContain("CODEX_PLUGIN_LIMIT");
    expect(terminalCodes).toContain("CODEX_DIRECTORY_LIMIT");
    expect(new Set(plan.sources.map(({ id }) => id)).size).toBe(plan.sources.length);
    expect(plan.bounds).toEqual({
      maxDepth: 24,
      maxDirectories: 0,
      maxSkills: 1_000
    });

    const directSkill = join(tree.cwd, ".agents", "skills", "direct");
    await mkdir(directSkill, { recursive: true });
    await writeFile(
      join(directSkill, "SKILL.md"),
      "---\nname: direct\ndescription: direct\n---\n"
    );
    const walked = await walkInventory(plan);
    expect(walked.candidates).toEqual([]);
    expect(walked.sources.find(({ path }) =>
      path === join(tree.cwd, ".agents", "skills")
    )).toMatchObject({
      status: "truncated",
      diagnostic: { code: "INVENTORY_DIRECTORY_LIMIT" }
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinked cache version directories",
    async () => {
      const tree = await createTree();
      const outside = join(tree.root, "outside-version");
      await mkdir(join(outside, ".codex-plugin"), { recursive: true });
      await mkdir(join(outside, "skills"));
      await writeFile(join(outside, ".codex-plugin", "plugin.json"), "{}");
      const pluginRoot = join(tree.cache, "vendor", "linked");
      await mkdir(pluginRoot, { recursive: true });
      await symlink(outside, join(pluginRoot, "1"), "dir");
      await writeFile(tree.config, '[plugins."linked@vendor"]\nenabled = true\n');

      const plan = await planCodexInventory(input(tree));
      const linked = plan.sources.find(({ plugin }) =>
        plugin?.id === "linked@vendor" && plugin.version === "1"
      );

      expect(linked).toMatchObject({
        status: "invalid",
        diagnostic: { code: "CODEX_CACHE_SYMLINK_REFUSED" }
      });
      expect(plan.sources.some(({ plugin, status }) =>
        plugin?.id === "linked@vendor" && status === "scanned"
      )).toBe(false);
      expect((await lstat(join(pluginRoot, "1"))).isSymbolicLink()).toBe(true);
    }
  );

  it("does not inspect marketplace checkouts and retains enabled cache misses", async () => {
    const tree = await createTree();
    const sourceCheckout = join(
      tree.codexHome,
      "plugins",
      "marketplaces",
      "vendor",
      "source-only",
      "1"
    );
    await mkdir(join(sourceCheckout, ".codex-plugin"), { recursive: true });
    await mkdir(join(sourceCheckout, "skills"));
    await writeFile(join(sourceCheckout, ".codex-plugin", "plugin.json"), "{}");
    await writeFile(tree.config, '[plugins."source-only@vendor"]\nenabled = true\n');

    const plan = await planCodexInventory(input(tree));

    expect(plan.sources.find(({ plugin }) => plugin?.id === "source-only@vendor"))
      .toMatchObject({
        path: join(tree.cache, "vendor", "source-only"),
        status: "missing",
        diagnostic: { code: "CODEX_PLUGIN_CACHE_MISSING" }
      });
    expect(plan.sources.some(({ path }) => path.startsWith(sourceCheckout))).toBe(false);
    expect(await realpath(tree.cache)).not.toBe(await realpath(sourceCheckout));
  });
});
