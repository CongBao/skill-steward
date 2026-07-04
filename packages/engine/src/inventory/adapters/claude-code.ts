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
import { readJsonObject } from "../metadata.js";
import { BoundedSmallestStrings, compareCodeUnits } from "../selection.js";
import {
  discoverNestedClaudeSkillRoots,
  workspaceAncestors
} from "../workspace.js";
import {
  effectiveClaudeSetting as effectiveSetting,
  readClaudeActiveInstallations as readActiveInstallations,
  readClaudeSettings as readSettings,
  resolveClaudeSetting,
  type ClaudeActiveState as ActiveState
} from "./claude-code-metadata.js";

const CLAUDE_PLUGIN_HARD_MAX = 100;

export interface ClaudeCodeInventoryInput {
  home: string;
  cwd: string;
  claudeHome?: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
  localSettingsPath?: string;
  pluginCachePath?: string;
  installedPluginsPath?: string;
  limits?: {
    maxPlugins?: number;
    maxDirectories?: number;
  };
}

interface ClaudeCodeInventoryHooks {
  afterNestedDiscovery?(paths: string[]): Promise<void> | void;
  afterSkillsDirectoryClassification?(
    plugins: Array<{ id: string; path: string }>
  ): Promise<void> | void;
  beforeSkillsDirectoryManifestRead?(path: string): Promise<void> | void;
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

interface CachePlugin {
  id: string;
  marketplace: string;
  plugin: string;
  path: string;
  kind: ChildEntry["kind"];
}

interface SkillsDirectoryAlias {
  sourceId: string;
  scope: "global" | "project";
  activeScope: boolean;
}

interface SkillsDirectoryPlugin {
  key: string;
  id: string;
  namespace: string;
  path: string;
  containmentRoot: string;
  rootIdentity: InventoryPathIdentity;
  aliases: SkillsDirectoryAlias[];
  defaultEnabled: boolean;
  manifestIdentity: InventoryPathIdentity;
  inspectedManifest?: ValidManifest;
  manifestFailure?: InvalidManifest;
}

interface SkillsDirectoryDiscovery {
  plugins: SkillsDirectoryPlugin[];
  truncated: boolean;
}

interface IdentityRecord {
  key: string;
  id: string;
  origin:
    | "skills-directory"
    | "cache"
    | "configured"
    | "configured-skills-directory";
  cache?: CachePlugin;
  skillsDirectory?: SkillsDirectoryPlugin;
  configuredSkillsDirectoryNamespace?: string;
}

interface ValidManifest {
  kind: "valid";
  namespace: string;
  manifestPath?: string;
  customPaths: string[];
  hasSkillsField: boolean;
  defaultEnabled: boolean;
}

interface InvalidManifest {
  kind: "invalid";
  manifestPath: string;
  status: "missing" | "invalid" | "unreadable";
  diagnostic: InventoryDiagnostic;
}

type ManifestInspection = ValidManifest | InvalidManifest;

interface VersionDisposition {
  status: InventoryPlanSource["status"];
  diagnostic?: InventoryDiagnostic;
}

interface VerifiedDirectory {
  path: string;
  identity: InventoryPathIdentity;
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
  return `claude-code:${kind}:${sha256(parts.join("\0")).slice("sha256:".length)}`;
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
): Promise<VerifiedDirectory | { error: "invalid" | "unreadable" }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return { error: "invalid" };
    }
    const physicalPath = await realpath(path);
    if (!isContained(containmentRoot, physicalPath)) return { error: "invalid" };
    return {
      path: physicalPath,
      identity: {
        device: metadata.dev,
        inode: metadata.ino,
        birthtimeMs: metadata.birthtimeMs
      }
    };
  } catch {
    return { error: "unreadable" };
  }
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

async function pathState(path: string): Promise<
  "missing" | "unreadable" | "symlink" | "directory" | "other"
> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    return metadata.isDirectory() ? "directory" : "other";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

async function listChildren(
  path: string,
  capacity: number,
  budget: EnumerationBudget,
  containmentRoot: string
): Promise<DirectoryListing> {
  if (budget.directoriesVisited >= budget.maxDirectories) {
    budget.truncated = true;
    return { entries: [], truncated: true };
  }
  const verified = await verifiedDirectory(containmentRoot, path);
  if ("error" in verified) {
    return { entries: [], truncated: false, error: verified.error };
  }
  budget.directoriesVisited += 1;
  const selected = new BoundedSmallestStrings(Math.max(0, capacity));
  try {
    const directory = await opendir(verified.path);
    for await (const entry of directory) selected.add(entry.name);
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
  if (selected.truncated) budget.truncated = true;
  return { entries, truncated: selected.truncated };
}

function directSource(
  role: string,
  path: string,
  scope: "global" | "project",
  kind: "direct-root" | "inherited-root",
  precedenceRank: number,
  pathQualification?: string
): InventoryPlanSource {
  return {
    id: sourceId("direct", role, resolve(path)),
    harness: "claude",
    scope,
    kind,
    path: resolve(path),
    layout: "children",
    ownership: "direct",
    ...(pathQualification ? { pathQualification } : {}),
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
    harness: "claude",
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
    configuredId: string;
    namespace?: string | undefined;
    version?: string | undefined;
    path: string;
    scope?: "global" | "project";
    kind?: "native-plugin" | "skills-directory-plugin";
    layout?: "self" | "children";
    manifestPath?: string | undefined;
    declaredPath?: string | undefined;
    status: InventoryPlanSource["status"];
    diagnostic?: InventoryDiagnostic | undefined;
    inspectSkills?: boolean | undefined;
    symlinkPolicy?: "none" | "external" | "contained" | undefined;
    trustedContainment?: InventoryPlanSource["trustedContainment"] | undefined;
    provenanceId?: string | undefined;
  },
  precedenceRank: number
): InventoryPlanSource {
  return {
    id: sourceId(
      "plugin",
      input.provenanceId ? `${input.role}:${input.provenanceId}` : input.role,
      input.configuredId,
      input.version ?? "",
      input.declaredPath ?? "",
      resolve(input.path)
    ),
    harness: "claude",
    scope: input.scope ?? "global",
    kind: input.kind ?? "native-plugin",
    path: resolve(input.path),
    layout: input.layout ?? "children",
    ownership: "native-plugin",
    plugin: {
      id: input.configuredId,
      ...(input.version ? { version: input.version } : {})
    },
    ...(input.namespace ? { pluginNamespace: input.namespace } : {}),
    ...(input.manifestPath ? { manifestPath: resolve(input.manifestPath) } : {}),
    ...(input.inspectSkills ? { inspectSkills: true } : {}),
    ...(input.symlinkPolicy ? { symlinkPolicy: input.symlinkPolicy } : {}),
    ...(input.trustedContainment
      ? { trustedContainment: input.trustedContainment }
      : {}),
    precedenceRank,
    status: input.status,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

class BoundedIdentityRecords {
  readonly records = new Map<string, IdentityRecord>();
  truncated = false;

  constructor(readonly capacity: number) {}

  add(
    key: string,
    id: string,
    origin: IdentityRecord["origin"],
    patch: Partial<Omit<IdentityRecord, "key" | "id" | "origin">> = {}
  ): void {
    const existing = this.records.get(key);
    if (existing) {
      this.records.set(key, { ...existing, ...patch, key, id, origin });
      return;
    }
    const next: IdentityRecord = {
      key,
      id,
      origin,
      ...patch
    };
    if (this.records.size < this.capacity) {
      this.records.set(key, next);
      return;
    }
    this.truncated = true;
    let largest: string | undefined;
    for (const candidate of this.records.keys()) {
      if (largest === undefined || compareCodeUnits(candidate, largest) > 0) {
        largest = candidate;
      }
    }
    if (largest !== undefined && compareCodeUnits(key, largest) < 0) {
      this.records.delete(largest);
      this.records.set(key, next);
    }
  }

  values(): IdentityRecord[] {
    return [...this.records.values()].sort((left, right) =>
      compareCodeUnits(left.key, right.key)
    );
  }
}

const windowsReservedDevice = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu;

function isPortableSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." &&
    posix.basename(segment) === segment && win32.basename(segment) === segment &&
    !/[<>:"/\\|?*\u0000-\u001f]/u.test(segment) &&
    !/[ .]$/u.test(segment) && !windowsReservedDevice.test(segment);
}

function configuredLocation(cachePath: string, id: string): string | undefined {
  const split = id.lastIndexOf("@");
  if (split <= 0 || split === id.length - 1) return undefined;
  const plugin = id.slice(0, split);
  const marketplace = id.slice(split + 1);
  if (!isPortableSegment(plugin) || !isPortableSegment(marketplace)) return undefined;
  return resolve(cachePath, marketplace, plugin);
}

function configuredSkillsDirectoryNamespace(id: string): string | undefined {
  const split = id.lastIndexOf("@");
  if (split <= 0 || split === id.length - 1) return undefined;
  const namespace = id.slice(0, split);
  const origin = id.slice(split + 1);
  return origin === "skills-dir" && validClaudePluginName.test(namespace)
    ? namespace
    : undefined;
}

function portableManifestPaths(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length === 0) return [];
  const input = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;
  if (!input || input.length === 0) return undefined;
  const normalized: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !item.startsWith("./") || item.includes("\\")) {
      return undefined;
    }
    const relativePath = item.slice(2).replace(/\/+$/u, "");
    if (relativePath === "") {
      normalized.push("");
      continue;
    }
    const segments = relativePath.split("/");
    if (segments.length === 0 || segments.some((segment) => !isPortableSegment(segment))) {
      return undefined;
    }
    normalized.push(relativePath);
  }
  return [...new Set(normalized)].sort(compareCodeUnits);
}

const validClaudePluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function settingDisposition(
  enabled: boolean | undefined,
  versions: Array<{ version: string; path: string }>,
  active: ActiveState,
  id: string
): Map<string, VersionDisposition> {
  const dispositions = new Map<string, VersionDisposition>();
  if (enabled === false) {
    for (const version of versions) {
      dispositions.set(version.version, {
        status: "disabled",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_DISABLED",
          "Claude Code plugin is disabled by the effective settings scope"
        )
      });
    }
    return dispositions;
  }
  if (enabled !== true) {
    for (const version of versions) {
      dispositions.set(version.version, {
        status: "ambiguous",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ENABLEMENT_UNKNOWN",
          "Claude Code plugin enablement is not a known effective boolean"
        )
      });
    }
    return dispositions;
  }

  if (versions.length === 1) {
    const version = versions[0]!;
    const activeRecords = active.kind === "valid"
      ? active.installations.get(id) ?? []
      : [];
    const activeMatch = activeRecords.some((record) =>
      record.version === version.version &&
      resolve(record.installPath) === resolve(version.path)
    );
    dispositions.set(version.version, activeRecords.length > 0 && !activeMatch
      ? {
          status: "stale",
          diagnostic: diagnostic(
            "CLAUDE_PLUGIN_VERSION_STALE",
            "Claude Code cache version is not the locally proven active install"
          )
        }
      : { status: "scanned" });
    return dispositions;
  }

  const records = active.kind === "valid"
    ? active.installations.get(id) ?? []
    : [];
  const proven = versions.filter((version) => records.some((record) =>
    record.version === version.version && resolve(record.installPath) === resolve(version.path)
  ));
  if (proven.length === 1) {
    const activeVersion = proven[0]!.version;
    for (const version of versions) {
      dispositions.set(version.version, version.version === activeVersion
        ? { status: "scanned" }
        : {
            status: "stale",
            diagnostic: diagnostic(
              "CLAUDE_PLUGIN_VERSION_STALE",
              "Claude Code cache version is not the locally proven active install"
            )
          });
    }
    return dispositions;
  }
  for (const version of versions) {
    dispositions.set(version.version, {
      status: "ambiguous",
      diagnostic: diagnostic(
        "CLAUDE_PLUGIN_VERSION_AMBIGUOUS",
        "Claude Code has multiple cached versions without one locally proven active version"
      )
    });
  }
  return dispositions;
}

async function inspectManifest(
  pluginRoot: string,
  fallbackNamespace: string,
  rootIdentity: InventoryPathIdentity,
  manifestRequired: boolean,
  expectedManifestIdentity?: InventoryPathIdentity,
  beforeManifestRead?: (path: string) => Promise<void> | void
): Promise<ManifestInspection> {
  const expectedManifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  try {
    if (!await matchesDirectoryIdentity(pluginRoot, rootIdentity)) {
      return {
        kind: "invalid",
        manifestPath: expectedManifest,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ROOT_CHANGED",
          "Claude Code plugin root changed before manifest inspection"
        )
      };
    }
    const manifestPath = await resolveContainedComponent(
      pluginRoot,
      ".claude-plugin/plugin.json"
    );
    if (!isContained(pluginRoot, manifestPath) ||
      !await matchesDirectoryIdentity(pluginRoot, rootIdentity)) {
      return {
        kind: "invalid",
        manifestPath: expectedManifest,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ROOT_CHANGED",
          "Claude Code plugin root changed before manifest inspection"
        )
      };
    }
    if (
      expectedManifestIdentity &&
      !await matchesFileIdentity(manifestPath, expectedManifestIdentity)
    ) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_MANIFEST_CHANGED",
          "Claude Code plugin manifest changed after skills-directory classification"
        )
      };
    }
    let manifest: Record<string, unknown>;
    try {
      await beforeManifestRead?.(manifestPath);
      manifest = await readJsonObject(manifestPath);
    } catch (error) {
      return {
        kind: "invalid",
        manifestPath,
        status: errorCode(error) === "METADATA_UNREADABLE"
          ? "unreadable"
          : "invalid",
        diagnostic: diagnostic(
          errorCode(error) ?? "CLAUDE_PLUGIN_MANIFEST_INVALID",
          "Claude Code plugin manifest is invalid"
        )
      };
    }
    if (
      expectedManifestIdentity &&
      !await matchesFileIdentity(manifestPath, expectedManifestIdentity)
    ) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_MANIFEST_CHANGED",
          "Claude Code plugin manifest changed during manifest inspection"
        )
      };
    }
    if (!await matchesDirectoryIdentity(pluginRoot, rootIdentity)) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ROOT_CHANGED",
          "Claude Code plugin root changed during manifest inspection"
        )
      };
    }
    const namespaceValue = manifest.name;
    if (
      typeof namespaceValue !== "string" ||
      !validClaudePluginName.test(namespaceValue)
    ) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_MANIFEST_NAME_INVALID",
          "Claude Code plugin manifest name must be lowercase kebab-case"
        )
      };
    }
    const hasSkillsField = Object.prototype.hasOwnProperty.call(manifest, "skills");
    if (
      manifest.defaultEnabled !== undefined &&
      typeof manifest.defaultEnabled !== "boolean"
    ) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_MANIFEST_DEFAULT_ENABLED_INVALID",
          "Claude Code plugin manifest defaultEnabled must be a boolean"
        )
      };
    }
    const customPaths = hasSkillsField ? portableManifestPaths(manifest.skills) : [];
    if (customPaths === undefined) {
      return {
        kind: "invalid",
        manifestPath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_MANIFEST_SKILLS_INVALID",
          "Claude Code plugin custom Skill paths must be portable ./ relative paths"
        )
      };
    }
    return {
      kind: "valid",
      namespace: namespaceValue,
      manifestPath,
      customPaths,
      hasSkillsField,
      defaultEnabled: manifest.defaultEnabled ?? true
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === "COMPONENT_PATH_MISSING") {
      if (manifestRequired) {
        return {
          kind: "invalid",
          manifestPath: expectedManifest,
          status: "missing",
          diagnostic: diagnostic(
            "CLAUDE_PLUGIN_MANIFEST_MISSING",
            "Classified Claude Code skills-directory plugin manifest is missing"
          )
        };
      }
      return {
        kind: "valid",
        namespace: fallbackNamespace,
        customPaths: [],
        hasSkillsField: false,
        defaultEnabled: true
      };
    }
    return {
      kind: "invalid",
      manifestPath: expectedManifest,
      status: "invalid",
      diagnostic: diagnostic(
        code ?? "CLAUDE_PLUGIN_MANIFEST_INVALID",
        "Claude Code plugin manifest path is invalid"
      )
    };
  }
}

async function planBundle(
  input: {
    configuredId: string;
    fallbackNamespace: string;
    version?: string;
    path: string;
    containmentRoot: string;
    scope: "global" | "project";
    kind: "native-plugin" | "skills-directory-plugin";
    manifestRequired?: boolean;
    expectedRootIdentity?: InventoryPathIdentity;
    expectedManifestIdentity?: InventoryPathIdentity;
    inspectedManifest?: ValidManifest;
    provenanceId?: string;
    disposition: VersionDisposition;
  },
  budget: EnumerationBudget,
  nextRank: () => number
): Promise<InventoryPlanSource[]> {
  const bundleSource = (
    source: Parameters<typeof pluginSource>[0],
    precedenceRank: number
  ) => pluginSource({
    ...source,
    ...(input.provenanceId ? { provenanceId: input.provenanceId } : {})
  }, precedenceRank);
  const verifiedRoot = await verifiedDirectory(input.containmentRoot, input.path);
  if ("error" in verifiedRoot) {
    return [bundleSource({
      role: "bundle",
      configuredId: input.configuredId,
      version: input.version,
      path: input.path,
      scope: input.scope,
      kind: input.kind,
      status: verifiedRoot.error === "invalid" ? "invalid" : "unreadable",
      diagnostic: diagnostic(
        verifiedRoot.error === "invalid"
          ? "CLAUDE_PLUGIN_ROOT_INVALID"
          : "CLAUDE_PLUGIN_ROOT_UNREADABLE",
        "Claude Code plugin root changed or cannot be inspected"
      )
    }, nextRank())];
  }
  const pluginRoot = verifiedRoot.path;
  if (
    input.expectedRootIdentity &&
    !await matchesDirectoryIdentity(pluginRoot, input.expectedRootIdentity)
  ) {
    return [bundleSource({
      role: "bundle",
      configuredId: input.configuredId,
      version: input.version,
      path: pluginRoot,
      scope: input.scope,
      kind: input.kind,
      status: "invalid",
      diagnostic: diagnostic(
        "CLAUDE_PLUGIN_ROOT_CHANGED",
        "Claude Code plugin root changed after skills-directory classification"
      )
    }, nextRank())];
  }
  const manifest: ManifestInspection = input.inspectedManifest
    ? input.expectedManifestIdentity &&
      !await matchesFileIdentity(
        input.inspectedManifest.manifestPath ?? join(pluginRoot, ".claude-plugin", "plugin.json"),
        input.expectedManifestIdentity
      )
      ? {
          kind: "invalid",
          manifestPath: input.inspectedManifest.manifestPath ??
            join(pluginRoot, ".claude-plugin", "plugin.json"),
          status: "invalid",
          diagnostic: diagnostic(
            "CLAUDE_PLUGIN_MANIFEST_CHANGED",
            "Claude Code plugin manifest changed after manifest inspection"
          )
        }
      : input.inspectedManifest
    : await inspectManifest(
        pluginRoot,
        input.fallbackNamespace,
        verifiedRoot.identity,
        input.manifestRequired === true,
        input.expectedManifestIdentity
      );
  if (manifest.kind === "invalid") {
    return [bundleSource({
      role: "manifest",
      configuredId: input.configuredId,
      version: input.version,
      path: pluginRoot,
      scope: input.scope,
      kind: input.kind,
      manifestPath: manifest.manifestPath,
      status: manifest.status,
      diagnostic: manifest.diagnostic
    }, nextRank())];
  }

  const declarationByPath = new Map<string, { declared: string; path: string }>();
  declarationByPath.set("skills", { declared: "skills", path: "skills" });
  for (const path of manifest.customPaths) {
    if (!declarationByPath.has(path)) {
      declarationByPath.set(path, {
        declared: path === "" ? "./" : `./${path}`,
        path: path === "" ? "." : path
      });
    }
  }
  const declarations = [...declarationByPath.values()].sort((left, right) => {
    if (left.declared === "skills") return -1;
    if (right.declared === "skills") return 1;
    return compareCodeUnits(left.declared, right.declared);
  });
  const remainingComponents = Math.max(
    0,
    budget.maxDirectories - budget.directoriesVisited
  );
  const selectedDeclarations = declarations.slice(0, remainingComponents);
  const componentsTruncated = selectedDeclarations.length < declarations.length;
  if (componentsTruncated) budget.truncated = true;
  const sources: InventoryPlanSource[] = [];
  const plannedComponentPaths = new Set<string>();
  let defaultExists = false;
  for (const declaration of selectedDeclarations) {
    budget.directoriesVisited += 1;
    try {
      if (!await matchesDirectoryIdentity(pluginRoot, verifiedRoot.identity)) {
        throw Object.assign(new Error("plugin root changed"), {
          code: "CLAUDE_PLUGIN_ROOT_CHANGED"
        });
      }
      const componentPath = await resolveContainedComponent(pluginRoot, declaration.path);
      if (!isContained(pluginRoot, componentPath) ||
        !await matchesDirectoryIdentity(pluginRoot, verifiedRoot.identity)) {
        throw Object.assign(new Error("plugin root changed"), {
          code: "CLAUDE_PLUGIN_ROOT_CHANGED"
        });
      }
      const metadata = await lstat(componentPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        sources.push(bundleSource({
          role: "component",
          configuredId: input.configuredId,
          namespace: manifest.namespace,
          version: input.version,
          path: componentPath,
          scope: input.scope,
          kind: input.kind,
          manifestPath: manifest.manifestPath,
          declaredPath: declaration.declared,
          status: "invalid",
          diagnostic: diagnostic(
            "CLAUDE_COMPONENT_NOT_DIRECTORY",
            "Claude Code plugin Skill root is not a physical directory"
          )
        }, nextRank()));
        continue;
      }
      if (declaration.path === "skills") defaultExists = true;
      if (plannedComponentPaths.has(componentPath)) continue;
      plannedComponentPaths.add(componentPath);
      let layout: "self" | "children" = "children";
      if (declaration.path !== "skills") {
        try {
          const marker = await lstat(join(componentPath, "SKILL.md"));
          if (marker.isFile() && !marker.isSymbolicLink()) layout = "self";
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      sources.push(bundleSource({
        role: "component",
        configuredId: input.configuredId,
        namespace: manifest.namespace,
        version: input.version,
        path: componentPath,
        scope: input.scope,
        kind: input.kind,
        manifestPath: manifest.manifestPath,
        declaredPath: declaration.declared,
        layout,
        status: input.disposition.status,
        ...(input.disposition.diagnostic
          ? { diagnostic: input.disposition.diagnostic }
          : {}),
        inspectSkills: input.disposition.status !== "scanned",
        symlinkPolicy: "contained",
        trustedContainment: {
          rootPath: pluginRoot,
          rootIdentity: verifiedRoot.identity,
          sourcePath: componentPath,
          sourceIdentity: {
            device: metadata.dev,
            inode: metadata.ino,
            birthtimeMs: metadata.birthtimeMs
          }
        }
      }, nextRank()));
    } catch (error) {
      const code = errorCode(error) ?? "CLAUDE_PLUGIN_COMPONENT_INVALID";
      if (declaration.path === "skills" && code === "COMPONENT_PATH_MISSING") {
        continue;
      }
      sources.push(bundleSource({
        role: "component",
        configuredId: input.configuredId,
        namespace: manifest.namespace,
        version: input.version,
        path: code === "COMPONENT_PATH_MISSING"
          ? join(pluginRoot, declaration.path)
          : pluginRoot,
        scope: input.scope,
        kind: input.kind,
        manifestPath: manifest.manifestPath,
        declaredPath: declaration.declared,
        status: code === "COMPONENT_PATH_DEPTH_LIMIT"
          ? "truncated"
          : code === "COMPONENT_PATH_MISSING" ? "missing" : "invalid",
        diagnostic: diagnostic(
          code,
          code === "COMPONENT_PATH_MISSING"
            ? "Claude Code plugin Skill root is missing"
            : "Claude Code plugin Skill root leaves the plugin directory"
        )
      }, nextRank()));
    }
  }

  if (componentsTruncated) {
    sources.push(bundleSource({
      role: "component-limit",
      configuredId: input.configuredId,
      namespace: manifest.namespace,
      version: input.version,
      path: pluginRoot,
      scope: input.scope,
      kind: input.kind,
      manifestPath: manifest.manifestPath,
      status: "truncated",
      diagnostic: diagnostic(
        "CLAUDE_DIRECTORY_LIMIT",
        "Claude Code plugin component roots exceeded the residual directory limit"
      )
    }, nextRank()));
  }

  if (!componentsTruncated && !defaultExists && !manifest.hasSkillsField) {
    const markerPath = join(pluginRoot, "SKILL.md");
    try {
      const marker = await lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink()) {
        return [...sources, bundleSource({
          role: "root-skill",
          configuredId: input.configuredId,
          namespace: manifest.namespace,
          version: input.version,
          path: pluginRoot,
          scope: input.scope,
          kind: input.kind,
          layout: "self",
          manifestPath: manifest.manifestPath,
          status: "invalid",
          diagnostic: diagnostic(
            "CLAUDE_ROOT_SKILL_INVALID",
            "Claude Code plugin root SKILL.md is not a physical file"
          )
        }, nextRank())];
      }
      sources.push(bundleSource({
        role: "root-skill",
        configuredId: input.configuredId,
        namespace: manifest.namespace,
        version: input.version,
        path: pluginRoot,
        scope: input.scope,
        kind: input.kind,
        layout: "self",
        manifestPath: manifest.manifestPath,
        status: input.disposition.status,
        ...(input.disposition.diagnostic
          ? { diagnostic: input.disposition.diagnostic }
          : {}),
        inspectSkills: input.disposition.status !== "scanned",
        symlinkPolicy: "contained",
        trustedContainment: {
          rootPath: pluginRoot,
          rootIdentity: verifiedRoot.identity,
          sourcePath: pluginRoot,
          sourceIdentity: verifiedRoot.identity
        }
      }, nextRank()));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        sources.push(bundleSource({
          role: "root-skill",
          configuredId: input.configuredId,
          namespace: manifest.namespace,
          version: input.version,
          path: pluginRoot,
          scope: input.scope,
          kind: input.kind,
          layout: "self",
          manifestPath: manifest.manifestPath,
          status: "unreadable",
          diagnostic: diagnostic(
            "CLAUDE_ROOT_SKILL_UNREADABLE",
            "Claude Code plugin root SKILL.md cannot be inspected"
          )
        }, nextRank()));
      }
    }
  }

  if (sources.length === 0) {
    sources.push(bundleSource({
      role: "empty-bundle",
      configuredId: input.configuredId,
      namespace: manifest.namespace,
      version: input.version,
      path: join(pluginRoot, "skills"),
      scope: input.scope,
      kind: input.kind,
      manifestPath: manifest.manifestPath,
      status: "missing",
      diagnostic: diagnostic(
        "CLAUDE_PLUGIN_SKILLS_MISSING",
        "Claude Code plugin has no default, declared, or root Skill layout"
      )
    }, nextRank()));
  }
  return sources;
}

async function attachNestedTrust(
  source: InventoryPlanSource,
  workspaceRoot: string
): Promise<"invalid" | "unreadable" | undefined> {
  let physicalWorkspaceRoot: string;
  try {
    physicalWorkspaceRoot = await realpath(resolve(workspaceRoot));
  } catch {
    return "unreadable";
  }
  const root = await verifiedDirectory(physicalWorkspaceRoot, physicalWorkspaceRoot);
  if ("error" in root) return root.error;
  const nested = await verifiedDirectory(root.path, source.path);
  if ("error" in nested) return nested.error;
  source.trustedContainment = {
    rootPath: root.path,
    rootIdentity: root.identity,
    sourcePath: nested.path,
    sourceIdentity: nested.identity
  };
  source.symlinkPolicy = "external";
  source.path = nested.path;
  return undefined;
}

async function attachDirectTrust(source: InventoryPlanSource): Promise<void> {
  try {
    const physicalPath = await realpath(source.path);
    const metadata = await lstat(physicalPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    const identity: InventoryPathIdentity = {
      device: metadata.dev,
      inode: metadata.ino,
      birthtimeMs: metadata.birthtimeMs
    };
    source.trustedContainment = {
      rootPath: physicalPath,
      rootIdentity: identity,
      sourcePath: physicalPath,
      sourceIdentity: identity
    };
    source.symlinkPolicy = "external";
  } catch {
    // Missing direct roots are retained and classified by the shared walker.
  }
}

async function discoverSkillsDirectoryPlugins(
  directSources: InventoryPlanSource[],
  budget: EnumerationBudget,
  activeSourceIds: ReadonlySet<string>
): Promise<SkillsDirectoryDiscovery> {
  const plugins: SkillsDirectoryPlugin[] = [];
  const roots = new Map<string, {
    sources: InventoryPlanSource[];
  }>();
  let truncated = false;
  for (const source of directSources) {
    let physicalRoot: string | undefined;
    try {
      physicalRoot = source.trustedContainment?.sourcePath ??
        await realpath(source.path);
    } catch {
      continue;
    }
    const verifiedRoot = await verifiedDirectory(physicalRoot, physicalRoot);
    if ("error" in verifiedRoot) continue;
    const existing = roots.get(verifiedRoot.path);
    if (existing) {
      existing.sources.push(source);
    } else {
      roots.set(verifiedRoot.path, {
        sources: [source]
      });
    }
  }
  for (const [physicalRoot, root] of [...roots.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right)
  )) {
    const remaining = Math.max(0, budget.maxDirectories - budget.directoriesVisited);
    const children = await listChildren(physicalRoot, remaining, budget, physicalRoot);
    if (children.error) continue;
    if (children.truncated) {
      truncated = true;
      for (const source of root.sources) {
        source.status = "truncated";
        source.diagnostic = diagnostic(
          "CLAUDE_DIRECTORY_LIMIT",
          "Claude Code skills-directory classification reached the directory limit"
        );
      }
    }
    for (const child of children.entries) {
      if (budget.directoriesVisited >= budget.maxDirectories) {
        budget.truncated = true;
        truncated = true;
        for (const source of root.sources) {
          source.status = "truncated";
          source.diagnostic = diagnostic(
            "CLAUDE_DIRECTORY_LIMIT",
            "Claude Code skills-directory classification reached the directory limit"
          );
        }
        break;
      }
      budget.directoriesVisited += 1;
      if (child.kind !== "directory") continue;
      const plannedChildPath = join(physicalRoot, child.name);
      const verifiedChild = await verifiedDirectory(physicalRoot, plannedChildPath);
      if ("error" in verifiedChild) continue;
      const childPath = verifiedChild.path;
      let manifestIdentity: InventoryPathIdentity | undefined;
      try {
        const marker = await lstat(join(childPath, ".claude-plugin", "plugin.json"));
        if (marker.isFile() && !marker.isSymbolicLink()) {
          manifestIdentity = {
            device: marker.dev,
            inode: marker.ino,
            birthtimeMs: marker.birthtimeMs
          };
        }
      } catch {
        manifestIdentity = undefined;
      }
      if (!manifestIdentity) continue;
      for (const source of root.sources) {
        source.excludedChildPaths = [
          ...(source.excludedChildPaths ?? []),
          childPath
        ].sort(compareCodeUnits);
      }
      const namespace = child.name;
      const id = validClaudePluginName.test(namespace)
        ? `${namespace}@skills-dir`
        : `invalid@skills-dir:${sha256(childPath)
            .slice("sha256:".length, "sha256:".length + 12)}`;
      plugins.push({
        key: `skills-directory\0${physicalRoot}\0${childPath}`,
        id,
        namespace,
        path: childPath,
        containmentRoot: physicalRoot,
        rootIdentity: verifiedChild.identity,
        aliases: root.sources.map((source) => ({
          sourceId: source.id,
          scope: source.scope === "global" ? "global" : "project",
          activeScope: activeSourceIds.has(source.id)
        })),
        defaultEnabled: true,
        manifestIdentity
      });
    }
  }
  return {
    plugins: plugins.sort((left, right) => compareCodeUnits(left.key, right.key)),
    truncated
  };
}

async function planClaudeCodeInventoryInternal(
  input: ClaudeCodeInventoryInput,
  hooks?: ClaudeCodeInventoryHooks
): Promise<InventoryPlan> {
  const home = resolve(input.home);
  const cwd = resolve(input.cwd);
  const claudeHome = resolve(input.claudeHome ?? join(home, ".claude"));
  const pluginCachePath = resolve(
    input.pluginCachePath ?? join(claudeHome, "plugins", "cache")
  );
  const installedPluginsPath = resolve(
    input.installedPluginsPath ?? join(claudeHome, "plugins", "installed_plugins.json")
  );
  const maxPlugins = input.limits?.maxPlugins ?? CLAUDE_PLUGIN_HARD_MAX;
  const maxDirectories = input.limits?.maxDirectories ??
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories;
  validateInventoryBound(
    maxPlugins,
    "Claude Code limits.maxPlugins",
    CLAUDE_PLUGIN_HARD_MAX
  );
  validateInventoryBound(
    maxDirectories,
    "Claude Code limits.maxDirectories",
    INVENTORY_SCAN_HARD_MAXIMA.maxDirectories
  );

  const ancestors = await workspaceAncestors(cwd);
  const workspaceRoot = ancestors.at(-1) ?? cwd;
  const projectSettingsPath = resolve(
    input.projectSettingsPath ?? join(workspaceRoot, ".claude", "settings.json")
  );
  const localSettingsPath = resolve(
    input.localSettingsPath ?? join(workspaceRoot, ".claude", "settings.local.json")
  );
  const userSettingsPath = resolve(
    input.userSettingsPath ?? join(claudeHome, "settings.json")
  );
  const sources: InventoryPlanSource[] = [directSource(
    "user",
    join(claudeHome, "skills"),
    "global",
    "direct-root",
    0
  )];
  sources.push(...ancestors.map((ancestor, index) =>
    directSource(
      index === 0 ? "project" : "ancestor",
      join(ancestor, ".claude", "skills"),
      "project",
      index === 0 ? "direct-root" : "inherited-root",
      index + 1
    )
  ));
  for (const source of sources) await attachDirectTrust(source);
  let rank = sources.length;
  const nextRank = () => rank++;

  const budget: EnumerationBudget = {
    directoriesVisited: 0,
    maxDirectories,
    truncated: false
  };
  const nested = await discoverNestedClaudeSkillRoots(workspaceRoot, {
    maxDepth: INVENTORY_SCAN_HARD_MAXIMA.maxDepth,
    maxDirectories
  });
  await hooks?.afterNestedDiscovery?.([...nested.paths]);
  budget.directoriesVisited = nested.directoriesVisited;
  if (nested.truncated) budget.truncated = true;
  const plannedDirectPaths = new Set<string>();
  let physicalWorkspaceRoot = resolve(workspaceRoot);
  try {
    physicalWorkspaceRoot = await realpath(workspaceRoot);
  } catch {
    // The nested discovery result will be empty when the workspace is unreadable.
  }
  for (const source of sources) {
    try {
      plannedDirectPaths.add(await realpath(source.path));
    } catch {
      plannedDirectPaths.add(resolve(source.path));
    }
  }
  for (const nestedPath of nested.paths) {
    if (plannedDirectPaths.has(resolve(nestedPath))) continue;
    const qualification = relative(
      physicalWorkspaceRoot,
      join(nestedPath, "..", "..")
    )
      .split("\\").join("/") || ".";
    const source = directSource(
      "nested-on-demand",
      nestedPath,
      "project",
      "inherited-root",
      nextRank(),
      qualification
    );
    const trustFailure = await attachNestedTrust(source, workspaceRoot);
    if (trustFailure) {
      source.status = trustFailure;
      source.diagnostic = diagnostic(
        trustFailure === "invalid"
          ? "CLAUDE_NESTED_ROOT_CHANGED"
          : "CLAUDE_NESTED_ROOT_UNREADABLE",
        "Claude Code nested Skill root changed before trusted inventory planning"
      );
    }
    sources.push(source);
    plannedDirectPaths.add(resolve(source.path));
  }
  if (nested.truncated) {
    sources.push(evidenceSource(
      "nested-directory-limit",
      workspaceRoot,
      "truncated",
      diagnostic(
        "CLAUDE_NESTED_DIRECTORY_LIMIT",
        "Claude Code nested on-demand Skill discovery reached a configured bound"
      ),
      nextRank()
    ));
  }

  const settings = {
    user: await readSettings(userSettingsPath),
    project: await readSettings(projectSettingsPath),
    local: await readSettings(localSettingsPath)
  };
  for (const [scope, state] of Object.entries(settings).sort(([left], [right]) =>
    compareCodeUnits(left, right)
  )) {
    if (state.kind === "valid") continue;
    sources.push(evidenceSource(
      `settings-${scope}`,
      state.path,
      state.kind,
      diagnostic(
        state.diagnosticCode ?? (state.kind === "missing"
          ? "CLAUDE_SETTINGS_MISSING"
          : "CLAUDE_SETTINGS_INVALID"),
        `Claude Code ${scope} settings are ${state.kind}`
      ),
      nextRank()
    ));
  }
  sources.push(evidenceSource(
    "managed-state",
    join(claudeHome, "managed-state"),
    "ambiguous",
    diagnostic(
      "CLAUDE_MANAGED_STATE_UNOBSERVED",
      "Claude Code enterprise managed policy is not observable from local user and project settings"
    ),
    nextRank()
  ));
  const active = await readActiveInstallations(
    installedPluginsPath,
    pluginCachePath
  );
  if (active.kind !== "valid") {
    sources.push(evidenceSource(
      "active-metadata",
      active.path,
      active.kind,
      diagnostic(
        active.diagnosticCode ?? (active.kind === "missing"
          ? "CLAUDE_ACTIVE_METADATA_MISSING"
          : "CLAUDE_ACTIVE_METADATA_INVALID"),
        `Claude Code installed plugin metadata are ${active.kind}`
      ),
      nextRank()
    ));
  }

  const skillsDirectoryDiscovery = await discoverSkillsDirectoryPlugins(
    sources.filter(({ ownership }) => ownership === "direct"),
    budget,
    new Set(sources.filter(({ ownership, path }) =>
      ownership === "direct" && (
        resolve(path) === resolve(join(claudeHome, "skills")) ||
        resolve(path) === resolve(join(cwd, ".claude", "skills"))
      )
    ).map(({ id }) => id))
  );
  const skillsDirectoryPlugins = skillsDirectoryDiscovery.plugins;
  await hooks?.afterSkillsDirectoryClassification?.(
    skillsDirectoryPlugins.map(({ id, path }) => ({ id, path }))
  );
  const identities = new BoundedIdentityRecords(maxPlugins);
  const skillsDirectoryIds = new Set<string>();
  const cacheIdentityIds = new Set<string>();
  for (const plugin of skillsDirectoryPlugins) {
    skillsDirectoryIds.add(plugin.id);
    identities.add(
      plugin.key,
      plugin.id,
      "skills-directory",
      { skillsDirectory: plugin }
    );
  }
  for (const id of active.installations.keys()) {
    cacheIdentityIds.add(id);
    identities.add(`cache\0${id}`, id, "cache");
  }

  let physicalCachePath: string | undefined;
  let cacheResolutionFailed = false;
  const cacheState = await pathState(pluginCachePath);
  if (cacheState === "directory") {
    try {
      physicalCachePath = await realpath(pluginCachePath);
    } catch {
      cacheResolutionFailed = true;
      physicalCachePath = undefined;
    }
  }
  if (!physicalCachePath) {
    const status = cacheState === "missing"
      ? "missing"
      : cacheState === "unreadable" || cacheResolutionFailed
        ? "unreadable"
        : "invalid";
    sources.push(evidenceSource(
      "cache",
      pluginCachePath,
      status,
      diagnostic(
        status === "missing"
          ? "CLAUDE_CACHE_MISSING"
          : status === "unreadable"
            ? "CLAUDE_CACHE_UNREADABLE"
            : "CLAUDE_CACHE_INVALID",
        `Claude Code plugin cache is ${status}`
      ),
      nextRank()
    ));
  } else {
    const markets = await listChildren(
      physicalCachePath,
      Math.max(0, maxDirectories - budget.directoriesVisited),
      budget,
      physicalCachePath
    );
    if (markets.error) {
      sources.push(evidenceSource(
        "cache-list",
        pluginCachePath,
        markets.error,
        diagnostic(
          "CLAUDE_CACHE_UNREADABLE",
          "Claude Code plugin cache cannot be enumerated"
        ),
        nextRank()
      ));
    } else {
      for (const market of markets.entries) {
        const marketPath = join(physicalCachePath, market.name);
        if (market.kind !== "directory") {
          sources.push(evidenceSource(
            "marketplace-entry",
            marketPath,
            "invalid",
            diagnostic(
              market.kind === "symlink"
                ? "CLAUDE_CACHE_SYMLINK_REFUSED"
                : "CLAUDE_CACHE_ENTRY_NOT_DIRECTORY",
              "Claude Code marketplace cache entry is not a physical directory"
            ),
            nextRank()
          ));
          continue;
        }
        const plugins = await listChildren(
          marketPath,
          maxPlugins + 1,
          budget,
          physicalCachePath
        );
        if (plugins.error) {
          sources.push(evidenceSource(
            "marketplace-list",
            marketPath,
            plugins.error,
            diagnostic(
              "CLAUDE_CACHE_UNREADABLE",
              "Claude Code marketplace cache cannot be enumerated"
            ),
            nextRank()
          ));
          continue;
        }
        for (const plugin of plugins.entries) {
          const id = `${plugin.name}@${market.name}`;
          cacheIdentityIds.add(id);
          identities.add(`cache\0${id}`, id, "cache", {
            cache: {
              id,
              marketplace: market.name,
              plugin: plugin.name,
              path: join(marketPath, plugin.name),
              kind: plugin.kind
            }
          });
        }
        if (plugins.truncated) identities.truncated = true;
      }
    }
  }

  for (const state of [settings.user, settings.project, settings.local]) {
    for (const id of state.entries.keys()) {
      const namespace = configuredSkillsDirectoryNamespace(id);
      if (namespace) {
        if (skillsDirectoryIds.has(id)) continue;
        identities.add(
          `configured-skills-directory\0${id}`,
          id,
          "configured-skills-directory",
          { configuredSkillsDirectoryNamespace: namespace }
        );
        continue;
      }
      if (cacheIdentityIds.has(id)) continue;
      identities.add(`configured\0${id}`, id, "configured");
    }
  }

  const selectedIdentities = identities.values();
  const selectedSkillsDirectoryIds = new Set<string>();
  for (const identity of selectedIdentities) {
    if (identity.origin !== "skills-directory" || !identity.skillsDirectory) {
      continue;
    }
    const plugin = identity.skillsDirectory;
    const manifest = await inspectManifest(
      plugin.path,
      plugin.namespace,
      plugin.rootIdentity,
      true,
      plugin.manifestIdentity,
      hooks?.beforeSkillsDirectoryManifestRead
    );
    if (manifest.kind === "invalid") {
      plugin.manifestFailure = manifest;
      continue;
    }
    plugin.inspectedManifest = manifest;
    plugin.namespace = manifest.namespace;
    plugin.id = `${manifest.namespace}@skills-dir`;
    plugin.defaultEnabled = manifest.defaultEnabled;
    identity.id = plugin.id;
    selectedSkillsDirectoryIds.add(plugin.id);
  }

  const activeSkillsDirectorySources = sources.filter(({ ownership, path }) =>
    ownership === "direct" && (
      resolve(path) === resolve(join(claudeHome, "skills")) ||
      resolve(path) === resolve(join(cwd, ".claude", "skills"))
    )
  );

  for (const identity of selectedIdentities) {
    if (identity.origin === "skills-directory" && identity.skillsDirectory) {
      const plugin = identity.skillsDirectory;
      if (plugin.manifestFailure) {
        for (const alias of plugin.aliases) {
          sources.push(pluginSource({
            role: "manifest",
            configuredId: plugin.id,
            path: plugin.path,
            scope: alias.scope,
            kind: "skills-directory-plugin",
            manifestPath: plugin.manifestFailure.manifestPath,
            status: plugin.manifestFailure.status,
            diagnostic: plugin.manifestFailure.diagnostic,
            provenanceId: alias.sourceId
          }, nextRank()));
        }
        continue;
      }
      if (!plugin.inspectedManifest) continue;
      const setting = resolveClaudeSetting(
        plugin.id,
        settings.local,
        settings.project,
        settings.user
      );
      for (const alias of plugin.aliases) {
        const disposition: VersionDisposition = !alias.activeScope
          ? {
              status: "disabled",
              diagnostic: diagnostic(
                "CLAUDE_SKILLS_DIRECTORY_SCOPE_INACTIVE",
                "Claude Code skills-directory plugins are inactive outside user and exact-CWD roots"
              )
            }
          : setting.kind === "known"
            ? setting.value
              ? { status: "scanned" }
              : {
                  status: "disabled",
                  diagnostic: diagnostic(
                    "CLAUDE_PLUGIN_DISABLED",
                    "Claude Code skills-directory plugin is disabled by effective settings"
                  )
                }
            : setting.kind === "unknown"
              ? {
                  status: "ambiguous",
                  diagnostic: diagnostic(
                    "CLAUDE_PLUGIN_ENABLEMENT_UNKNOWN",
                    "Claude Code skills-directory plugin enablement is unknown"
                  )
                }
              : plugin.defaultEnabled
                ? { status: "scanned" }
                : {
                    status: "disabled",
                    diagnostic: diagnostic(
                      "CLAUDE_PLUGIN_DEFAULT_DISABLED",
                      "Claude Code skills-directory plugin is disabled by manifest default"
                    )
                  };
        sources.push(...await planBundle({
          configuredId: plugin.id,
          fallbackNamespace: plugin.namespace,
          path: plugin.path,
          containmentRoot: plugin.containmentRoot,
          scope: alias.scope,
          kind: "skills-directory-plugin",
          manifestRequired: true,
          expectedRootIdentity: plugin.rootIdentity,
          expectedManifestIdentity: plugin.manifestIdentity,
          inspectedManifest: plugin.inspectedManifest,
          provenanceId: alias.sourceId,
          disposition
        }, budget, nextRank));
      }
      continue;
    }

    if (
      identity.origin === "configured-skills-directory" &&
      identity.configuredSkillsDirectoryNamespace
    ) {
      if (selectedSkillsDirectoryIds.has(identity.id)) continue;
      const setting = resolveClaudeSetting(
        identity.id,
        settings.local,
        settings.project,
        settings.user
      );
      for (const source of activeSkillsDirectorySources) {
        const status = setting.kind === "known"
          ? setting.value ? "missing" : "disabled"
          : "ambiguous";
        sources.push(pluginSource({
          role: "configured-skills-directory",
          configuredId: identity.id,
          namespace: identity.configuredSkillsDirectoryNamespace,
          path: join(source.path, identity.configuredSkillsDirectoryNamespace),
          scope: source.scope === "global" ? "global" : "project",
          kind: "skills-directory-plugin",
          status,
          diagnostic: diagnostic(
            status === "disabled"
              ? "CLAUDE_PLUGIN_DISABLED"
              : status === "missing"
                ? "CLAUDE_SKILLS_DIR_PLUGIN_MISSING"
                : "CLAUDE_PLUGIN_ENABLEMENT_UNKNOWN",
            status === "disabled"
              ? "Configured Claude Code skills-directory plugin is disabled"
              : status === "missing"
                ? "Enabled Claude Code skills-directory plugin is missing from this active root"
                : "Configured Claude Code skills-directory plugin enablement is unknown"
          ),
          provenanceId: source.id
        }, nextRank()));
      }
      continue;
    }

    if (identity.origin !== "cache" && identity.origin !== "configured") {
      sources.push(pluginSource({
        role: "identity-origin",
        configuredId: identity.id,
        path: pluginCachePath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ORIGIN_INVALID",
          "Claude Code plugin origin could not be classified"
        )
      }, nextRank()));
      continue;
    }

    const expected = configuredLocation(pluginCachePath, identity.id);
    if (!expected) {
      sources.push(pluginSource({
        role: "configured-identity",
        configuredId: identity.id,
        path: pluginCachePath,
        status: "invalid",
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_ID_INVALID",
          "Claude Code plugin identity cannot map to a portable cache location"
        )
      }, nextRank()));
      continue;
    }
    if (!identity.cache) {
      const enabled = effectiveSetting(
        identity.id,
        settings.local,
        settings.project,
        settings.user
      );
      sources.push(pluginSource({
        role: "configured-missing",
        configuredId: identity.id,
        path: expected,
        status: enabled === false ? "disabled" : enabled === true ? "missing" : "ambiguous",
        diagnostic: diagnostic(
          enabled === false
            ? "CLAUDE_PLUGIN_DISABLED"
            : enabled === true
              ? "CLAUDE_PLUGIN_CACHE_MISSING"
              : "CLAUDE_PLUGIN_ENABLEMENT_UNKNOWN",
          enabled === false
            ? "Configured Claude Code plugin is disabled"
            : enabled === true
              ? "Enabled Claude Code plugin is missing from the cache"
              : "Configured Claude Code plugin has unknown effective enablement"
        )
      }, nextRank()));
      continue;
    }
    if (identity.cache.kind !== "directory") {
      sources.push(pluginSource({
        role: "cache-plugin-entry",
        configuredId: identity.id,
        path: identity.cache.path,
        status: "invalid",
        diagnostic: diagnostic(
          identity.cache.kind === "symlink"
            ? "CLAUDE_CACHE_SYMLINK_REFUSED"
            : "CLAUDE_CACHE_ENTRY_NOT_DIRECTORY",
          "Claude Code plugin cache entry is not a physical directory"
        )
      }, nextRank()));
      continue;
    }
    if (!physicalCachePath) continue;
    const versionsListing = await listChildren(
      identity.cache.path,
      Math.max(0, budget.maxDirectories - budget.directoriesVisited),
      budget,
      physicalCachePath
    );
    if (versionsListing.error) {
      sources.push(pluginSource({
        role: "version-list",
        configuredId: identity.id,
        path: identity.cache.path,
        status: versionsListing.error,
        diagnostic: diagnostic(
          "CLAUDE_CACHE_UNREADABLE",
          "Claude Code plugin versions cannot be enumerated"
        )
      }, nextRank()));
      continue;
    }
    const physicalVersions = versionsListing.entries.filter(({ kind }) =>
      kind === "directory"
    ).map(({ name }) => ({
      version: name,
      path: join(identity.cache!.path, name)
    }));
    const enabled = effectiveSetting(
      identity.id,
      settings.local,
      settings.project,
      settings.user
    );
    const dispositions = versionsListing.truncated
      ? new Map(physicalVersions.map(({ version }) => [
          version,
          {
            status: "truncated" as const,
            diagnostic: diagnostic(
              "CLAUDE_DIRECTORY_LIMIT",
              "Claude Code version inventory reached the directory limit"
            )
          }
        ]))
      : settingDisposition(enabled, physicalVersions, active, identity.id);
    for (const entry of versionsListing.entries) {
      const versionPath = join(identity.cache.path, entry.name);
      if (entry.kind !== "directory") {
        sources.push(pluginSource({
          role: "version-entry",
          configuredId: identity.id,
          version: entry.name,
          path: versionPath,
          status: "invalid",
          diagnostic: diagnostic(
            entry.kind === "symlink"
              ? "CLAUDE_CACHE_SYMLINK_REFUSED"
              : "CLAUDE_CACHE_ENTRY_NOT_DIRECTORY",
            "Claude Code plugin version is not a physical directory"
          )
        }, nextRank()));
        continue;
      }
      if (budget.directoriesVisited >= budget.maxDirectories) {
        budget.truncated = true;
        sources.push(pluginSource({
          role: "version-directory-limit",
          configuredId: identity.id,
          version: entry.name,
          path: versionPath,
          status: "truncated",
          diagnostic: diagnostic(
            "CLAUDE_DIRECTORY_LIMIT",
            "Claude Code plugin version was not inspected after the directory limit"
          )
        }, nextRank()));
        break;
      }
      budget.directoriesVisited += 1;
      const disposition = dispositions.get(entry.name) ?? {
        status: "ambiguous" as const,
        diagnostic: diagnostic(
          "CLAUDE_PLUGIN_VERSION_AMBIGUOUS",
          "Claude Code plugin version state cannot be proven"
        )
      };
      sources.push(...await planBundle({
        configuredId: identity.id,
        fallbackNamespace: identity.cache.plugin,
        version: entry.name,
        path: versionPath,
        containmentRoot: physicalCachePath,
        scope: "global",
        kind: "native-plugin",
        disposition
      }, budget, nextRank));
    }
    if (versionsListing.entries.length === 0) {
      sources.push(pluginSource({
        role: "version-missing",
        configuredId: identity.id,
        path: identity.cache.path,
        status: versionsListing.truncated ? "truncated" : "missing",
        diagnostic: diagnostic(
          versionsListing.truncated
            ? "CLAUDE_DIRECTORY_LIMIT"
            : "CLAUDE_PLUGIN_VERSION_MISSING",
          versionsListing.truncated
            ? "Claude Code version inventory reached the directory limit"
            : "Claude Code plugin cache has no version directory"
        )
      }, nextRank()));
    }
  }

  if (identities.truncated) {
    sources.push(evidenceSource(
      "plugin-limit",
      pluginCachePath,
      "truncated",
      diagnostic(
        "CLAUDE_PLUGIN_LIMIT",
        "Claude Code native plugin identities exceeded the configured plugin limit"
      ),
      nextRank()
    ));
  }
  if (budget.truncated) {
    sources.push(evidenceSource(
      "directory-limit",
      pluginCachePath,
      "truncated",
      diagnostic(
        "CLAUDE_DIRECTORY_LIMIT",
        "Claude Code inventory reached the configured directory limit"
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
    }
  };
}

export async function planClaudeCodeInventory(
  input: ClaudeCodeInventoryInput
): Promise<InventoryPlan> {
  return planClaudeCodeInventoryInternal(input);
}

export async function planClaudeCodeInventoryWithHooks(
  input: ClaudeCodeInventoryInput,
  hooks: ClaudeCodeInventoryHooks
): Promise<InventoryPlan> {
  return planClaudeCodeInventoryInternal(input, hooks);
}
