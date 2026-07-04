import { lstat } from "node:fs/promises";
import { readJsonObject, readJsoncObject } from "../metadata.js";
import { BoundedSmallestStrings, compareCodeUnits } from "../selection.js";

export type CopilotMetadataKind =
  | "valid"
  | "missing"
  | "invalid"
  | "truncated"
  | "unreadable";

export interface CopilotSettingsState {
  kind: CopilotMetadataKind;
  path: string;
  enabledPlugins: Map<string, boolean | undefined>;
  disabledSkills?: string[];
  skillDirectories?: string[];
  diagnosticCode?: string;
}

export interface CopilotManagedState {
  kind: CopilotMetadataKind;
  path: string;
  installedPlugins: Map<string, boolean | undefined>;
  diagnosticCode?: string;
}

export type CopilotResolvedBoolean =
  | { kind: "known"; value: boolean }
  | { kind: "absent" }
  | { kind: "unknown" };

export interface CopilotSettingsTier {
  native: CopilotSettingsState;
  shared?: CopilotSettingsState;
}

export type CopilotSettingsScope = "user" | "enabled-only";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function missingOrUnreadable(
  path: string
): Promise<"missing" | "unreadable" | "present"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

function exactStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 1_000) {
    throw Object.assign(new Error("too many disabled Skill names"), {
      code: "COPILOT_SETTINGS_TRUNCATED"
    });
  }
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return undefined;
  }
  return [...new Set(value as string[])].sort(compareCodeUnits);
}

function exactDirectoryArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 1_000) {
    throw Object.assign(new Error("too many custom Skill directories"), {
      code: "COPILOT_SETTINGS_TRUNCATED"
    });
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return undefined;
    normalized.push(trimmed);
  }
  return [...new Set(normalized)].sort(compareCodeUnits);
}

export async function readCopilotSettings(
  path: string,
  maxPluginEntries = 100,
  scope: CopilotSettingsScope = "enabled-only"
): Promise<CopilotSettingsState> {
  try {
    const value = await readJsoncObject(path);
    const configured = value.enabledPlugins;
    const disabled = scope === "user" ? value.disabledSkills : undefined;
    const skillDirectories = scope === "user" ? value.skillDirectories : undefined;
    if (
      configured !== undefined &&
      (typeof configured !== "object" || configured === null ||
        Array.isArray(configured))
    ) {
      return {
        kind: "invalid",
        path,
        enabledPlugins: new Map(),
        diagnosticCode: "COPILOT_SETTINGS_INVALID"
      };
    }
    const enabledPlugins = new Map<string, boolean | undefined>();
    let invalidEntry = false;
    let selectedTruncated = false;
    if (configured) {
      const selected = new BoundedSmallestStrings(maxPluginEntries);
      for (const id of Object.keys(configured)) selected.add(id);
      for (const id of selected.values()) {
        const entry = (configured as Record<string, unknown>)[id];
        enabledPlugins.set(id, typeof entry === "boolean" ? entry : undefined);
        if (typeof entry !== "boolean") invalidEntry = true;
      }
      selectedTruncated = selected.truncated;
    }
    let disabledSkills: string[] | undefined;
    let customDirectories: string[] | undefined;
    try {
      disabledSkills = disabled === undefined
        ? undefined
        : exactStringArray(disabled);
      customDirectories = skillDirectories === undefined
        ? undefined
        : exactDirectoryArray(skillDirectories);
    } catch {
      return {
        kind: "truncated",
        path,
        enabledPlugins,
        diagnosticCode: "COPILOT_SETTINGS_TRUNCATED"
      };
    }
    if (disabled !== undefined && disabledSkills === undefined) {
      return {
        kind: "invalid",
        path,
        enabledPlugins,
        diagnosticCode: "COPILOT_SETTINGS_INVALID"
      };
    }
    if (skillDirectories !== undefined && customDirectories === undefined) {
      return {
        kind: "invalid",
        path,
        enabledPlugins,
        diagnosticCode: "COPILOT_SETTINGS_INVALID"
      };
    }
    if (selectedTruncated) {
      return {
        kind: "truncated",
        path,
        enabledPlugins,
        ...(disabledSkills ? { disabledSkills } : {}),
        ...(customDirectories ? { skillDirectories: customDirectories } : {}),
        diagnosticCode: "COPILOT_PLUGIN_LIMIT"
      };
    }
    if (invalidEntry) {
      return {
        kind: "invalid",
        path,
        enabledPlugins,
        ...(disabledSkills ? { disabledSkills } : {}),
        ...(customDirectories ? { skillDirectories: customDirectories } : {}),
        diagnosticCode: "COPILOT_SETTINGS_INVALID"
      };
    }
    return {
      kind: "valid",
      path,
      enabledPlugins,
      ...(disabledSkills ? { disabledSkills } : {}),
      ...(customDirectories ? { skillDirectories: customDirectories } : {})
    };
  } catch (error) {
    const state = await missingOrUnreadable(path);
    if (state === "missing") {
      return { kind: state, path, enabledPlugins: new Map() };
    }
    const code = errorCode(error);
    const unreadable = state === "unreadable" || code === "METADATA_UNREADABLE";
    const truncated = code === "COPILOT_SETTINGS_TRUNCATED" ||
      code === "METADATA_TOO_LARGE";
    return {
      kind: unreadable ? "unreadable" : truncated ? "truncated" : "invalid",
      path,
      enabledPlugins: new Map(),
      diagnosticCode: unreadable
        ? "METADATA_UNREADABLE"
        : code ?? "COPILOT_SETTINGS_INVALID"
    };
  }
}

export async function readCopilotManagedState(
  path: string,
  maxPluginEntries = 100
): Promise<CopilotManagedState> {
  try {
    // Deliberately recognize only the repository's versioned fixture shape.
    // config.json is internal Copilot state; unknown shapes must remain ambiguous.
    const value = await readJsonObject(path);
    const rootKeys = Object.keys(value).sort(compareCodeUnits);
    const rootInvalid = rootKeys.length !== 2 ||
      rootKeys[0] !== "installedPlugins" || rootKeys[1] !== "version" ||
      value.version !== 1;
    if (typeof value.installedPlugins !== "object" ||
      value.installedPlugins === null || Array.isArray(value.installedPlugins)) {
      return {
        kind: "invalid",
        path,
        installedPlugins: new Map(),
        diagnosticCode: "COPILOT_CONFIG_INVALID"
      };
    }
    const installedPlugins = new Map<string, boolean | undefined>();
    const selected = new BoundedSmallestStrings(maxPluginEntries);
    for (const id of Object.keys(value.installedPlugins)) selected.add(id);
    let invalidRecord = false;
    for (const id of selected.values()) {
      const record = (value.installedPlugins as Record<string, unknown>)[id];
      if (
        typeof record !== "object" || record === null || Array.isArray(record) ||
        Object.keys(record).length !== 1 ||
        typeof (record as Record<string, unknown>).enabled !== "boolean"
      ) {
        installedPlugins.set(id, undefined);
        invalidRecord = true;
        continue;
      }
      installedPlugins.set(
        id,
        (record as { enabled: boolean }).enabled
      );
    }
    if (selected.truncated) {
      return {
        kind: "truncated",
        path,
        installedPlugins,
        diagnosticCode: "COPILOT_PLUGIN_LIMIT"
      };
    }
    if (rootInvalid || invalidRecord) {
      return {
        kind: "invalid",
        path,
        installedPlugins,
        diagnosticCode: "COPILOT_CONFIG_INVALID"
      };
    }
    return { kind: "valid", path, installedPlugins };
  } catch (error) {
    const state = await missingOrUnreadable(path);
    if (state === "missing") {
      return { kind: state, path, installedPlugins: new Map() };
    }
    const code = errorCode(error);
    const unreadable = state === "unreadable" || code === "METADATA_UNREADABLE";
    const truncated = code === "METADATA_TOO_LARGE";
    return {
      kind: unreadable ? "unreadable" : truncated ? "truncated" : "invalid",
      path,
      installedPlugins: new Map(),
      diagnosticCode: unreadable
        ? "METADATA_UNREADABLE"
        : code ?? "COPILOT_CONFIG_INVALID"
    };
  }
}

function tierBoolean(
  id: string,
  tier: CopilotSettingsTier
): CopilotResolvedBoolean {
  const states = tier.shared ? [tier.native, tier.shared] : [tier.native];
  if (states.some(({ kind }) =>
    kind === "invalid" || kind === "unreadable" || kind === "truncated"
  )) {
    return { kind: "unknown" };
  }
  const values = states.flatMap((state) => {
    if (state.kind !== "valid" || !state.enabledPlugins.has(id)) return [];
    const value = state.enabledPlugins.get(id);
    return typeof value === "boolean" ? [value] : [undefined];
  });
  if (values.length === 0) return { kind: "absent" };
  if (values.some((value) => value === undefined) ||
    new Set(values).size !== 1) {
    return { kind: "unknown" };
  }
  return { kind: "known", value: values[0] as boolean };
}

export function resolveCopilotEnabledPlugin(
  id: string,
  tiersLowToHigh: readonly CopilotSettingsTier[]
): CopilotResolvedBoolean {
  for (const tier of [...tiersLowToHigh].reverse()) {
    const resolved = tierBoolean(id, tier);
    if (resolved.kind !== "absent") return resolved;
  }
  return { kind: "absent" };
}

export function resolveCopilotDisabledSkills(
  user: CopilotSettingsState
): { status: "known"; names: string[] } | { status: "ambiguous" } {
  if (
    user.kind === "invalid" || user.kind === "unreadable" ||
    user.kind === "truncated"
  ) {
    return { status: "ambiguous" };
  }
  return { status: "known", names: user.disabledSkills ?? [] };
}
