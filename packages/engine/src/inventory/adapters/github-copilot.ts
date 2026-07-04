import { lstat, opendir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
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
import { MAX_METADATA_BYTES, readJsonObject } from "../metadata.js";
import { BoundedSmallestStrings, compareCodeUnits } from "../selection.js";
import { workspaceAncestors } from "../workspace.js";
import {
  readCopilotManagedState,
  readCopilotSettings,
  resolveCopilotDisabledSkills,
  resolveCopilotEnabledPlugin,
  type CopilotManagedState,
  type CopilotSettingsState,
  type CopilotSettingsTier
} from "./github-copilot-metadata.js";

const COPILOT_PLUGIN_HARD_MAX = 100;
const COPILOT_CUSTOM_ROOT_HARD_MAX = 1_000;
const manifestLocations = [
  ".plugin/plugin.json",
  "plugin.json",
  ".github/plugin/plugin.json",
  ".claude-plugin/plugin.json"
] as const;

export interface GitHubCopilotInventoryInput {
  home: string;
  cwd: string;
  copilotHome?: string;
  installedPluginsPath?: string;
  configPath?: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
  localSettingsPath?: string;
  sharedProjectSettingsPath?: string;
  sharedLocalSettingsPath?: string;
  /** Explicit, bounded injection of COPILOT_SKILLS_DIRS. */
  copilotSkillsDirs?: string;
  limits?: {
    maxPlugins?: number;
    maxDirectories?: number;
  };
}

interface GitHubCopilotInventoryHooks {
  beforeManifestRead?(path: string): Promise<void> | void;
  afterPluginDiscovery?(paths: string[]): Promise<void> | void;
}

interface EnumerationBudget {
  directoriesVisited: number;
  maxDirectories: number;
  truncated: boolean;
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

interface PluginIdentity {
  key: string;
  id: string;
  origin: "marketplace" | "direct" | "configured" | "container";
  marketplace?: string;
  plugin?: string;
  aliasPath?: string;
  entryKind?: ChildEntry["kind"];
}

interface VerifiedDirectory {
  path: string;
  identity: InventoryPathIdentity;
}

type ManifestInspection =
  | {
      kind: "valid";
      manifestPath: string;
      name: string;
      paths: string[];
      extension?: CopilotExtensionInspection;
    }
  | {
      kind: "invalid";
      manifestPath: string;
      status: "missing" | "invalid" | "unreadable" | "truncated";
      diagnostic: InventoryDiagnostic;
    };

interface Disposition {
  status: InventoryPlanSource["status"];
  diagnostic?: InventoryDiagnostic;
}

type CopilotExtensionInspection =
  | {
      status: "declared";
      paths: string[];
      exclusive: boolean;
      sourceForm: "string" | "array" | "object";
    }
  | {
      status: "invalid";
      paths: [];
      diagnostic: InventoryDiagnostic;
    };

type CopilotRuntimeExtension = NonNullable<
  NonNullable<InventoryPlan["runtime"]>["copilot"]
>["extensions"][number];

interface CopilotCustomRoot {
  origin: "user-settings" | "environment";
  path: string;
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

function sourceId(kind: string, ...parts: string[]): string {
  return `github-copilot:${kind}:${sha256(parts.join("\0")).slice("sha256:".length)}`;
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

async function matchesDirectoryIdentity(
  path: string,
  expected: InventoryPathIdentity
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink() && metadata.isDirectory() &&
      metadata.dev === expected.device && metadata.ino === expected.inode &&
      metadata.birthtimeMs === expected.birthtimeMs &&
      await realpath(path) === path;
  } catch {
    return false;
  }
}

async function matchesFileIdentity(
  path: string,
  expected: InventoryPathIdentity
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink() && metadata.isFile() &&
      metadata.dev === expected.device && metadata.ino === expected.inode &&
      metadata.birthtimeMs === expected.birthtimeMs;
  } catch {
    return false;
  }
}

async function verifiedCacheRoot(path: string): Promise<
  VerifiedDirectory | { error: "missing" | "invalid" | "unreadable" }
> {
  try {
    const lexical = resolve(path);
    const metadata = await lstat(lexical);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { error: "invalid" };
    }
    const physical = await realpath(lexical);
    const physicalMetadata = await lstat(physical);
    if (physicalMetadata.isSymbolicLink() || !physicalMetadata.isDirectory()) {
      return { error: "invalid" };
    }
    return { path: physical, identity: pathIdentity(physicalMetadata) };
  } catch (error) {
    return {
      error: errorCode(error) === "ENOENT" ? "missing" : "unreadable"
    };
  }
}

async function verifiedPluginRoot(
  cacheRoot: VerifiedDirectory,
  aliasPath: string
): Promise<VerifiedDirectory | { error: "invalid" | "unreadable" }> {
  try {
    if (!await matchesDirectoryIdentity(cacheRoot.path, cacheRoot.identity)) {
      return { error: "invalid" };
    }
    const aliasMetadata = await lstat(aliasPath);
    if (!aliasMetadata.isDirectory() && !aliasMetadata.isSymbolicLink()) {
      return { error: "invalid" };
    }
    const physical = await realpath(aliasPath);
    if (!isContained(cacheRoot.path, physical)) return { error: "invalid" };
    const metadata = await lstat(physical);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { error: "invalid" };
    }
    if (!await matchesDirectoryIdentity(cacheRoot.path, cacheRoot.identity)) {
      return { error: "invalid" };
    }
    return { path: physical, identity: pathIdentity(metadata) };
  } catch (error) {
    return { error: errorCode(error) === "ENOENT" ? "invalid" : "unreadable" };
  }
}

function directSource(
  role: string,
  path: string,
  scope: "global" | "project",
  kind: "direct-root" | "inherited-root",
  precedenceRank: number
): InventoryPlanSource {
  return {
    id: sourceId("direct", role, resolve(path)),
    harness: "github-copilot",
    scope,
    kind,
    path: resolve(path),
    layout: "children",
    ownership: "direct",
    precedenceRank,
    status: "scanned"
  };
}

function evidenceSource(
  role: string,
  path: string,
  status: InventoryPlanSource["status"],
  sourceDiagnostic: InventoryDiagnostic,
  precedenceRank: number
): InventoryPlanSource {
  return {
    id: sourceId("evidence", role, resolve(path)),
    harness: "github-copilot",
    scope: "global",
    kind: "native-plugin",
    path: resolve(path),
    layout: "children",
    ownership: "native-plugin",
    precedenceRank,
    status,
    diagnostic: sourceDiagnostic
  };
}

function pluginSource(
  input: {
    role: string;
    originKey: string;
    pluginId: string;
    path: string;
    manifestPath?: string;
    declaredPath?: string;
    layout?: "self" | "children";
    status: InventoryPlanSource["status"];
    diagnostic?: InventoryDiagnostic;
    inspectSkills?: boolean;
    trustedContainment?: InventoryPlanSource["trustedContainment"];
  },
  precedenceRank: number
): InventoryPlanSource {
  return {
    id: sourceId(
      "plugin",
      input.role,
      input.originKey,
      input.pluginId,
      input.declaredPath ?? "",
      resolve(input.path)
    ),
    harness: "github-copilot",
    scope: "global",
    kind: "native-plugin",
    path: resolve(input.path),
    layout: input.layout ?? "children",
    ownership: "native-plugin",
    plugin: { id: input.pluginId },
    ...(input.manifestPath ? { manifestPath: resolve(input.manifestPath) } : {}),
    ...(input.inspectSkills ? { inspectSkills: true } : {}),
    ...(input.trustedContainment
      ? {
          trustedContainment: input.trustedContainment,
          symlinkPolicy: "contained" as const
        }
      : {}),
    precedenceRank,
    status: input.status,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

async function classifyDirectSource(
  source: InventoryPlanSource
): Promise<InventoryPlanSource> {
  try {
    const lexicalMetadata = await lstat(source.path);
    if (lexicalMetadata.isSymbolicLink()) {
      source.status = "invalid";
      source.diagnostic = diagnostic(
        "COPILOT_DIRECT_ROOT_SYMLINK_REFUSED",
        "Copilot direct Skill roots are not followed through symlinks"
      );
      return source;
    }
    if (!lexicalMetadata.isDirectory()) {
      source.status = "invalid";
      source.diagnostic = diagnostic(
        "COPILOT_DIRECT_ROOT_NOT_DIRECTORY",
        "Copilot direct Skill root is not a directory"
      );
      return source;
    }
    const physical = await realpath(source.path);
    const metadata = await lstat(physical);
    const after = await lstat(source.path);
    if (
      metadata.isSymbolicLink() || !metadata.isDirectory() ||
      after.isSymbolicLink() || !after.isDirectory() ||
      after.dev !== lexicalMetadata.dev || after.ino !== lexicalMetadata.ino ||
      after.birthtimeMs !== lexicalMetadata.birthtimeMs
    ) {
      source.status = "invalid";
      source.diagnostic = diagnostic(
        "COPILOT_DIRECT_ROOT_CHANGED",
        "Copilot direct Skill root changed during trusted planning"
      );
      return source;
    }
    const identity = pathIdentity(metadata);
    source.trustedContainment = {
      rootPath: physical,
      rootIdentity: identity,
      sourcePath: physical,
      sourceIdentity: identity
    };
    source.symlinkPolicy = "none";
  } catch (error) {
    const code = errorCode(error);
    source.status = code === "ENOENT" ? "missing" : "unreadable";
    source.diagnostic = diagnostic(
      code === "ENOENT"
        ? "COPILOT_DIRECT_ROOT_MISSING"
        : "COPILOT_DIRECT_ROOT_UNREADABLE",
      code === "ENOENT"
        ? "Copilot direct Skill root is missing at plan time"
        : "Copilot direct Skill root cannot be inspected at plan time"
    );
  }
  return source;
}

async function listChildren(
  path: string,
  budget: EnumerationBudget,
  capacity: number,
  containmentRoot?: string
): Promise<DirectoryListing> {
  if (budget.directoriesVisited >= budget.maxDirectories) {
    budget.truncated = true;
    return { entries: [], truncated: true };
  }
  budget.directoriesVisited += 1;
  let physical: string;
  try {
    physical = await realpath(path);
    const metadata = await lstat(physical);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
      (containmentRoot && !isContained(containmentRoot, physical))) {
      return { entries: [], truncated: false, error: "invalid" };
    }
  } catch {
    return { entries: [], truncated: false, error: "unreadable" };
  }
  const selected = new BoundedSmallestStrings(capacity);
  try {
    const directory = await opendir(physical);
    for await (const entry of directory) selected.add(entry.name);
  } catch {
    return { entries: [], truncated: false, error: "unreadable" };
  }
  const entries: ChildEntry[] = [];
  for (const name of selected.values()) {
    try {
      const metadata = await lstat(join(physical, name));
      entries.push({
        name,
        kind: metadata.isSymbolicLink()
          ? "symlink"
          : metadata.isDirectory() ? "directory" : "other"
      });
    } catch {
      entries.push({ name, kind: "other" });
    }
  }
  if (selected.truncated) budget.truncated = true;
  return { entries, truncated: selected.truncated };
}

class BoundedPluginIdentities {
  readonly records = new Map<string, PluginIdentity>();
  truncated = false;

  constructor(readonly capacity: number) {}

  add(record: PluginIdentity): void {
    const existing = this.records.get(record.key);
    if (existing) {
      const merged: PluginIdentity = {
        ...existing,
        ...record,
        origin: existing.origin === "configured" ? record.origin : existing.origin
      };
      const aliasPath = existing.aliasPath ?? record.aliasPath;
      const entryKind = existing.entryKind ?? record.entryKind;
      if (aliasPath !== undefined) merged.aliasPath = aliasPath;
      if (entryKind !== undefined) merged.entryKind = entryKind;
      this.records.set(record.key, merged);
      return;
    }
    if (this.records.size < this.capacity) {
      this.records.set(record.key, record);
      return;
    }
    this.truncated = true;
    let largest: string | undefined;
    for (const key of this.records.keys()) {
      if (largest === undefined || compareCodeUnits(key, largest) > 0) largest = key;
    }
    if (largest !== undefined && compareCodeUnits(record.key, largest) < 0) {
      this.records.delete(largest);
      this.records.set(record.key, record);
    }
  }

  values(): PluginIdentity[] {
    return [...this.records.values()].sort((left, right) =>
      compareCodeUnits(left.key, right.key)
    );
  }
}

const windowsReservedDevice = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu;
const validPluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isPortableSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." &&
    posix.basename(segment) === segment && win32.basename(segment) === segment &&
    !/[<>:"/\\|?*\u0000-\u001f]/u.test(segment) &&
    !/[ .]$/u.test(segment) && !windowsReservedDevice.test(segment);
}

function identityFromConfiguredId(
  id: string,
  installedRoot: string
): PluginIdentity {
  const split = id.lastIndexOf("@");
  if (split <= 0 || split === id.length - 1) {
    return { key: `configured\0${id}`, id, origin: "configured" };
  }
  const plugin = id.slice(0, split);
  const marketplace = id.slice(split + 1);
  if (!isPortableSegment(plugin) || !isPortableSegment(marketplace)) {
    return { key: `configured\0${id}`, id, origin: "configured" };
  }
  return {
    key: `${marketplace === "_direct" ? "direct" : "marketplace"}\0${marketplace}\0${plugin}`,
    id,
    origin: "configured",
    marketplace,
    plugin,
    aliasPath: join(installedRoot, marketplace, plugin)
  };
}

function normalizeManifestPaths(value: unknown): string[] | undefined {
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) ? value : undefined;
  if (!values) return undefined;
  const normalized: string[] = [];
  for (const candidate of values) {
    if (typeof candidate !== "string" || candidate.length === 0 ||
      candidate.includes("\\") || posix.isAbsolute(candidate) ||
      win32.isAbsolute(candidate)) {
      return undefined;
    }
    const trimmed = candidate.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (trimmed === "") {
      normalized.push(".");
      continue;
    }
    const segments = trimmed.split("/");
    if (segments.length > INVENTORY_SCAN_HARD_MAXIMA.maxDepth ||
      segments.some((segment) => !isPortableSegment(segment))) {
      return undefined;
    }
    normalized.push(segments.join("/"));
  }
  return [...new Set(normalized)];
}

function inspectExtensions(value: unknown): CopilotExtensionInspection | undefined {
  if (value === undefined) return undefined;
  let rawPaths: unknown;
  let exclusive = false;
  let sourceForm: "string" | "array" | "object";
  if (typeof value === "string") {
    rawPaths = value;
    sourceForm = "string";
  } else if (Array.isArray(value)) {
    rawPaths = value;
    sourceForm = "array";
  } else if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort(compareCodeUnits);
    const record = value as Record<string, unknown>;
    if (
      keys.length !== 2 || keys[0] !== "exclusive" || keys[1] !== "paths" ||
      !Array.isArray(record.paths) || typeof record.exclusive !== "boolean"
    ) {
      return {
        status: "invalid",
        paths: [],
        diagnostic: diagnostic(
          "COPILOT_EXTENSIONS_INVALID",
          "Copilot extension object must contain string-array paths and boolean exclusive"
        )
      };
    }
    rawPaths = record.paths;
    exclusive = record.exclusive;
    sourceForm = "object";
  } else {
    return {
      status: "invalid",
      paths: [],
      diagnostic: diagnostic(
        "COPILOT_EXTENSIONS_INVALID",
        "Copilot extensions must be a string, string array, or documented object"
      )
    };
  }
  const paths = normalizeManifestPaths(rawPaths);
  if (
    !paths || paths.length === 0 || paths.length > COPILOT_PLUGIN_HARD_MAX ||
    paths.some((path) => path === ".")
  ) {
    return {
      status: "invalid",
      paths: [],
      diagnostic: diagnostic(
        "COPILOT_EXTENSIONS_INVALID",
        "Copilot extension paths must be bounded portable relative file paths"
      )
    };
  }
  return { status: "declared", paths, exclusive, sourceForm };
}

async function inspectManifest(
  pluginRoot: VerifiedDirectory,
  hooks?: GitHubCopilotInventoryHooks
): Promise<ManifestInspection> {
  let selectedPath: string | undefined;
  let selectedIdentity: InventoryPathIdentity | undefined;
  for (const relativePath of manifestLocations) {
    const candidate = join(pluginRoot.path, relativePath);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        return {
          kind: "invalid",
          manifestPath: candidate,
          status: "invalid",
          diagnostic: diagnostic(
            "COPILOT_PLUGIN_MANIFEST_NOT_FILE",
            "The first existing Copilot plugin manifest path is not a physical file"
          )
        };
      }
      const physicalManifest = await realpath(candidate);
      if (!isContained(pluginRoot.path, physicalManifest)) {
        return {
          kind: "invalid",
          manifestPath: candidate,
          status: "invalid",
          diagnostic: diagnostic(
            "COPILOT_PLUGIN_MANIFEST_REALPATH_ESCAPE",
            "The first existing Copilot plugin manifest leaves the plugin root"
          )
        };
      }
      const physicalMetadata = await lstat(physicalManifest);
      if (physicalMetadata.isSymbolicLink() || !physicalMetadata.isFile()) {
        return {
          kind: "invalid",
          manifestPath: candidate,
          status: "invalid",
          diagnostic: diagnostic(
            "COPILOT_PLUGIN_MANIFEST_NOT_FILE",
            "The first existing Copilot plugin manifest is not a physical file"
          )
        };
      }
      selectedPath = physicalManifest;
      selectedIdentity = pathIdentity(physicalMetadata);
      break;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return {
        kind: "invalid",
        manifestPath: candidate,
        status: "unreadable",
        diagnostic: diagnostic(
          "METADATA_UNREADABLE",
          "Copilot plugin manifest path cannot be inspected"
        )
      };
    }
  }
  if (!selectedPath || !selectedIdentity) {
    return {
      kind: "invalid",
      manifestPath: join(pluginRoot.path, manifestLocations[0]),
      status: "missing",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_MANIFEST_MISSING",
        "Copilot installed plugin has no manifest in the documented lookup order"
      )
    };
  }
  if (!await matchesDirectoryIdentity(pluginRoot.path, pluginRoot.identity)) {
    return {
      kind: "invalid",
      manifestPath: selectedPath,
      status: "invalid",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_ROOT_CHANGED",
        "Copilot plugin root changed before manifest inspection"
      )
    };
  }
  let value: Record<string, unknown>;
  try {
    await hooks?.beforeManifestRead?.(selectedPath);
    if (!await matchesFileIdentity(selectedPath, selectedIdentity)) {
      throw Object.assign(new Error("manifest changed"), {
        code: "COPILOT_PLUGIN_MANIFEST_CHANGED"
      });
    }
    value = await readJsonObject(selectedPath);
  } catch (error) {
    const code = errorCode(error) ?? "COPILOT_PLUGIN_MANIFEST_INVALID";
    return {
      kind: "invalid",
      manifestPath: selectedPath,
      status: code === "METADATA_UNREADABLE"
        ? "unreadable"
        : code === "METADATA_TOO_LARGE" ? "truncated" : "invalid",
      diagnostic: diagnostic(code, "Copilot plugin manifest is invalid")
    };
  }
  if (!await matchesFileIdentity(selectedPath, selectedIdentity) ||
    !await matchesDirectoryIdentity(pluginRoot.path, pluginRoot.identity)) {
    return {
      kind: "invalid",
      manifestPath: selectedPath,
      status: "invalid",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_MANIFEST_CHANGED",
        "Copilot plugin manifest or root changed during inspection"
      )
    };
  }
  if (typeof value.name !== "string" || value.name.length > 64 ||
    !validPluginName.test(value.name)) {
    return {
      kind: "invalid",
      manifestPath: selectedPath,
      status: "invalid",
      diagnostic: diagnostic(
        "COPILOT_MANIFEST_NAME_INVALID",
        "Copilot plugin manifest name must be lowercase kebab-case and at most 64 characters"
      )
    };
  }
  const hasSkills = Object.prototype.hasOwnProperty.call(value, "skills");
  const paths = hasSkills ? normalizeManifestPaths(value.skills) : ["skills"];
  if (paths === undefined) {
    return {
      kind: "invalid",
      manifestPath: selectedPath,
      status: "invalid",
      diagnostic: diagnostic(
        "COPILOT_MANIFEST_SKILLS_INVALID",
        "Copilot plugin Skill paths must be non-empty portable relative paths"
      )
    };
  }
  const extension = inspectExtensions(value.extensions);
  return {
    kind: "valid",
    manifestPath: selectedPath,
    name: value.name,
    paths,
    ...(extension ? { extension } : {})
  };
}

function metadataStatusDiagnostic(
  label: string,
  state: CopilotSettingsState | CopilotManagedState
): InventoryDiagnostic {
  return diagnostic(
    state.diagnosticCode ?? `COPILOT_${label}_${state.kind.toUpperCase()}`,
    `Copilot ${label.toLowerCase()} metadata is ${state.kind}`
  );
}

function disposition(
  id: string,
  tiers: readonly CopilotSettingsTier[],
  managed: CopilotManagedState
): Disposition {
  const setting = resolveCopilotEnabledPlugin(id, tiers);
  if (setting.kind === "known") {
    return setting.value
      ? { status: "scanned" }
      : {
          status: "disabled",
          diagnostic: diagnostic(
            "COPILOT_PLUGIN_DISABLED",
            "Copilot plugin is disabled by effective settings"
          )
        };
  }
  if (setting.kind === "unknown") {
    return {
      status: "ambiguous",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_ENABLEMENT_AMBIGUOUS",
        "Copilot plugin settings are invalid, unreadable, or conflict at one scope"
      )
    };
  }
  if (managed.kind === "valid" && managed.installedPlugins.has(id)) {
    return managed.installedPlugins.get(id)
      ? { status: "scanned" }
      : {
          status: "disabled",
          diagnostic: diagnostic(
            "COPILOT_PLUGIN_DISABLED",
            "Copilot managed state marks this plugin disabled"
          )
        };
  }
  return {
    status: "ambiguous",
    diagnostic: diagnostic(
      "COPILOT_PLUGIN_ENABLEMENT_UNKNOWN",
      "Copilot plugin runtime enablement cannot be proven locally"
    )
  };
}

async function planPlugin(
  identity: PluginIdentity,
  cacheRoot: VerifiedDirectory,
  dispositionValue: Disposition,
  budget: EnumerationBudget,
  pluginRank: number,
  extensions: CopilotRuntimeExtension[],
  hooks?: GitHubCopilotInventoryHooks
): Promise<InventoryPlanSource[]> {
  const aliasPath = identity.aliasPath ?? join(cacheRoot.path, "__missing__");
  const source = (
    patch: Omit<Parameters<typeof pluginSource>[0], "originKey" | "pluginId">
  ) => pluginSource({
    ...patch,
    originKey: identity.key,
    pluginId: identity.id
  }, pluginRank);
  if (budget.directoriesVisited >= budget.maxDirectories) {
    budget.truncated = true;
    return [source({
      role: "plugin-directory-limit",
      path: aliasPath,
      status: "truncated",
      diagnostic: diagnostic(
        "COPILOT_DIRECTORY_LIMIT",
        "Copilot plugin root was not inspected after the directory limit"
      )
    })];
  }
  budget.directoriesVisited += 1;
  if (identity.entryKind === "other") {
    return [source({
      role: "entry",
      path: aliasPath,
      status: "invalid",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_ENTRY_NOT_DIRECTORY",
        "Copilot installed plugin entry is not a directory or contained symlink"
      )
    })];
  }
  const verified = await verifiedPluginRoot(cacheRoot, aliasPath);
  if ("error" in verified) {
    const configured = identity.origin === "configured";
    return [source({
      role: configured ? "configured-missing" : "plugin-root",
      path: aliasPath,
      status: configured && dispositionValue.status === "scanned"
        ? "missing"
        : configured && dispositionValue.status === "disabled"
          ? "disabled"
          : configured && dispositionValue.status === "ambiguous"
            ? "ambiguous"
          : verified.error === "unreadable" ? "unreadable" : "invalid",
      diagnostic: diagnostic(
        configured && dispositionValue.status === "scanned"
          ? "COPILOT_PLUGIN_INSTALL_MISSING"
          : verified.error === "unreadable"
            ? "COPILOT_PLUGIN_ROOT_UNREADABLE"
            : "COPILOT_PLUGIN_ROOT_INVALID",
        configured
          ? "Configured Copilot plugin is not installed at its expected path"
          : "Copilot plugin root is invalid or leaves the installed-plugin cache"
      )
    })];
  }
  const manifest = await inspectManifest(verified, hooks);
  if (manifest.kind === "invalid") {
    return [source({
      role: "manifest",
      path: verified.path,
      manifestPath: manifest.manifestPath,
      status: manifest.status,
      diagnostic: manifest.diagnostic
    })];
  }
  if (manifest.extension) {
    extensions.push({
      ...manifest.extension,
      pluginId: identity.id
    } as CopilotRuntimeExtension);
  }
  const sources: InventoryPlanSource[] = [];
  const planned = new Set<string>();
  for (const declaredPath of manifest.paths) {
    if (budget.directoriesVisited >= budget.maxDirectories) {
      budget.truncated = true;
      sources.push(source({
        role: "component-limit",
        path: verified.path,
        manifestPath: manifest.manifestPath,
        declaredPath,
        status: "truncated",
        diagnostic: diagnostic(
          "COPILOT_DIRECTORY_LIMIT",
          "Copilot plugin component planning reached the directory limit"
        )
      }));
      break;
    }
    budget.directoriesVisited += 1;
    try {
      if (!await matchesDirectoryIdentity(verified.path, verified.identity)) {
        throw Object.assign(new Error("plugin root changed"), {
          code: "COPILOT_PLUGIN_ROOT_CHANGED"
        });
      }
      const component = await resolveContainedComponent(verified.path, declaredPath);
      if (!isContained(verified.path, component) ||
        !await matchesDirectoryIdentity(verified.path, verified.identity)) {
        throw Object.assign(new Error("plugin root changed"), {
          code: "COPILOT_PLUGIN_ROOT_CHANGED"
        });
      }
      const metadata = await lstat(component);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        sources.push(source({
          role: "component",
          path: component,
          manifestPath: manifest.manifestPath,
          declaredPath,
          status: "invalid",
          diagnostic: diagnostic(
            "COPILOT_COMPONENT_NOT_DIRECTORY",
            "Copilot plugin Skill component is not a physical directory"
          )
        }));
        continue;
      }
      if (planned.has(component)) continue;
      planned.add(component);
      let layout: "self" | "children" = "children";
      try {
        const marker = await lstat(join(component, "SKILL.md"));
        if (marker.isFile() && !marker.isSymbolicLink()) layout = "self";
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      sources.push(source({
        role: "component",
        path: component,
        manifestPath: manifest.manifestPath,
        declaredPath,
        layout,
        status: dispositionValue.status,
        ...(dispositionValue.diagnostic
          ? { diagnostic: dispositionValue.diagnostic }
          : {}),
        inspectSkills: dispositionValue.status !== "scanned",
        trustedContainment: {
          rootPath: verified.path,
          rootIdentity: verified.identity,
          sourcePath: component,
          sourceIdentity: pathIdentity(metadata)
        }
      }));
    } catch (error) {
      const code = errorCode(error) ?? "COPILOT_PLUGIN_COMPONENT_INVALID";
      sources.push(source({
        role: "component",
        path: code === "COMPONENT_PATH_MISSING"
          ? join(verified.path, declaredPath)
          : verified.path,
        manifestPath: manifest.manifestPath,
        declaredPath,
        status: code === "COMPONENT_PATH_DEPTH_LIMIT"
          ? "truncated"
          : code === "COMPONENT_PATH_MISSING" ? "missing" : "invalid",
        diagnostic: diagnostic(
          code,
          code === "COMPONENT_PATH_MISSING"
            ? "Copilot plugin Skill component is missing"
            : "Copilot plugin Skill component is unsafe or changed during planning"
        )
      }));
    }
  }
  if (sources.length === 0) {
    sources.push(source({
      role: "empty-plugin",
      path: verified.path,
      manifestPath: manifest.manifestPath,
      status: "missing",
      diagnostic: diagnostic(
        "COPILOT_PLUGIN_SKILLS_MISSING",
        "Copilot plugin has no usable declared Skill roots"
      )
    }));
  }
  return sources;
}

function parseCustomRoots(
  input: GitHubCopilotInventoryInput,
  cwd: string,
  user: CopilotSettingsState
): { roots: CopilotCustomRoot[]; truncated: boolean; invalid: boolean } {
  const records = new Map<string, CopilotCustomRoot>();
  if (user.kind === "valid") {
    for (const declared of user.skillDirectories ?? []) {
      const path = resolve(cwd, declared);
      records.set(`user-settings\0${path}`, {
        origin: "user-settings",
        path
      });
    }
  }

  const raw = input.copilotSkillsDirs;
  let truncated = false;
  let invalid = false;
  if (raw !== undefined) {
    if (typeof raw !== "string") {
      invalid = true;
    } else if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) {
      truncated = true;
      invalid = true;
    } else {
      const environmentPaths = new Set<string>();
      for (const entry of raw.split(",")) {
        const trimmed = entry.trim();
        if (trimmed.length === 0) continue;
        environmentPaths.add(resolve(cwd, trimmed));
      }
      const selected = new BoundedSmallestStrings(COPILOT_CUSTOM_ROOT_HARD_MAX);
      for (const path of environmentPaths) selected.add(path);
      if (selected.truncated) truncated = true;
      for (const path of selected.values()) {
        records.set(`environment\0${path}`, { origin: "environment", path });
      }
    }
  }

  const selected = new BoundedSmallestStrings(COPILOT_CUSTOM_ROOT_HARD_MAX);
  for (const key of records.keys()) selected.add(key);
  if (selected.truncated) truncated = true;
  return {
    roots: selected.values().flatMap((key) => {
      const record = records.get(key);
      return record ? [record] : [];
    }),
    truncated,
    invalid
  };
}

async function planGitHubCopilotInventoryInternal(
  input: GitHubCopilotInventoryInput,
  hooks?: GitHubCopilotInventoryHooks
): Promise<InventoryPlan> {
  const home = resolve(input.home);
  const cwd = resolve(input.cwd);
  const copilotHome = resolve(input.copilotHome ?? join(home, ".copilot"));
  const installedPluginsPath = resolve(
    input.installedPluginsPath ?? join(copilotHome, "installed-plugins")
  );
  const configPath = resolve(input.configPath ?? join(copilotHome, "config.json"));
  const maxPlugins = input.limits?.maxPlugins ?? COPILOT_PLUGIN_HARD_MAX;
  const maxDirectories = input.limits?.maxDirectories ??
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories;
  validateInventoryBound(
    maxPlugins,
    "GitHub Copilot limits.maxPlugins",
    COPILOT_PLUGIN_HARD_MAX
  );
  validateInventoryBound(
    maxDirectories,
    "GitHub Copilot limits.maxDirectories",
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );

  const ancestors = await workspaceAncestors(cwd);
  const workspaceRoot = ancestors.at(-1) ?? cwd;
  const settingsPaths = {
    user: resolve(input.userSettingsPath ?? join(copilotHome, "settings.json")),
    project: resolve(input.projectSettingsPath ??
      join(workspaceRoot, ".github", "copilot", "settings.json")),
    local: resolve(input.localSettingsPath ??
      join(workspaceRoot, ".github", "copilot", "settings.local.json")),
    sharedProject: resolve(input.sharedProjectSettingsPath ??
      join(workspaceRoot, ".claude", "settings.json")),
    sharedLocal: resolve(input.sharedLocalSettingsPath ??
      join(workspaceRoot, ".claude", "settings.local.json"))
  };

  const sources: InventoryPlanSource[] = [];
  let rank = 0;
  const nextRank = () => rank++;
  for (const [ancestorIndex, ancestor] of ancestors.entries()) {
    for (const [role, relativePath] of [
      ["github", ".github/skills"],
      ["agents", ".agents/skills"],
      ["claude", ".claude/skills"]
    ] as const) {
      sources.push(await classifyDirectSource(directSource(
        `project-${ancestorIndex}-${role}`,
        join(ancestor, relativePath),
        "project",
        ancestorIndex === 0 ? "direct-root" : "inherited-root",
        nextRank()
      )));
    }
  }
  sources.push(await classifyDirectSource(directSource(
    "personal-copilot",
    join(copilotHome, "skills"),
    "global",
    "direct-root",
    nextRank()
  )));
  sources.push(await classifyDirectSource(directSource(
    "personal-agents",
    join(home, ".agents", "skills"),
    "global",
    "direct-root",
    nextRank()
  )));

  const settings = {
    user: await readCopilotSettings(settingsPaths.user, maxPlugins, "user"),
    project: await readCopilotSettings(settingsPaths.project, maxPlugins, "enabled-only"),
    local: await readCopilotSettings(settingsPaths.local, maxPlugins, "enabled-only"),
    sharedProject: await readCopilotSettings(
      settingsPaths.sharedProject,
      maxPlugins,
      "enabled-only"
    ),
    sharedLocal: await readCopilotSettings(
      settingsPaths.sharedLocal,
      maxPlugins,
      "enabled-only"
    )
  };
  const tiers: CopilotSettingsTier[] = [
    { native: settings.user },
    { native: settings.project, shared: settings.sharedProject },
    { native: settings.local, shared: settings.sharedLocal }
  ];
  const managed = await readCopilotManagedState(configPath, maxPlugins);
  for (const [role, state] of Object.entries({ ...settings, config: managed })
    .sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (state.kind === "valid") continue;
    sources.push(evidenceSource(
      `metadata-${role}`,
      state.path,
      state.kind,
      metadataStatusDiagnostic(role === "config" ? "CONFIG" : "SETTINGS", state),
      nextRank()
    ));
  }

  const budget: EnumerationBudget = {
    directoriesVisited: 0,
    maxDirectories,
    truncated: false
  };
  const identities = new BoundedPluginIdentities(maxPlugins);
  const cacheRootInspection = await verifiedCacheRoot(installedPluginsPath);
  const cacheError = "error" in cacheRootInspection
    ? cacheRootInspection.error
    : undefined;
  const cacheRoot = "error" in cacheRootInspection
    ? undefined
    : cacheRootInspection;
  if (!cacheRoot) {
    sources.push(evidenceSource(
      "installed-plugin-cache",
      installedPluginsPath,
      cacheError ?? "unreadable",
      diagnostic(
        cacheError === "missing"
          ? "COPILOT_PLUGIN_CACHE_MISSING"
          : cacheError === "invalid"
            ? "COPILOT_PLUGIN_CACHE_INVALID"
            : "COPILOT_PLUGIN_CACHE_UNREADABLE",
        "Copilot installed-plugin cache is missing, unreadable, or not a physical directory"
      ),
      nextRank()
    ));
  } else {
    const top = await listChildren(
      cacheRoot.path,
      budget,
      Math.max(1, maxPlugins + 1),
      cacheRoot.path
    );
    if (top.error) {
      sources.push(evidenceSource(
        "installed-plugin-cache",
        cacheRoot.path,
        top.error,
        diagnostic(
          "COPILOT_PLUGIN_CACHE_UNREADABLE",
          "Copilot installed-plugin cache cannot be enumerated"
        ),
        nextRank()
      ));
    }
    for (const container of top.entries) {
      const containerPath = join(cacheRoot.path, container.name);
      if (container.kind === "other") {
        identities.add({
          key: `container\0${container.name}`,
          id: `${container.name}@__container__`,
          origin: "container",
          marketplace: container.name,
          aliasPath: containerPath,
          entryKind: "other"
        });
        continue;
      }
      if (container.kind === "symlink") {
        identities.add({
          key: `container\0${container.name}`,
          id: `${container.name}@__container__`,
          origin: "container",
          marketplace: container.name,
          aliasPath: containerPath,
          entryKind: "symlink"
        });
        continue;
      }
      const plugins = await listChildren(
        containerPath,
        budget,
        Math.max(1, maxPlugins + 1),
        cacheRoot.path
      );
      if (plugins.error) {
        identities.add({
          key: `container\0${container.name}`,
          id: `${container.name}@__container__`,
          origin: "container",
          marketplace: container.name,
          aliasPath: containerPath,
          entryKind: plugins.error === "invalid" ? "other" : "symlink"
        });
        continue;
      }
      for (const plugin of plugins.entries) {
        const direct = container.name === "_direct";
        identities.add({
          key: `${direct ? "direct" : "marketplace"}\0${container.name}\0${plugin.name}`,
          id: `${plugin.name}@${container.name}`,
          origin: direct ? "direct" : "marketplace",
          marketplace: container.name,
          plugin: plugin.name,
          aliasPath: join(containerPath, plugin.name),
          entryKind: plugin.kind
        });
      }
      if (plugins.truncated) identities.truncated = true;
    }
    if (top.truncated) identities.truncated = true;
  }

  for (const state of Object.values(settings)) {
    if (state.kind === "missing" || state.kind === "unreadable") continue;
    if (state.kind === "truncated") identities.truncated = true;
    for (const id of state.enabledPlugins.keys()) {
      identities.add(identityFromConfiguredId(id, installedPluginsPath));
    }
  }
  if (managed.kind !== "missing" && managed.kind !== "unreadable") {
    if (managed.kind === "truncated") identities.truncated = true;
    for (const id of managed.installedPlugins.keys()) {
      identities.add(identityFromConfiguredId(id, installedPluginsPath));
    }
  }

  await hooks?.afterPluginDiscovery?.(
    identities.values().flatMap(({ aliasPath }) => aliasPath ? [aliasPath] : [])
  );
  const pluginTierRank = nextRank();
  const extensions: CopilotRuntimeExtension[] = [];
  if (cacheRoot) {
    for (const identity of identities.values()) {
      const resolvedDisposition = disposition(identity.id, tiers, managed);
      sources.push(...await planPlugin(
        identity,
        cacheRoot,
        resolvedDisposition,
        budget,
        pluginTierRank,
        extensions,
        hooks
      ));
    }
  } else {
    for (const identity of identities.values()) {
      const resolvedDisposition = disposition(identity.id, tiers, managed);
      sources.push(pluginSource({
        role: "cache-unavailable",
        originKey: identity.key,
        pluginId: identity.id,
        path: identity.aliasPath ?? installedPluginsPath,
        status: resolvedDisposition.status === "disabled"
          ? "disabled"
          : resolvedDisposition.status === "scanned" ? "missing" : "ambiguous",
        diagnostic: resolvedDisposition.diagnostic ?? diagnostic(
          "COPILOT_PLUGIN_CACHE_UNAVAILABLE",
          "Configured Copilot plugin cache is unavailable"
        )
      }, pluginTierRank));
    }
  }
  if (identities.truncated) {
    sources.push(evidenceSource(
      "plugin-limit",
      installedPluginsPath,
      "truncated",
      diagnostic(
        "COPILOT_PLUGIN_LIMIT",
        "Copilot native plugin identities exceeded the configured plugin limit"
      ),
      nextRank()
    ));
  }

  const custom = parseCustomRoots(input, cwd, settings.user);
  const customTierRank = nextRank();
  for (const root of custom.roots) {
    const source = await classifyDirectSource(directSource(
      `custom:${root.origin}`,
      root.path,
      "global",
      "direct-root",
      customTierRank
    ));
    sources.push(source);
  }
  if (custom.invalid || custom.truncated) {
    sources.push(evidenceSource(
      "custom-roots",
      cwd,
      custom.truncated ? "truncated" : "invalid",
      diagnostic(
        custom.truncated
          ? "COPILOT_CUSTOM_ROOT_LIMIT"
          : "COPILOT_CUSTOM_ROOTS_INVALID",
        "COPILOT_SKILLS_DIRS is invalid or exceeds its bounded input limit"
      ),
      nextRank()
    ));
  }
  if (budget.truncated) {
    sources.push(evidenceSource(
      "directory-limit",
      installedPluginsPath,
      "truncated",
      diagnostic(
        "COPILOT_DIRECTORY_LIMIT",
        "Copilot inventory planning reached the configured directory limit"
      ),
      nextRank()
    ));
  }

  return {
    sources,
    bounds: {
      maxDepth: INVENTORY_SCAN_HARD_MAXIMA.maxDepth,
      maxDirectories: Math.max(0, maxDirectories - budget.directoriesVisited),
      maxSkills: INVENTORY_SCAN_HARD_MAXIMA.maxSkills
    },
    runtime: {
      copilot: {
        disabledSkills: resolveCopilotDisabledSkills(settings.user),
        extensions: extensions.sort((left, right) =>
          compareCodeUnits(
            left.pluginId,
            right.pluginId
          )
        ),
        customRoots: custom.roots,
        pluginOrder: "unverified",
        coverageLimitations: [
          "COPILOT_BUILTIN_SKILLS_OUT_OF_LOCAL_SCOPE",
          "COPILOT_MDM_STATE_UNOBSERVABLE"
        ]
      }
    }
  };
}

export async function planGitHubCopilotInventory(
  input: GitHubCopilotInventoryInput
): Promise<InventoryPlan> {
  return planGitHubCopilotInventoryInternal(input);
}

export async function planGitHubCopilotInventoryWithHooks(
  input: GitHubCopilotInventoryInput,
  hooks: GitHubCopilotInventoryHooks
): Promise<InventoryPlan> {
  return planGitHubCopilotInventoryInternal(input, hooks);
}
