import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  appendIntegrationRecord,
  latestIntegrationRecord,
  type IntegrationRecord
} from "@skill-steward/store";
import {
  integrationHarnessSchema,
  type IntegrationHarness
} from "./domain.js";

export type IntegrationErrorCode =
  | "INTEGRATION_CONFIG_INVALID"
  | "INTEGRATION_DUPLICATE"
  | "INTEGRATION_DRIFTED"
  | "INTEGRATION_NOT_INSTALLED"
  | "INTEGRATION_UNSAFE_PATH";

export class IntegrationError extends Error {
  constructor(public readonly code: IntegrationErrorCode, message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

type JsonObject = Record<string, unknown>;

export interface IntegrationChange {
  operation: "backup" | "write";
  path: string;
}

export interface IntegrationPlan {
  id: string;
  harness: IntegrationHarness;
  targetPath: string;
  backupPath?: string;
  expectedBeforeFingerprint: string;
  afterConfig: JsonObject;
  afterFingerprint: string;
  installedEntryFingerprint: string;
  changes: IntegrationChange[];
  createdAt: string;
}

export type IntegrationStatusValue =
  | "not-installed"
  | "installed"
  | "needs-trust"
  | "drifted"
  | "invalid";

export interface IntegrationStatus {
  harness: IntegrationHarness;
  status: IntegrationStatusValue;
  targetPath: string;
  lastChangedAt?: string;
  message?: string;
}

export interface IntegrationConfigOptions {
  home: string;
  stateDirectory: string;
  now?: () => Date;
  id?: () => string;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function integrationTarget(harness: IntegrationHarness, home: string): string {
  return harness === "codex"
    ? resolve(home, ".codex", "hooks.json")
    : resolve(home, ".claude", "settings.json");
}

async function assertSafeTarget(targetPath: string, home: string): Promise<void> {
  const homePath = resolve(home);
  if (!targetPath.startsWith(`${homePath}${sep}`)) {
    throw new IntegrationError(
      "INTEGRATION_UNSAFE_PATH",
      "Harness configuration path escapes the requested home directory"
    );
  }
  try {
    const metadata = await lstat(targetPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new IntegrationError(
        "INTEGRATION_UNSAFE_PATH",
        "Harness configuration target must be a regular file"
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const [physicalHome, physicalParent] = await Promise.all([
      realpath(homePath),
      realpath(dirname(targetPath))
    ]);
    if (
      physicalParent !== physicalHome &&
      !physicalParent.startsWith(`${physicalHome}${sep}`)
    ) {
      throw new IntegrationError(
        "INTEGRATION_UNSAFE_PATH",
        "Harness configuration parent resolves outside the requested home directory"
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function parseConfig(source: string): JsonObject {
  try {
    const value: unknown = JSON.parse(source);
    if (!isObject(value)) throw new Error("Configuration root must be an object");
    return value;
  } catch (error) {
    throw new IntegrationError(
      "INTEGRATION_CONFIG_INVALID",
      error instanceof Error ? error.message : "Harness configuration is invalid"
    );
  }
}

async function readConfig(targetPath: string): Promise<{
  exists: boolean;
  source: string;
  fingerprint: string;
  config: JsonObject;
}> {
  try {
    const source = await readFile(targetPath, "utf8");
    return { exists: true, source, fingerprint: hash(source), config: parseConfig(source) };
  } catch (error) {
    if (isMissing(error)) {
      return { exists: false, source: "", fingerprint: hash(""), config: {} };
    }
    throw error;
  }
}

function commandFor(harness: IntegrationHarness): string {
  return `skill-steward hook prompt --harness ${harness}`;
}

function managedGroup(harness: IntegrationHarness): JsonObject {
  return {
    hooks: [{
      type: "command",
      command: commandFor(harness),
      timeout: harness === "codex" ? 0.75 : 1,
      statusMessage: "Running Skill Steward preflight"
    }]
  };
}

function eventGroups(config: JsonObject): unknown[] {
  const hooks = config.hooks;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) {
    throw new IntegrationError("INTEGRATION_CONFIG_INVALID", "Configuration hooks must be an object");
  }
  const groups = hooks.UserPromptSubmit;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new IntegrationError(
      "INTEGRATION_CONFIG_INVALID",
      "UserPromptSubmit hooks must be an array"
    );
  }
  return groups;
}

function hasManagedCommand(value: unknown, harness: IntegrationHarness): boolean {
  if (!isObject(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) =>
    isObject(hook) && hook.type === "command" && hook.command === commandFor(harness)
  );
}

function managedGroups(config: JsonObject, harness: IntegrationHarness): JsonObject[] {
  return eventGroups(config).filter((group): group is JsonObject =>
    isObject(group) && hasManagedCommand(group, harness)
  );
}

function mergeManagedGroup(config: JsonObject, harness: IntegrationHarness): JsonObject {
  const currentGroups = eventGroups(config);
  const hooks = config.hooks === undefined ? {} : config.hooks as JsonObject;
  return {
    ...config,
    hooks: {
      ...hooks,
      UserPromptSubmit: [...currentGroups, managedGroup(harness)]
    }
  };
}

function removeManagedGroup(config: JsonObject, harness: IntegrationHarness): JsonObject {
  const currentGroups = eventGroups(config);
  const hooks = config.hooks as JsonObject;
  const remaining = currentGroups.filter((group) => !hasManagedCommand(group, harness));
  const nextHooks = { ...hooks };
  if (remaining.length > 0) nextHooks.UserPromptSubmit = remaining;
  else delete nextHooks.UserPromptSubmit;
  return { ...config, hooks: nextHooks };
}

function backupPath(targetPath: string, now: Date, discriminator: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeDiscriminator = discriminator.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${targetPath}.skill-steward-${stamp}-${safeDiscriminator}.bak`;
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function writeBackup(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function planIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationPlan> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  await assertSafeTarget(targetPath, options.home);
  const before = await readConfig(targetPath);
  const existing = managedGroups(before.config, harness);
  if (existing.length > 1) {
    throw new IntegrationError(
      "INTEGRATION_DUPLICATE",
      "Harness configuration contains duplicate Skill Steward hooks"
    );
  }
  const afterConfig = existing.length === 1
    ? before.config
    : mergeManagedGroup(before.config, harness);
  const afterSource = stableJson(afterConfig);
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const path = before.exists && existing.length === 0
    ? backupPath(targetPath, now, id)
    : undefined;
  return {
    id,
    harness,
    targetPath,
    ...(path ? { backupPath: path } : {}),
    expectedBeforeFingerprint: before.fingerprint,
    afterConfig,
    afterFingerprint: hash(afterSource),
    installedEntryFingerprint: hash(stableJson(managedGroup(harness))),
    changes: existing.length === 1
      ? []
      : [
          ...(path ? [{ operation: "backup" as const, path: targetPath }] : []),
          { operation: "write" as const, path: targetPath }
        ],
    createdAt: now.toISOString()
  };
}

export async function applyIntegrationPlan(
  plan: IntegrationPlan,
  options: IntegrationConfigOptions
): Promise<IntegrationRecord> {
  const harness = integrationHarnessSchema.parse(plan.harness);
  const expectedTarget = integrationTarget(harness, options.home);
  if (plan.targetPath !== expectedTarget) {
    throw new IntegrationError("INTEGRATION_UNSAFE_PATH", "Integration plan target is invalid");
  }
  await assertSafeTarget(plan.targetPath, options.home);
  const before = await readConfig(plan.targetPath);
  if (before.fingerprint !== plan.expectedBeforeFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Harness configuration changed after the integration plan was created"
    );
  }
  const afterSource = stableJson(plan.afterConfig);
  if (hash(afterSource) !== plan.afterFingerprint) {
    throw new IntegrationError("INTEGRATION_DRIFTED", "Integration plan content changed");
  }
  if (plan.backupPath && before.exists && plan.changes.length > 0) {
    await writeBackup(plan.backupPath, before.source);
  }
  if (plan.changes.length > 0) await atomicWrite(plan.targetPath, afterSource);
  const record: IntegrationRecord = {
    schemaVersion: 1,
    id: plan.id,
    harness,
    action: "apply",
    status: "installed",
    targetPath: plan.targetPath,
    ...(plan.backupPath ? { backupPath: plan.backupPath } : {}),
    beforeFingerprint: before.fingerprint,
    afterFingerprint: plan.afterFingerprint,
    installedEntryFingerprint: plan.installedEntryFingerprint,
    createdAt: (options.now?.() ?? new Date()).toISOString()
  };
  await appendIntegrationRecord(options.stateDirectory, record);
  return record;
}

export async function integrationStatus(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationStatus> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  const latest = await latestIntegrationRecord(options.stateDirectory, harness);
  try {
    await assertSafeTarget(targetPath, options.home);
    const current = await readConfig(targetPath);
    const groups = managedGroups(current.config, harness);
    if (groups.length > 1) {
      return { harness, status: "drifted", targetPath, message: "Duplicate managed hooks" };
    }
    if (groups.length === 1) {
      return {
        harness,
        status: harness === "codex" ? "needs-trust" : "installed",
        targetPath,
        ...(latest ? { lastChangedAt: latest.createdAt } : {})
      };
    }
    if (latest?.status === "installed") {
      return {
        harness,
        status: "drifted",
        targetPath,
        lastChangedAt: latest.createdAt,
        message: "The recorded Skill Steward hook is missing or changed"
      };
    }
    return {
      harness,
      status: "not-installed",
      targetPath,
      ...(latest ? { lastChangedAt: latest.createdAt } : {})
    };
  } catch (error) {
    if (error instanceof IntegrationError) {
      return {
        harness,
        status: "invalid",
        targetPath,
        message: error.message,
        ...(latest ? { lastChangedAt: latest.createdAt } : {})
      };
    }
    throw error;
  }
}

export async function removeIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationRecord> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  await assertSafeTarget(targetPath, options.home);
  const latest = await latestIntegrationRecord(options.stateDirectory, harness);
  if (!latest || latest.status !== "installed") {
    throw new IntegrationError(
      "INTEGRATION_NOT_INSTALLED",
      "No installed Skill Steward integration record was found"
    );
  }
  const before = await readConfig(targetPath);
  const groups = managedGroups(before.config, harness);
  if (
    groups.length !== 1 ||
    hash(stableJson(groups[0])) !== latest.installedEntryFingerprint
  ) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Skill Steward hook changed since installation; removal was not applied"
    );
  }
  const afterConfig = removeManagedGroup(before.config, harness);
  const afterSource = stableJson(afterConfig);
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const path = backupPath(targetPath, now, `${id}-remove`);
  await writeBackup(path, before.source);
  await atomicWrite(targetPath, afterSource);
  const record: IntegrationRecord = {
    schemaVersion: 1,
    id,
    harness,
    action: "remove",
    status: "removed",
    targetPath,
    backupPath: path,
    beforeFingerprint: before.fingerprint,
    afterFingerprint: hash(afterSource),
    installedEntryFingerprint: latest.installedEntryFingerprint,
    createdAt: now.toISOString()
  };
  await appendIntegrationRecord(options.stateDirectory, record);
  return record;
}
