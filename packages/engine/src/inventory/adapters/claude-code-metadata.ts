import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { readJsonObject, readJsoncObject } from "../metadata.js";
import { compareCodeUnits } from "../selection.js";

export interface ClaudeSettingsState {
  kind: "valid" | "missing" | "invalid" | "unreadable";
  path: string;
  entries: Map<string, boolean | undefined>;
  diagnosticCode?: string;
}

export interface ClaudeActiveInstallation {
  version: string;
  installPath: string;
}

export interface ClaudeActiveState {
  kind: "valid" | "missing" | "invalid" | "unreadable";
  path: string;
  installations: Map<string, ClaudeActiveInstallation[]>;
  diagnosticCode?: string;
}

export type ClaudeSettingResolution =
  | { kind: "known"; value: boolean }
  | { kind: "absent" }
  | { kind: "unknown" };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function metadataKind(
  path: string
): Promise<"missing" | "unreadable" | "present"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

export async function readClaudeSettings(
  path: string
): Promise<ClaudeSettingsState> {
  try {
    const value = await readJsoncObject(path);
    const configured = value.enabledPlugins;
    if (configured === undefined) {
      return { kind: "valid", path, entries: new Map() };
    }
    if (
      typeof configured !== "object" || configured === null ||
      Array.isArray(configured)
    ) {
      return {
        kind: "invalid",
        path,
        entries: new Map(),
        diagnosticCode: "CLAUDE_SETTINGS_INVALID"
      };
    }
    const entries = new Map<string, boolean | undefined>();
    for (const id of Object.keys(configured).sort(compareCodeUnits)) {
      const entry = (configured as Record<string, unknown>)[id];
      entries.set(id, typeof entry === "boolean" ? entry : undefined);
    }
    return { kind: "valid", path, entries };
  } catch (error) {
    const kind = await metadataKind(path);
    if (kind === "missing") return { kind, path, entries: new Map() };
    const code = errorCode(error);
    const unreadable = kind === "unreadable" || code === "METADATA_UNREADABLE";
    return {
      kind: unreadable ? "unreadable" : "invalid",
      path,
      entries: new Map(),
      diagnosticCode: unreadable
        ? "METADATA_UNREADABLE"
        : code && code !== "METADATA_INVALID_JSONC"
          ? code
          : "CLAUDE_SETTINGS_INVALID"
    };
  }
}

export async function readClaudeActiveInstallations(
  path: string,
  pluginCachePath: string
): Promise<ClaudeActiveState> {
  try {
    const value = await readJsonObject(path);
    if (
      value.version !== 2 || typeof value.plugins !== "object" ||
      value.plugins === null || Array.isArray(value.plugins)
    ) {
      return {
        kind: "invalid",
        path,
        installations: new Map(),
        diagnosticCode: "CLAUDE_ACTIVE_METADATA_INVALID"
      };
    }
    const installations = new Map<string, ClaudeActiveInstallation[]>();
    const lexicalCacheRoot = resolve(pluginCachePath);
    let physicalCacheRoot: string | undefined;
    for (const id of Object.keys(value.plugins).sort(compareCodeUnits)) {
      const records = (value.plugins as Record<string, unknown>)[id];
      if (!Array.isArray(records)) throw new Error("invalid active records");
      const parsed: ClaudeActiveInstallation[] = [];
      for (const record of records) {
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
          throw new Error("invalid active record");
        }
        const version = (record as Record<string, unknown>).version;
        const installPath = (record as Record<string, unknown>).installPath;
        if (
          typeof version !== "string" || version.length === 0 ||
          typeof installPath !== "string" || !isAbsolute(installPath)
        ) {
          throw new Error("invalid active record fields");
        }
        const lexicalInstallPath = resolve(installPath);
        const cacheRelativePath = relative(lexicalCacheRoot, lexicalInstallPath);
        if (
          cacheRelativePath === ".." || cacheRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          isAbsolute(cacheRelativePath)
        ) {
          throw new Error("active install path leaves the plugin cache");
        }
        let physicalInstallPath: string;
        try {
          physicalCacheRoot ??= await realpath(lexicalCacheRoot);
          physicalInstallPath = await realpath(
            resolve(physicalCacheRoot, cacheRelativePath)
          );
          const physicalRelativePath = relative(physicalCacheRoot, physicalInstallPath);
          const metadata = await lstat(physicalInstallPath);
          if (
            physicalRelativePath === ".." ||
            physicalRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
            isAbsolute(physicalRelativePath) || !metadata.isDirectory() ||
            metadata.isSymbolicLink()
          ) {
            throw new Error("active install path is not a contained directory");
          }
        } catch {
          throw new Error("active install path cannot be proven");
        }
        parsed.push({ version, installPath: physicalInstallPath });
      }
      installations.set(id, parsed);
    }
    return { kind: "valid", path, installations };
  } catch (error) {
    const kind = await metadataKind(path);
    if (kind === "missing") return { kind, path, installations: new Map() };
    const code = errorCode(error);
    const unreadable = kind === "unreadable" || code === "METADATA_UNREADABLE";
    return {
      kind: unreadable ? "unreadable" : "invalid",
      path,
      installations: new Map(),
      diagnosticCode: code ?? (unreadable
        ? "METADATA_UNREADABLE"
        : "CLAUDE_ACTIVE_METADATA_INVALID")
    };
  }
}

export function effectiveClaudeSetting(
  id: string,
  local: ClaudeSettingsState,
  project: ClaudeSettingsState,
  user: ClaudeSettingsState
): boolean | undefined {
  const resolved = resolveClaudeSetting(id, local, project, user);
  return resolved.kind === "known" ? resolved.value : undefined;
}

export function resolveClaudeSetting(
  id: string,
  local: ClaudeSettingsState,
  project: ClaudeSettingsState,
  user: ClaudeSettingsState
): ClaudeSettingResolution {
  for (const scope of [local, project, user]) {
    if (scope.kind === "invalid" || scope.kind === "unreadable") {
      return { kind: "unknown" };
    }
    if (scope.kind === "valid" && scope.entries.has(id)) {
      const value = scope.entries.get(id);
      return typeof value === "boolean"
        ? { kind: "known", value }
        : { kind: "unknown" };
    }
  }
  return { kind: "absent" };
}
