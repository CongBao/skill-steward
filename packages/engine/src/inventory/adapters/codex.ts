import { lstat, opendir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32
} from "node:path";
import { sha256 } from "../../fingerprint.js";
import {
  INVENTORY_SCAN_HARD_MAXIMA,
  sanitizeInventoryDiagnostic,
  validateInventoryBound,
  type InventoryDiagnostic,
  type InventoryPathIdentity,
  type InventoryPlan,
  type InventoryPlanSource
} from "../domain.js";
import { resolveContainedComponent } from "../manifest.js";
import { readJsonObject, readTomlObject } from "../metadata.js";
import {
  BoundedSmallestStrings,
  compareCodeUnits
} from "../selection.js";
import { workspaceAncestors } from "../workspace.js";

const CODEX_PLUGIN_HARD_MAX = 100;
const CODEX_PROFILE_HARD_MAX = 100;
const CODEX_PROFILE_NAME_MAX = 128;
const CODEX_REMOTE_PLUGIN_ID_MAX = 256;
const CODEX_PROFILE_NAME = /^[A-Za-z0-9_-]+$/u;
const CODEX_PROFILE_FILE = /^[A-Za-z0-9_-]+\.config\.toml$/u;

export interface CodexInventoryInput {
  home: string;
  cwd: string;
  codexHome?: string;
  configPath?: string;
  pluginCachePath?: string;
  adminSkillsPath?: string;
  activeProfile?: string;
  limits?: {
    maxPlugins?: number;
    maxProfiles?: number;
    maxDirectories?: number;
  };
}

interface ProfileAmbiguity {
  plugins: boolean;
  remotePlugin: boolean;
}

interface ConfigState {
  kind: "valid" | "missing" | "invalid";
  enablement: Map<string, boolean | undefined>;
  pluginsFeatureEnabled: boolean;
  remotePluginFeatureEnabled: boolean;
  profileAmbiguity?: ProfileAmbiguity;
}

interface ChildEntry {
  name: string;
  kind: "directory" | "symlink" | "other";
}

interface DirectoryListing {
  entries: ChildEntry[];
  truncated: boolean;
  error?: "invalid" | "unreadable";
}

interface EnumerationBudget {
  directoriesVisited: number;
  maxDirectories: number;
  truncated: boolean;
}

interface PluginDirectory {
  marketplace: string;
  plugin: string;
  path: string;
  remote: "local" | "remote" | "invalid";
}

interface FeatureOverrides {
  kind: "valid";
  plugins?: boolean;
  remotePlugin?: boolean;
}

interface ProfileListing {
  names: string[];
  truncated: boolean;
  error?: "unreadable";
}

interface VersionDisposition {
  status: InventoryPlanSource["status"];
  diagnostic?: InventoryDiagnostic;
  preserveMetadataErrors: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function diagnostic(code: string, message: string): InventoryDiagnostic {
  return sanitizeInventoryDiagnostic({ code, message });
}

function pathIdentity(metadata: {
  dev: number;
  ino: number;
  birthtimeMs: number;
}): InventoryPathIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    birthtimeMs: metadata.birthtimeMs
  };
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

async function verifiedDirectory(
  containmentRoot: string,
  path: string
): Promise<
  { path: string; identity: InventoryPathIdentity } |
  { error: "invalid" | "unreadable" }
> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return { error: "invalid" };
    }
    const physicalPath = await realpath(path);
    if (!isContained(containmentRoot, physicalPath)) return { error: "invalid" };
    return {
      path: physicalPath,
      identity: pathIdentity(metadata)
    };
  } catch {
    return { error: "unreadable" };
  }
}

function sourceId(kind: string, ...parts: string[]): string {
  return `codex:${kind}:${sha256(parts.join("\0")).slice("sha256:".length)}`;
}

function directSource(
  idKind: string,
  path: string,
  scope: "global" | "project",
  kind: "direct-root" | "inherited-root" | "admin-root",
  precedenceRank: number
): InventoryPlanSource {
  return {
    id: sourceId(idKind, resolve(path)),
    harness: "codex",
    scope,
    kind,
    path: resolve(path),
    layout: "children",
    ownership: "direct",
    precedenceRank,
    status: "scanned"
  };
}

function pluginSource(
  input: {
    pluginId?: string;
    version?: string;
    path: string;
    manifestPath?: string;
    declaredPath?: string;
    role?: string;
    inspectSkills?: boolean;
    trustedContainment?: InventoryPlanSource["trustedContainment"];
    status: InventoryPlanSource["status"];
    diagnostic?: InventoryDiagnostic;
  },
  precedenceRank: number
): InventoryPlanSource {
  const identity = input.pluginId ?? "cache";
  const role = input.role ?? (
    input.declaredPath !== undefined
      ? "component"
      : input.version !== undefined
        ? "version"
        : input.pluginId !== undefined
          ? "plugin"
          : "cache"
  );
  return {
    id: sourceId(
      "plugin",
      role,
      identity,
      input.version ?? "",
      input.declaredPath ?? "",
      resolve(input.path)
    ),
    harness: "codex",
    scope: "global",
    kind: "native-plugin",
    path: resolve(input.path),
    layout: "children",
    ownership: "native-plugin",
    ...(input.pluginId
      ? {
          plugin: {
            id: input.pluginId,
            ...(input.version ? { version: input.version } : {})
          }
        }
      : {}),
    ...(input.manifestPath ? { manifestPath: resolve(input.manifestPath) } : {}),
    ...(input.inspectSkills === true ? { inspectSkills: true } : {}),
    ...(input.trustedContainment
      ? { trustedContainment: input.trustedContainment }
      : {}),
    precedenceRank,
    status: input.status,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

const defaultFeatureState = {
  pluginsFeatureEnabled: true,
  remotePluginFeatureEnabled: true
};

function featureOverrides(
  metadata: Record<string, unknown>
): FeatureOverrides | { kind: "invalid" } {
  const features = metadata.features;
  if (features === undefined) return { kind: "valid" };
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return { kind: "invalid" };
  }
  const featureConfig = features as Record<string, unknown>;
  const plugins = featureConfig.plugins;
  const remotePlugin = featureConfig.remote_plugin;
  if (
    (plugins !== undefined && typeof plugins !== "boolean") ||
    (remotePlugin !== undefined && typeof remotePlugin !== "boolean")
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    ...(typeof plugins === "boolean" ? { plugins } : {}),
    ...(typeof remotePlugin === "boolean" ? { remotePlugin } : {})
  };
}

async function readConfig(path: string): Promise<ConfigState> {
  try {
    const metadata = await readTomlObject(path);
    const overrides = featureOverrides(metadata);
    if (overrides.kind === "invalid") {
      return { kind: "invalid", enablement: new Map(), ...defaultFeatureState };
    }
    const featureState = {
      pluginsFeatureEnabled: overrides.plugins ?? true,
      remotePluginFeatureEnabled: overrides.remotePlugin ?? true
    };
    const plugins = metadata.plugins;
    if (plugins === undefined) {
      return { kind: "valid", enablement: new Map(), ...featureState };
    }
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
      return { kind: "invalid", enablement: new Map(), ...defaultFeatureState };
    }

    const enablement = new Map<string, boolean | undefined>();
    for (const pluginId of Object.keys(plugins).sort(compareCodeUnits)) {
      const entry = (plugins as Record<string, unknown>)[pluginId];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        enablement.set(pluginId, undefined);
        continue;
      }
      const enabled = (entry as Record<string, unknown>).enabled;
      enablement.set(pluginId, typeof enabled === "boolean" ? enabled : undefined);
    }
    return { kind: "valid", enablement, ...featureState };
  } catch (error) {
    if (errorCode(error) === "METADATA_UNREADABLE") {
      try {
        await lstat(path);
      } catch (metadataError) {
        if (errorCode(metadataError) === "ENOENT") {
          return { kind: "missing", enablement: new Map(), ...defaultFeatureState };
        }
      }
    }
    return { kind: "invalid", enablement: new Map(), ...defaultFeatureState };
  }
}

async function profileRoot(
  codexHome: string
): Promise<
  { kind: "ready"; path: string } |
  { kind: "missing" | "invalid" | "unreadable" }
> {
  try {
    const metadata = await lstat(codexHome);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { kind: "invalid" };
    }
    return { kind: "ready", path: await realpath(codexHome) };
  } catch (error) {
    return { kind: errorCode(error) === "ENOENT" ? "missing" : "unreadable" };
  }
}

async function readProfileFeatures(
  physicalCodexHome: string,
  name: string
): Promise<FeatureOverrides | { kind: "invalid" }> {
  const path = join(physicalCodexHome, `${name}.config.toml`);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return { kind: "invalid" };
    }
    const physicalPath = await realpath(path);
    if (!isContained(physicalCodexHome, physicalPath)) {
      return { kind: "invalid" };
    }
    return featureOverrides(await readTomlObject(physicalPath, {
      expectedIdentity: pathIdentity(metadata)
    }));
  } catch {
    return { kind: "invalid" };
  }
}

async function listProfileNames(
  physicalCodexHome: string,
  excludedProfileFile: string | undefined,
  maxProfiles: number
): Promise<ProfileListing> {
  const selected = new BoundedSmallestStrings(maxProfiles);
  try {
    const directory = await opendir(physicalCodexHome);
    for await (const entry of directory) {
      if (!CODEX_PROFILE_FILE.test(entry.name)) continue;
      if (entry.name === excludedProfileFile) continue;
      selected.add(entry.name);
    }
  } catch {
    return { names: [], truncated: false, error: "unreadable" };
  }
  return { names: selected.values(), truncated: selected.truncated };
}

function withProfileAmbiguity(
  config: ConfigState,
  ambiguity: ProfileAmbiguity
): ConfigState {
  return {
    ...config,
    profileAmbiguity: ambiguity
  };
}

async function applyProfileFeatures(
  config: ConfigState,
  input: {
    codexHome: string;
    configPath: string;
    activeProfile?: string;
    maxProfiles: number;
  }
): Promise<ConfigState> {
  if (config.kind === "invalid") return config;
  const root = await profileRoot(input.codexHome);
  const relativeConfigPath = relative(
    resolve(input.codexHome),
    resolve(input.configPath)
  );
  const excludedProfileFile = (
    relativeConfigPath.split(sep).length === 1 &&
    CODEX_PROFILE_FILE.test(relativeConfigPath)
  )
    ? relativeConfigPath
    : undefined;
  if (input.activeProfile !== undefined) {
    if (
      input.activeProfile.length > CODEX_PROFILE_NAME_MAX ||
      !CODEX_PROFILE_NAME.test(input.activeProfile) ||
      root.kind !== "ready"
    ) {
      return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
    }
    if (`${input.activeProfile}.config.toml` === excludedProfileFile) {
      return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
    }
    const overrides = await readProfileFeatures(root.path, input.activeProfile);
    if (overrides.kind === "invalid") {
      return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
    }
    return {
      ...config,
      pluginsFeatureEnabled: overrides.plugins ?? config.pluginsFeatureEnabled,
      remotePluginFeatureEnabled:
        overrides.remotePlugin ?? config.remotePluginFeatureEnabled
    };
  }

  if (root.kind === "missing") return config;
  if (root.kind !== "ready") {
    return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
  }
  const listing = await listProfileNames(
    root.path,
    excludedProfileFile,
    input.maxProfiles
  );
  if (listing.error || listing.truncated) {
    return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
  }

  const ambiguity: ProfileAmbiguity = { plugins: false, remotePlugin: false };
  for (const fileName of listing.names) {
    const profileName = fileName.slice(0, -".config.toml".length);
    const overrides = await readProfileFeatures(root.path, profileName);
    if (overrides.kind === "invalid") {
      return withProfileAmbiguity(config, { plugins: true, remotePlugin: true });
    }
    if (
      overrides.plugins !== undefined &&
      overrides.plugins !== config.pluginsFeatureEnabled
    ) {
      ambiguity.plugins = true;
    }
    if (
      overrides.remotePlugin !== undefined &&
      overrides.remotePlugin !== config.remotePluginFeatureEnabled
    ) {
      ambiguity.remotePlugin = true;
    }
  }
  return ambiguity.plugins || ambiguity.remotePlugin
    ? withProfileAmbiguity(config, ambiguity)
    : config;
}

async function listChildren(
  path: string,
  capacity: number,
  budget: EnumerationBudget,
  marksDirectoryLimit: boolean,
  containmentRoot: string,
  ignoreCodexVersionMetadata = false
): Promise<DirectoryListing> {
  if (
    capacity < 0 ||
    budget.directoriesVisited >= budget.maxDirectories
  ) {
    budget.truncated = true;
    return { entries: [], truncated: true };
  }

  const verified = await verifiedDirectory(containmentRoot, path);
  if ("error" in verified) {
    return { entries: [], truncated: false, error: verified.error };
  }
  budget.directoriesVisited += 1;
  const selected = new BoundedSmallestStrings(capacity);
  try {
    const directory = await opendir(verified.path);
    for await (const entry of directory) {
      if (
        ignoreCodexVersionMetadata &&
        await isCodexVersionRootMetadata(verified.path, entry.name)
      ) {
        continue;
      }
      selected.add(entry.name);
    }
  } catch {
    return { entries: [], truncated: false, error: "unreadable" };
  }

  const entries: ChildEntry[] = [];
  for (const name of selected.values()) {
    try {
      const metadata = await lstat(join(verified.path, name));
      entries.push({
        name,
        kind: metadata.isSymbolicLink()
          ? "symlink"
          : metadata.isDirectory()
            ? "directory"
            : "other"
      });
    } catch {
      entries.push({ name, kind: "other" });
    }
  }
  if (selected.truncated && marksDirectoryLimit) budget.truncated = true;
  return {
    entries,
    truncated: selected.truncated,
  };
}

function disabledConfigStatus(
  config: ConfigState,
  pluginId: string,
  remote: PluginDirectory["remote"]
): Pick<InventoryPlanSource, "status" | "diagnostic"> | undefined {
  if (config.kind !== "valid") return undefined;
  if (config.enablement.get(pluginId) === false) {
    return {
      status: "disabled",
      diagnostic: diagnostic(
        "CODEX_PLUGIN_DISABLED",
        "Codex plugin is disabled in config.toml"
      )
    };
  }
  if (config.profileAmbiguity?.plugins) return undefined;
  if (!config.pluginsFeatureEnabled) {
    return {
      status: "disabled",
      diagnostic: diagnostic(
        "CODEX_PLUGINS_FEATURE_DISABLED",
        "Codex plugin support is disabled in config.toml"
      )
    };
  }
  if (remote === "remote" && config.profileAmbiguity?.remotePlugin) {
    return undefined;
  }
  if (remote === "remote" && !config.remotePluginFeatureEnabled) {
    return {
      status: "disabled",
      diagnostic: diagnostic(
        "CODEX_REMOTE_PLUGIN_FEATURE_DISABLED",
        "Codex remote plugin support is disabled in config.toml"
      )
    };
  }
  return undefined;
}

function uncertainConfigStatus(
  config: ConfigState,
  remote: PluginDirectory["remote"]
): Pick<InventoryPlanSource, "status" | "diagnostic"> | undefined {
  if (
    config.profileAmbiguity?.plugins ||
    (remote === "remote" && config.profileAmbiguity?.remotePlugin)
  ) {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CODEX_PROFILE_SELECTION_UNKNOWN",
        "Codex profile selection can change plugin feature state"
      )
    };
  }
  if (remote === "invalid") {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CODEX_REMOTE_PLUGIN_MARKER_INVALID",
        "Codex remote plugin marker is invalid"
      )
    };
  }
  return undefined;
}

function configStatus(
  config: ConfigState,
  pluginId: string,
  plausibleVersions: number,
  remote: PluginDirectory["remote"]
): Pick<InventoryPlanSource, "status" | "diagnostic"> {
  const enabled = config.enablement.get(pluginId);
  const disabled = disabledConfigStatus(config, pluginId, remote);
  if (disabled) return disabled;
  const uncertain = uncertainConfigStatus(config, remote);
  if (uncertain) return uncertain;
  if (plausibleVersions !== 1) {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CODEX_PLUGIN_VERSION_AMBIGUOUS",
        "Codex plugin has multiple plausible cached versions"
      )
    };
  }
  if (config.kind === "invalid") {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CODEX_CONFIG_INVALID",
        "Codex plugin enablement is ambiguous because config.toml is invalid"
      )
    };
  }
  if (config.enablement.has(pluginId) && enabled === undefined) {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CODEX_PLUGIN_ENABLEMENT_UNKNOWN",
        "Codex plugin enablement is not a known boolean in config.toml"
      )
    };
  }
  return { status: "scanned" };
}

async function isCodexVersionRootMetadata(
  rootPath: string,
  name: string
): Promise<boolean> {
  if (name !== ".codex-remote-plugin-install.json" && name !== "latest") {
    return false;
  }
  try {
    const metadata = await lstat(join(rootPath, name));
    return name === ".codex-remote-plugin-install.json"
      ? metadata.isFile()
      : metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function remotePluginState(
  rootPath: string
): Promise<PluginDirectory["remote"]> {
  const markerPath = join(rootPath, ".codex-remote-plugin-install.json");
  let metadata;
  try {
    metadata = await lstat(markerPath);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "local" : "invalid";
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return "local";
  try {
    const marker = await readJsonObject(markerPath, {
      expectedIdentity: pathIdentity(metadata)
    });
    const remotePluginId = marker.remote_plugin_id;
    return marker.schema_version === 1 &&
      typeof remotePluginId === "string" &&
      remotePluginId.trim().length > 0 &&
      remotePluginId.length <= CODEX_REMOTE_PLUGIN_ID_MAX
      ? "remote"
      : "invalid";
  } catch {
    return "invalid";
  }
}

function manifestSkillPaths(manifest: Record<string, unknown>): string[] | undefined {
  const declared = manifest.skills;
  if (declared === undefined) return ["skills"];
  if (typeof declared === "string") {
    return declared.trim() === "" ? undefined : [declared];
  }
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    declared.some((path) => typeof path !== "string" || path.trim() === "")
  ) {
    return undefined;
  }
  return [...new Set(declared as string[])].sort(compareCodeUnits);
}

function relativeComponentDepth(path: string): number | undefined {
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return undefined;
  return path.split(/[\\/]+/u).filter((component) =>
    component.length > 0 && component !== "."
  ).length;
}

function metadataTerminal(
  disposition: VersionDisposition,
  status: InventoryPlanSource["status"],
  terminalDiagnostic: InventoryDiagnostic
): Pick<InventoryPlanSource, "status" | "diagnostic"> {
  if (disposition.preserveMetadataErrors) {
    return {
      status: disposition.status,
      diagnostic: terminalDiagnostic
    };
  }
  return { status, diagnostic: terminalDiagnostic };
}

async function manifestSources(
  directory: PluginDirectory,
  version: string,
  cacheRoot: string,
  disposition: VersionDisposition,
  budget: EnumerationBudget,
  nextRank: () => number
): Promise<InventoryPlanSource[]> {
  const pluginId = `${directory.plugin}@${directory.marketplace}`;
  const plannedPluginRoot = join(directory.path, version);
  const verifiedPluginRoot = await verifiedDirectory(cacheRoot, plannedPluginRoot);
  if ("error" in verifiedPluginRoot) {
    const terminalDiagnostic = diagnostic(
      verifiedPluginRoot.error === "invalid"
        ? "CODEX_CACHE_SYMLINK_REFUSED"
        : "CODEX_CACHE_UNREADABLE",
      "Codex plugin version directory changed before manifest inspection"
    );
    return [pluginSource({
      pluginId,
      version,
      path: plannedPluginRoot,
      ...metadataTerminal(
        disposition,
        verifiedPluginRoot.error === "invalid" ? "invalid" : "unreadable",
        terminalDiagnostic
      )
    }, nextRank())];
  }
  const pluginRoot = verifiedPluginRoot.path;
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  let readableManifestPath: string;
  try {
    readableManifestPath = await resolveContainedComponent(
      pluginRoot,
      ".codex-plugin/plugin.json"
    );
  } catch (error) {
    const code = errorCode(error);
    const terminalDiagnostic = code === "COMPONENT_PATH_MISSING"
      ? diagnostic(
          "CODEX_PLUGIN_MANIFEST_MISSING",
          "Codex plugin manifest is missing"
        )
      : diagnostic(
          code ?? "CODEX_PLUGIN_MANIFEST_INVALID",
          "Codex plugin manifest path is invalid"
        );
    return [pluginSource({
      pluginId,
      version,
      path: pluginRoot,
      manifestPath,
      ...metadataTerminal(disposition, "invalid", terminalDiagnostic)
    }, nextRank())];
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = await readJsonObject(readableManifestPath);
  } catch (error) {
    const terminalDiagnostic = diagnostic(
      errorCode(error) ?? "CODEX_PLUGIN_MANIFEST_INVALID",
      "Codex plugin manifest is invalid"
    );
    return [pluginSource({
      pluginId,
      version,
      path: pluginRoot,
      manifestPath,
      ...metadataTerminal(disposition, "invalid", terminalDiagnostic)
    }, nextRank())];
  }

  const declaredPaths = manifestSkillPaths(manifest);
  if (!declaredPaths) {
    const terminalDiagnostic = diagnostic(
      "CODEX_MANIFEST_SKILLS_INVALID",
      "Codex plugin manifest skills must be a non-empty relative string or string array"
    );
    return [pluginSource({
      pluginId,
      version,
      path: pluginRoot,
      manifestPath,
      ...metadataTerminal(disposition, "invalid", terminalDiagnostic)
    }, nextRank())];
  }

  const remainingComponents = Math.max(
    0,
    budget.maxDirectories - budget.directoriesVisited
  );
  const selectedPaths = declaredPaths.slice(0, remainingComponents);
  const componentsTruncated = selectedPaths.length < declaredPaths.length;
  if (componentsTruncated) budget.truncated = true;

  const sources: InventoryPlanSource[] = [];
  for (const declaredPath of selectedPaths) {
    budget.directoriesVisited += 1;
    const componentDepth = relativeComponentDepth(declaredPath);
    if (
      componentDepth !== undefined &&
      componentDepth > INVENTORY_SCAN_HARD_MAXIMA.maxDepth
    ) {
      sources.push(pluginSource({
        role: "component-depth-limit",
        pluginId,
        version,
        path: pluginRoot,
        manifestPath,
        declaredPath,
        status: "truncated",
        diagnostic: diagnostic(
          "CODEX_COMPONENT_DEPTH_LIMIT",
          "Codex plugin component path exceeds the depth limit"
        )
      }, nextRank()));
      continue;
    }
    try {
      const componentPath = await resolveContainedComponent(pluginRoot, declaredPath);
      const componentMetadata = await lstat(componentPath);
      if (!componentMetadata.isDirectory()) {
        const terminalDiagnostic = diagnostic(
          "CODEX_COMPONENT_NOT_DIRECTORY",
          "Codex plugin Skill root is not a directory"
        );
        sources.push(pluginSource({
          pluginId,
          version,
          path: componentPath,
          manifestPath,
          declaredPath,
          ...metadataTerminal(disposition, "invalid", terminalDiagnostic)
        }, nextRank()));
        continue;
      }
      sources.push(pluginSource({
        pluginId,
        version,
        path: componentPath,
        manifestPath,
        declaredPath,
        status: disposition.status,
        ...(disposition.diagnostic
          ? { diagnostic: disposition.diagnostic }
          : {}),
        inspectSkills: disposition.status !== "scanned",
        trustedContainment: {
          rootPath: pluginRoot,
          rootIdentity: verifiedPluginRoot.identity,
          sourcePath: componentPath,
          sourceIdentity: {
            device: componentMetadata.dev,
            inode: componentMetadata.ino,
            birthtimeMs: componentMetadata.birthtimeMs
          }
        }
      }, nextRank()));
    } catch (error) {
      const code = errorCode(error) ?? "CODEX_PLUGIN_COMPONENT_INVALID";
      const terminalDiagnostic = diagnostic(
        code,
        code === "COMPONENT_PATH_MISSING"
          ? "Codex plugin Skill root is missing"
          : "Codex plugin Skill root leaves the plugin directory"
      );
      sources.push(pluginSource({
        pluginId,
        version,
        path: code === "COMPONENT_PATH_MISSING"
          ? join(pluginRoot, declaredPath)
          : pluginRoot,
        manifestPath,
        declaredPath,
        ...metadataTerminal(
          disposition,
          code === "COMPONENT_PATH_MISSING" ? "missing" : "invalid",
          terminalDiagnostic
        )
      }, nextRank()));
    }
  }
  if (componentsTruncated) {
    sources.push(pluginSource({
      role: "component-limit",
      pluginId,
      version,
      path: pluginRoot,
      manifestPath,
      status: "truncated",
      diagnostic: diagnostic(
        "CODEX_DIRECTORY_LIMIT",
        "Codex plugin manifest component roots exceeded the residual directory limit"
      )
    }, nextRank()));
  }
  return sources;
}

function configuredPluginLocation(
  pluginCachePath: string,
  pluginId: string
): string | undefined {
  const separator = pluginId.lastIndexOf("@");
  if (separator <= 0 || separator === pluginId.length - 1) return undefined;
  const plugin = pluginId.slice(0, separator);
  const marketplace = pluginId.slice(separator + 1);
  if (!isPortableFilenameSegment(plugin) || !isPortableFilenameSegment(marketplace)) {
    return undefined;
  }
  const cacheRoot = resolve(pluginCachePath);
  const expectedPath = resolve(cacheRoot, marketplace, plugin);
  const relativePath = relative(cacheRoot, expectedPath);
  const components = relativePath.split(sep);
  return isContained(cacheRoot, expectedPath) &&
    components.length === 2 &&
    components[0] === marketplace &&
    components[1] === plugin
    ? expectedPath
    : undefined;
}

const windowsReservedDevice = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu;

function isPortableFilenameSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    posix.basename(segment) === segment &&
    win32.basename(segment) === segment &&
    posix.parse(segment).root === "" &&
    win32.parse(segment).root === "" &&
    !/[<>:"/\\|?*\u0000-\u001f]/u.test(segment) &&
    !/[ .]$/u.test(segment) &&
    !windowsReservedDevice.test(segment);
}

export async function planCodexInventory(
  input: CodexInventoryInput
): Promise<InventoryPlan> {
  const home = resolve(input.home);
  const cwd = resolve(input.cwd);
  const codexHome = resolve(input.codexHome ?? join(home, ".codex"));
  const configPath = resolve(input.configPath ?? join(codexHome, "config.toml"));
  const pluginCachePath = resolve(
    input.pluginCachePath ?? join(codexHome, "plugins", "cache")
  );
  const adminSkillsPath = resolve(input.adminSkillsPath ?? "/etc/codex/skills");
  const maxPlugins = input.limits?.maxPlugins ?? CODEX_PLUGIN_HARD_MAX;
  const maxProfiles = input.limits?.maxProfiles ?? CODEX_PROFILE_HARD_MAX;
  const maxDirectories = input.limits?.maxDirectories ??
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories;
  validateInventoryBound(maxPlugins, "Codex limits.maxPlugins", CODEX_PLUGIN_HARD_MAX);
  validateInventoryBound(
    maxProfiles,
    "Codex limits.maxProfiles",
    CODEX_PROFILE_HARD_MAX
  );
  validateInventoryBound(
    maxDirectories,
    "Codex limits.maxDirectories",
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );
  const ancestors = await workspaceAncestors(cwd);
  const sources: InventoryPlanSource[] = ancestors.map((ancestor, index) =>
    directSource(
      index === 0 ? "project" : "inherited",
      join(ancestor, ".agents", "skills"),
      "project",
      index === 0 ? "direct-root" : "inherited-root",
      index
    )
  );
  sources.push(directSource(
    "user",
    join(home, ".agents", "skills"),
    "global",
    "direct-root",
    sources.length
  ));
  sources.push(directSource(
    "admin",
    adminSkillsPath,
    "global",
    "admin-root",
    sources.length
  ));

  let rank = sources.length;
  const nextRank = () => rank++;
  const config = await applyProfileFeatures(
    await readConfig(configPath),
    {
      codexHome,
      configPath,
      ...(input.activeProfile !== undefined
        ? { activeProfile: input.activeProfile }
        : {}),
      maxProfiles
    }
  );
  if (config.kind === "invalid") {
    sources.push(pluginSource({
      role: "config",
      path: configPath,
      status: "invalid",
      diagnostic: diagnostic(
        "CODEX_CONFIG_INVALID",
        "Codex config.toml cannot provide trustworthy plugin enablement"
      )
    }, nextRank()));
  }
  const budget: EnumerationBudget = {
    directoriesVisited: 0,
    maxDirectories,
    truncated: false
  };
  const discoveredPluginIds = new Set<string>();
  let pluginLimitReached = false;

  let cacheMetadata;
  let physicalCachePath: string | undefined;
  try {
    cacheMetadata = await lstat(pluginCachePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      sources.push(pluginSource({
        role: "cache",
        path: pluginCachePath,
        status: "missing",
        diagnostic: diagnostic(
          "CODEX_CACHE_MISSING",
          "Codex plugin cache is missing"
        )
      }, nextRank()));
    } else {
      sources.push(pluginSource({
        role: "cache",
        path: pluginCachePath,
        status: "unreadable",
        diagnostic: diagnostic(
          "CODEX_CACHE_UNREADABLE",
          "Codex plugin cache cannot be inspected"
        )
      }, nextRank()));
    }
    cacheMetadata = undefined;
  }

  if (cacheMetadata?.isSymbolicLink()) {
    sources.push(pluginSource({
      role: "cache",
      path: pluginCachePath,
      status: "invalid",
      diagnostic: diagnostic(
        "CODEX_CACHE_SYMLINK_REFUSED",
        "Codex plugin cache symlinks are not inspected"
      )
    }, nextRank()));
  } else if (cacheMetadata && !cacheMetadata.isDirectory()) {
    sources.push(pluginSource({
      role: "cache",
      path: pluginCachePath,
      status: "invalid",
      diagnostic: diagnostic(
        "CODEX_CACHE_INVALID",
        "Codex plugin cache is not a directory"
      )
    }, nextRank()));
  } else if (cacheMetadata?.isDirectory()) {
    try {
      physicalCachePath = await realpath(pluginCachePath);
    } catch {
      sources.push(pluginSource({
        role: "cache",
        path: pluginCachePath,
        status: "unreadable",
        diagnostic: diagnostic(
          "CODEX_CACHE_UNREADABLE",
          "Codex plugin cache cannot be resolved"
        )
      }, nextRank()));
    }
  }

  if (physicalCachePath) {
    const marketplaces = await listChildren(
      physicalCachePath,
      Math.max(0, maxDirectories - 1),
      budget,
      true,
      physicalCachePath
    );
    if (marketplaces.error) {
      sources.push(pluginSource({
        role: "cache",
        path: pluginCachePath,
        status: marketplaces.error === "invalid" ? "invalid" : "unreadable",
        diagnostic: diagnostic(
          "CODEX_CACHE_UNREADABLE",
          "Codex plugin cache cannot be listed"
        )
      }, nextRank()));
    } else {
      const pluginDirectories: PluginDirectory[] = [];
      for (const marketplace of marketplaces.entries) {
        const marketplacePath = join(physicalCachePath, marketplace.name);
        if (marketplace.kind !== "directory") {
          sources.push(pluginSource({
            role: "marketplace-entry",
            path: marketplacePath,
            status: "invalid",
            diagnostic: diagnostic(
              marketplace.kind === "symlink"
                ? "CODEX_CACHE_SYMLINK_REFUSED"
                : "CODEX_CACHE_ENTRY_NOT_DIRECTORY",
              "Codex marketplace cache entry is not a physical directory"
            )
          }, nextRank()));
          continue;
        }
        const remaining = maxPlugins - discoveredPluginIds.size;
        const plugins = await listChildren(
          marketplacePath,
          Math.max(0, remaining + 1),
          budget,
          false,
          physicalCachePath
        );
        if (plugins.error) {
          sources.push(pluginSource({
            path: marketplacePath,
            status: plugins.error === "invalid" ? "invalid" : "unreadable",
            diagnostic: diagnostic(
              "CODEX_CACHE_UNREADABLE",
              "Codex marketplace cache cannot be listed"
            )
          }, nextRank()));
          continue;
        }
        for (const plugin of plugins.entries) {
          const pluginId = `${plugin.name}@${marketplace.name}`;
          const pluginPath = join(marketplacePath, plugin.name);
          if (discoveredPluginIds.size >= maxPlugins) {
            pluginLimitReached = true;
            break;
          }
          discoveredPluginIds.add(pluginId);
          if (plugin.kind !== "directory") {
            sources.push(pluginSource({
              role: "plugin-entry",
              pluginId,
              path: pluginPath,
              status: "invalid",
              diagnostic: diagnostic(
                plugin.kind === "symlink"
                  ? "CODEX_CACHE_SYMLINK_REFUSED"
                  : "CODEX_CACHE_ENTRY_NOT_DIRECTORY",
                "Codex plugin cache entry is not a physical directory"
              )
            }, nextRank()));
            continue;
          }
          pluginDirectories.push({
            marketplace: marketplace.name,
            plugin: plugin.name,
            path: pluginPath,
            remote: await remotePluginState(pluginPath)
          });
        }
        if (
          pluginLimitReached ||
          (plugins.truncated && plugins.entries.length >= remaining + 1)
        ) {
          pluginLimitReached = true;
          break;
        }
      }

      for (const directory of pluginDirectories) {
        const pluginId = `${directory.plugin}@${directory.marketplace}`;
        const remainingDirectories = Math.max(
          0,
          maxDirectories -
            budget.directoriesVisited -
            1
        );
        const versions = await listChildren(
          directory.path,
          remainingDirectories,
          budget,
          true,
          physicalCachePath,
          true
        );
        if (versions.error) {
          sources.push(pluginSource({
            pluginId,
            path: directory.path,
            status: versions.error === "invalid" ? "invalid" : "unreadable",
            diagnostic: diagnostic(
              "CODEX_CACHE_UNREADABLE",
              "Codex plugin version cache cannot be listed"
            )
          }, nextRank()));
          continue;
        }
        const plausibleVersions = versions.entries.filter(({ kind }) =>
          kind === "directory"
        );
        for (const version of versions.entries) {
          const versionPath = join(directory.path, version.name);
          if (version.kind !== "directory") {
            sources.push(pluginSource({
              role: "version-entry",
              pluginId,
              version: version.name,
              path: versionPath,
              status: "invalid",
              diagnostic: diagnostic(
                version.kind === "symlink"
                  ? "CODEX_CACHE_SYMLINK_REFUSED"
                  : "CODEX_CACHE_ENTRY_NOT_DIRECTORY",
                "Codex plugin version cache entry is not a physical directory"
              )
            }, nextRank()));
            continue;
          }
          if (
            budget.directoriesVisited >=
              maxDirectories
          ) {
            budget.truncated = true;
            sources.push(pluginSource({
              role: "version-directory-limit",
              pluginId,
              version: version.name,
              path: versionPath,
              status: "truncated",
              diagnostic: diagnostic(
                "CODEX_DIRECTORY_LIMIT",
                "Codex plugin version was not inspected after the directory limit"
              )
            }, nextRank()));
            continue;
          }
          budget.directoriesVisited += 1;
          let disposition: VersionDisposition;
          const disabled = disabledConfigStatus(
            config,
            pluginId,
            directory.remote
          );
          const uncertain = uncertainConfigStatus(config, directory.remote);
          if (disabled) {
            disposition = {
              status: disabled.status,
              ...(disabled.diagnostic ? { diagnostic: disabled.diagnostic } : {}),
              preserveMetadataErrors: true
            };
          } else if (uncertain) {
            disposition = {
              status: uncertain.status,
              ...(uncertain.diagnostic ? { diagnostic: uncertain.diagnostic } : {}),
              preserveMetadataErrors: true
            };
          } else if (versions.truncated) {
            disposition = {
              status: "truncated",
              diagnostic: diagnostic(
                "CODEX_DIRECTORY_LIMIT",
                "Codex plugin version inventory reached the directory limit"
              ),
              preserveMetadataErrors: true
            };
          } else if (plausibleVersions.length !== 1) {
            disposition = {
              status: "ambiguous",
              diagnostic: diagnostic(
                "CODEX_PLUGIN_VERSION_AMBIGUOUS",
                "Codex plugin has multiple plausible cached versions"
              ),
              preserveMetadataErrors: true
            };
          } else {
            const configured = configStatus(
              config,
              pluginId,
              1,
              directory.remote
            );
            disposition = {
              status: configured.status,
              ...(configured.diagnostic
                ? { diagnostic: configured.diagnostic }
                : {}),
              preserveMetadataErrors: configured.status === "disabled"
            };
          }
          sources.push(...await manifestSources(
            directory,
            version.name,
            physicalCachePath,
            disposition,
            budget,
            nextRank
          ));
        }
        if (plausibleVersions.length === 0) {
          sources.push(pluginSource({
            pluginId,
            path: directory.path,
            status: versions.truncated ? "truncated" : "missing",
            diagnostic: diagnostic(
              versions.truncated
                ? "CODEX_DIRECTORY_LIMIT"
                : "CODEX_PLUGIN_VERSION_MISSING",
              versions.truncated
                ? "Codex plugin version inventory reached the directory limit"
                : "Codex plugin cache has no physical version directory"
            )
          }, nextRank()));
        }
        if (versions.truncated) budget.truncated = true;
      }
    }
  }

  for (const [pluginId, enabled] of [...config.enablement.entries()].sort(
    ([left], [right]) => compareCodeUnits(left, right)
  )) {
    if (discoveredPluginIds.has(pluginId)) continue;
    if (discoveredPluginIds.size >= maxPlugins) {
      pluginLimitReached = true;
      break;
    }
    discoveredPluginIds.add(pluginId);
    const expectedPath = configuredPluginLocation(pluginCachePath, pluginId);
    const physicalExpectedPath = physicalCachePath
      ? configuredPluginLocation(physicalCachePath, pluginId)
      : undefined;
    if (!expectedPath || (physicalCachePath && !physicalExpectedPath)) {
      sources.push(pluginSource({
        role: "configured-plugin",
        pluginId,
        path: pluginCachePath,
        status: "invalid",
        diagnostic: diagnostic(
          "CODEX_CONFIG_PLUGIN_ID_INVALID",
          "Configured Codex plugin ID cannot map to a contained cache path"
        )
      }, nextRank()));
      continue;
    }

    if (physicalExpectedPath) {
      if (
        budget.truncated ||
        budget.directoriesVisited >= budget.maxDirectories
      ) {
        budget.truncated = true;
        sources.push(pluginSource({
          role: "configured-plugin",
          pluginId,
          path: expectedPath,
          status: "truncated",
          diagnostic: diagnostic(
            "CODEX_DIRECTORY_LIMIT",
            "Configured Codex plugin cache entry was not inspected after the directory limit"
          )
        }, nextRank()));
        continue;
      }
      try {
        const metadata = await lstat(physicalExpectedPath);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          sources.push(pluginSource({
            role: "configured-plugin",
            pluginId,
            path: expectedPath,
            status: "invalid",
            diagnostic: diagnostic(
              metadata.isSymbolicLink()
                ? "CODEX_CACHE_SYMLINK_REFUSED"
                : "CODEX_CACHE_ENTRY_NOT_DIRECTORY",
              "Configured Codex plugin cache entry is not a physical directory"
            )
          }, nextRank()));
          continue;
        }
        budget.directoriesVisited += 1;
        sources.push(pluginSource({
          role: "configured-plugin",
          pluginId,
          path: expectedPath,
          status: "truncated",
          diagnostic: diagnostic(
            "CODEX_PLUGIN_NOT_ENUMERATED",
            "Configured Codex plugin directory was not reached by bounded enumeration"
          )
        }, nextRank()));
        continue;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          sources.push(pluginSource({
            role: "configured-plugin",
            pluginId,
            path: expectedPath,
            status: "unreadable",
            diagnostic: diagnostic(
              "CODEX_CACHE_UNREADABLE",
              "Configured Codex plugin cache entry cannot be inspected"
            )
          }, nextRank()));
          continue;
        }
      }
    }

    const configuredStatus = enabled === true
      ? {
          status: "missing" as const,
          diagnostic: diagnostic(
            "CODEX_PLUGIN_CACHE_MISSING",
            "Enabled Codex plugin is missing from the local cache"
          )
        }
      : enabled === false
        ? {
            status: "disabled" as const,
            diagnostic: diagnostic(
              "CODEX_PLUGIN_DISABLED",
              "Configured Codex plugin is disabled"
            )
          }
        : {
            status: "ambiguous" as const,
            diagnostic: diagnostic(
              "CODEX_PLUGIN_ENABLEMENT_UNKNOWN",
              "Configured Codex plugin enablement is not a known boolean"
            )
          };
    sources.push(pluginSource({
      role: "configured-plugin",
      pluginId,
      path: expectedPath,
      ...configuredStatus
    }, nextRank()));
  }

  if (pluginLimitReached) {
    sources.push(pluginSource({
      role: "plugin-limit",
      path: pluginCachePath,
      status: "truncated",
      diagnostic: diagnostic(
        "CODEX_PLUGIN_LIMIT",
        "Codex native plugin inventory exceeded the configured plugin limit"
      )
    }, nextRank()));
  }
  if (budget.truncated) {
    sources.push(pluginSource({
      role: "directory-limit",
      path: pluginCachePath,
      status: "truncated",
      diagnostic: diagnostic(
        "CODEX_DIRECTORY_LIMIT",
        "Codex plugin inventory reached the configured directory limit"
      )
    }, nextRank()));
  }

  return {
    sources,
    bounds: {
      maxDepth: INVENTORY_SCAN_HARD_MAXIMA.maxDepth,
      maxDirectories: Math.max(0, maxDirectories - budget.directoriesVisited),
      maxSkills: INVENTORY_SCAN_HARD_MAXIMA.maxSkills
    }
  };
}
