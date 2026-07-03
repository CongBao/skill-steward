import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import {
  appendIntegrationRecord,
  latestIntegrationRecord,
  type IntegrationRecord
} from "@skill-steward/store";
import {
  integrationHarnessSchema,
  type IntegrationHarness
} from "./domain.js";
import { copilotHookConfig, copilotHookTarget } from "./config-adapters.js";

export type IntegrationErrorCode =
  | "INTEGRATION_CONFIG_INVALID"
  | "INTEGRATION_DUPLICATE"
  | "INTEGRATION_DRIFTED"
  | "INTEGRATION_NOT_INSTALLED"
  | "INTEGRATION_PLAN_EXPIRED"
  | "INTEGRATION_PLAN_INVALID"
  | "INTEGRATION_ROLLBACK_FAILED"
  | "INTEGRATION_UNSAFE_PATH";

export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IntegrationError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function journalCommitIsUncertain(error: unknown): boolean {
  return errorCode(error) === "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN";
}

function uncertainJournalError(error: unknown, action: "apply" | "remove"): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_ROLLBACK_FAILED",
    `Integration ${action} reached journal publication, but commit could not be proven; configuration was retained to avoid contradicting a possibly committed record`,
    { cause: error }
  );
}

export async function rethrowAfterIntegrationApplyFailure(input: {
  error: unknown;
  companionCreated: boolean;
  removeCompanion: () => Promise<boolean>;
}): Promise<never> {
  if (
    !input.companionCreated
    || errorCode(input.error) === "INTEGRATION_ROLLBACK_FAILED"
  ) throw input.error;

  let removed = false;
  try {
    removed = await input.removeCompanion();
  } catch (error) {
    const original = input.error instanceof Error ? input.error.message : String(input.error);
    const cleanupFailure = error instanceof Error ? error.message : String(error);
    throw new IntegrationError(
      "INTEGRATION_ROLLBACK_FAILED",
      `Integration apply failed (${original}) and its newly created companion Skill could not be removed (${cleanupFailure}). Inspect integration status before retrying.`,
      { cause: input.error }
    );
  }
  if (removed) throw input.error;
  const original = input.error instanceof Error ? input.error.message : String(input.error);
  throw new IntegrationError(
    "INTEGRATION_ROLLBACK_FAILED",
    `Integration apply failed (${original}) and its newly created companion Skill could not be removed because it changed before cleanup. Inspect integration status before retrying.`,
    { cause: input.error }
  );
}

type JsonObject = Record<string, unknown>;

export interface IntegrationChange {
  operation: "backup" | "write";
  path: string;
}

const INTEGRATION_PLAN_TTL_MS = 10 * 60_000;
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const normalizedAbsolutePathSchema = z.string().min(1).refine(
  (path) => isAbsolute(path) && normalize(path) === path,
  "Path must be absolute and normalized"
);

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !("value" in descriptor)
          || !isJsonValue(descriptor.value, ancestors)
        ) return false;
      }
      return Reflect.ownKeys(value).every((key) =>
        key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key))
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return descriptor !== undefined
        && descriptor.enumerable === true
        && "value" in descriptor
        && isJsonValue(descriptor.value, ancestors);
    });
  } finally {
    ancestors.delete(value);
  }
}

const integrationChangeSchema = z.object({
  operation: z.enum(["backup", "write"]),
  path: normalizedAbsolutePathSchema
}).strict();

export const integrationPlanSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  harness: integrationHarnessSchema,
  targetPath: normalizedAbsolutePathSchema,
  backupPath: normalizedAbsolutePathSchema.optional(),
  expectedBeforeFingerprint: fingerprintSchema,
  afterConfig: z.custom<JsonObject>(
    (value) => isObject(value) && isJsonValue(value),
    "afterConfig must be a JSON object"
  ),
  afterFingerprint: fingerprintSchema,
  installedEntryFingerprint: fingerprintSchema,
  changes: z.array(integrationChangeSchema).max(2),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().superRefine((plan, context) => {
  const createdAt = Date.parse(plan.createdAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (expiresAt - createdAt !== INTEGRATION_PLAN_TTL_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Integration plan must expire ten minutes after creation"
    });
  }
  const expectedChanges: IntegrationChange[] = plan.changes.length === 0
    ? []
    : plan.backupPath
      ? [
          { operation: "backup", path: plan.targetPath },
          { operation: "write", path: plan.targetPath }
        ]
      : [{ operation: "write", path: plan.targetPath }];
  if (JSON.stringify(plan.changes) !== JSON.stringify(expectedChanges)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["changes"],
      message: "Integration plan changes are inconsistent"
    });
  }
  if (plan.changes.length === 0 && plan.backupPath !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["backupPath"],
      message: "No-op integration plans cannot create backups"
    });
  }
});

export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;

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

export interface IntegrationConfigDependencies {
  appendRecord: typeof appendIntegrationRecord;
}

const integrationConfigDefaults: IntegrationConfigDependencies = {
  appendRecord: appendIntegrationRecord
};

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (isObject(entry)) {
      return Object.fromEntries(
        Object.keys(entry).sort().map((key) => [key, canonicalize(entry[key])])
      );
    }
    return entry;
  };
  return JSON.stringify(canonicalize(value));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function integrationTarget(harness: IntegrationHarness, home: string): string {
  if (harness === "codex") return resolve(home, ".codex", "hooks.json");
  if (harness === "claude-code") return resolve(home, ".claude", "settings.json");
  return copilotHookTarget(home);
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
  const physicalHome = await realpath(homePath);
  const relativeParent = dirname(targetPath).slice(homePath.length + 1);
  let current = homePath;
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new IntegrationError(
          "INTEGRATION_UNSAFE_PATH",
          "Harness configuration ancestors must be physical directories"
        );
      }
      const physicalCurrent = await realpath(current);
      if (
        physicalCurrent !== physicalHome
        && !physicalCurrent.startsWith(`${physicalHome}${sep}`)
      ) {
        throw new IntegrationError(
          "INTEGRATION_UNSAFE_PATH",
          "Harness configuration ancestor resolves outside the requested home directory"
        );
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  try {
    const physicalParent = await realpath(dirname(targetPath));
    if (physicalParent !== physicalHome && !physicalParent.startsWith(`${physicalHome}${sep}`)) {
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

type ManagedEvent = "UserPromptSubmit" | "Stop" | "SessionEnd";

function managedEvents(harness: IntegrationHarness): ManagedEvent[] {
  if (harness === "codex") return ["UserPromptSubmit", "Stop"];
  if (harness === "claude-code") return ["UserPromptSubmit", "Stop", "SessionEnd"];
  return [];
}

function commandFor(harness: IntegrationHarness, event: ManagedEvent): string {
  const action = event === "UserPromptSubmit" ? "prompt" : "lifecycle";
  return `skill-steward hook ${action} --harness ${harness}`;
}

function managedGroup(harness: IntegrationHarness, event: ManagedEvent): JsonObject {
  return {
    hooks: [{
      type: "command",
      command: commandFor(harness, event),
      timeout: harness === "codex" ? 0.75 : 1,
      statusMessage: event === "UserPromptSubmit"
        ? "Running Skill Steward preflight"
        : "Recording Skill Steward lifecycle evidence"
    }]
  };
}

function eventGroups(config: JsonObject, event: ManagedEvent): unknown[] {
  const hooks = config.hooks;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) {
    throw new IntegrationError("INTEGRATION_CONFIG_INVALID", "Configuration hooks must be an object");
  }
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new IntegrationError(
      "INTEGRATION_CONFIG_INVALID",
      `${event} hooks must be an array`
    );
  }
  return groups;
}

function hasManagedCommand(
  value: unknown,
  harness: IntegrationHarness,
  event: ManagedEvent
): boolean {
  if (!isObject(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) =>
    isObject(hook)
    && hook.type === "command"
    && hook.command === commandFor(harness, event)
  );
}

function managedGroups(
  config: JsonObject,
  harness: IntegrationHarness,
  event: ManagedEvent
): JsonObject[] {
  return eventGroups(config, event).filter((group): group is JsonObject =>
    isObject(group) && hasManagedCommand(group, harness, event)
  );
}

function mergeManagedGroup(
  config: JsonObject,
  harness: IntegrationHarness,
  event: ManagedEvent
): JsonObject {
  const currentGroups = eventGroups(config, event);
  const hooks = config.hooks === undefined ? {} : config.hooks as JsonObject;
  return {
    ...config,
    hooks: {
      ...hooks,
      [event]: [...currentGroups, managedGroup(harness, event)]
    }
  };
}

function removeManagedGroup(
  config: JsonObject,
  harness: IntegrationHarness,
  event: ManagedEvent
): JsonObject {
  const currentGroups = eventGroups(config, event);
  const hooks = config.hooks as JsonObject;
  const remaining = currentGroups.filter((group) => !hasManagedCommand(group, harness, event));
  const nextHooks = { ...hooks };
  if (remaining.length > 0) nextHooks[event] = remaining;
  else delete nextHooks[event];
  return { ...config, hooks: nextHooks };
}

function managedBundle(harness: IntegrationHarness): Array<{
  event: ManagedEvent;
  group: JsonObject;
}> {
  return managedEvents(harness).map((event) => ({
    event,
    group: managedGroup(harness, event)
  }));
}

function installedBundle(config: JsonObject, harness: IntegrationHarness): Array<{
  event: ManagedEvent;
  group: JsonObject;
}> {
  return managedEvents(harness).flatMap((event) =>
    managedGroups(config, harness, event).map((group) => ({ event, group }))
  );
}

function bundleFingerprint(bundle: Array<{ event: ManagedEvent; group: JsonObject }>): string {
  return hash(stableJson(bundle));
}

function backupPath(targetPath: string, now: Date, discriminator: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeDiscriminator = discriminator.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${targetPath}.skill-steward-${stamp}-${safeDiscriminator}.bak`;
}

async function atomicWrite(path: string, source: string, home: string): Promise<void> {
  await assertSafeTarget(path, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeTarget(path, home);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function writeBackup(path: string, source: string, home: string): Promise<void> {
  await assertSafeTarget(path, home);
  await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function restoreIntegrationTarget(plan: IntegrationPlan, home: string): Promise<void> {
  await assertSafeTarget(plan.targetPath, home);
  const current = await readConfig(plan.targetPath);
  if (!current.exists || current.fingerprint !== plan.afterFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Harness configuration changed after integration apply; rollback was not applied"
    );
  }
  if (plan.backupPath) {
    const expectedBackup = backupPath(
      plan.targetPath,
      new Date(plan.createdAt),
      plan.id
    );
    if (plan.backupPath !== expectedBackup) {
      throw new IntegrationError(
        "INTEGRATION_UNSAFE_PATH",
        "Integration backup target is invalid"
      );
    }
    const backupSource = await readFile(plan.backupPath, "utf8");
    if (hash(backupSource) !== plan.expectedBeforeFingerprint) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "Integration backup changed before rollback"
      );
    }
    await atomicWrite(plan.targetPath, backupSource, home);
    await unlink(plan.backupPath);
    return;
  }
  if (plan.expectedBeforeFingerprint !== hash("")) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Integration rollback is missing its reviewed backup"
    );
  }
  await unlink(plan.targetPath);
}

export async function planIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationPlan> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  await assertSafeTarget(targetPath, options.home);
  const before = await readConfig(targetPath);
  if (harness === "github-copilot") {
    const afterConfig = copilotHookConfig();
    const afterSource = stableJson(afterConfig);
    const afterFingerprint = hash(afterSource);
    if (before.exists && before.fingerprint !== afterFingerprint) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "The dedicated Copilot Hook file already exists with different content"
      );
    }
    const now = options.now?.() ?? new Date();
    return {
      id: options.id?.() ?? randomUUID(),
      harness,
      targetPath,
      expectedBeforeFingerprint: before.fingerprint,
      afterConfig,
      afterFingerprint,
      installedEntryFingerprint: afterFingerprint,
      changes: before.exists ? [] : [{ operation: "write", path: targetPath }],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INTEGRATION_PLAN_TTL_MS).toISOString()
    };
  }
  const existingByEvent = managedEvents(harness).map((event) => ({
    event,
    groups: managedGroups(before.config, harness, event)
  }));
  if (existingByEvent.some(({ groups }) => groups.length > 1)) {
    throw new IntegrationError(
      "INTEGRATION_DUPLICATE",
      "Harness configuration contains duplicate Skill Steward hooks"
    );
  }
  if (existingByEvent.some(({ event, groups }) =>
    groups.length === 1
    && canonicalJson(groups[0]) !== canonicalJson(managedGroup(harness, event))
  )) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Harness configuration contains a non-canonical Skill Steward Hook group"
    );
  }
  const fullyInstalled = existingByEvent.every(({ groups }) => groups.length === 1);
  const afterConfig = existingByEvent.reduce(
    (config, { event, groups }) => groups.length === 0
      ? mergeManagedGroup(config, harness, event)
      : config,
    before.config
  );
  const afterSource = stableJson(afterConfig);
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const path = before.exists && !fullyInstalled
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
    installedEntryFingerprint: bundleFingerprint(managedBundle(harness)),
    changes: fullyInstalled
      ? []
      : [
          ...(path ? [{ operation: "backup" as const, path: targetPath }] : []),
          { operation: "write" as const, path: targetPath }
        ],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INTEGRATION_PLAN_TTL_MS).toISOString()
  };
}

export async function applyIntegrationPlan(
  inputPlan: unknown,
  options: IntegrationConfigOptions,
  dependencyOverrides: Partial<IntegrationConfigDependencies> = {}
): Promise<IntegrationRecord> {
  const dependencies = { ...integrationConfigDefaults, ...dependencyOverrides };
  const parsedPlan = integrationPlanSchema.safeParse(inputPlan);
  if (!parsedPlan.success) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Integration plan failed strict domain validation"
    );
  }
  const plan = parsedPlan.data;
  const now = options.now?.() ?? new Date();
  if (now.getTime() >= Date.parse(plan.expiresAt)) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_EXPIRED",
      "Integration plan has expired"
    );
  }
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
  const expectedConfig = harness === "github-copilot"
    ? copilotHookConfig()
    : managedEvents(harness).reduce(
        (config, event) => managedGroups(config, harness, event).length === 0
          ? mergeManagedGroup(config, harness, event)
          : config,
        before.config
      );
  const afterSource = stableJson(plan.afterConfig);
  if (afterSource !== stableJson(expectedConfig)) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Integration plan configuration does not match its Harness target"
    );
  }
  if (hash(afterSource) !== plan.afterFingerprint) {
    throw new IntegrationError("INTEGRATION_DRIFTED", "Integration plan content changed");
  }
  const expectedInstalledFingerprint = harness === "github-copilot"
    ? plan.afterFingerprint
    : bundleFingerprint(managedBundle(harness));
  if (plan.installedEntryFingerprint !== expectedInstalledFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Integration plan managed entry fingerprint changed"
    );
  }
  const fullyInstalled = harness === "github-copilot"
    ? before.exists
    : managedEvents(harness).every((event) => managedGroups(before.config, harness, event).length === 1);
  const expectedBackupPath = harness !== "github-copilot" && before.exists && !fullyInstalled
    ? backupPath(plan.targetPath, new Date(plan.createdAt), plan.id)
    : undefined;
  if (plan.backupPath !== expectedBackupPath) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Integration plan backup target changed"
    );
  }
  const expectedChanges: IntegrationChange[] = fullyInstalled
    ? []
    : [
        ...(expectedBackupPath
          ? [{ operation: "backup" as const, path: plan.targetPath }]
          : []),
        { operation: "write" as const, path: plan.targetPath }
      ];
  if (JSON.stringify(plan.changes) !== JSON.stringify(expectedChanges)) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Integration plan operation list changed"
    );
  }
  if (plan.backupPath && before.exists && plan.changes.length > 0) {
    await writeBackup(plan.backupPath, before.source, options.home);
  }
  if (plan.changes.length > 0) await atomicWrite(plan.targetPath, afterSource, options.home);
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
    createdAt: now.toISOString()
  };
  try {
    await dependencies.appendRecord(options.stateDirectory, record);
  } catch (error) {
    if (journalCommitIsUncertain(error)) throw uncertainJournalError(error, "apply");
    if (plan.changes.length > 0) {
      try {
        await restoreIntegrationTarget(plan, options.home);
      } catch (rollbackError) {
        throw new IntegrationError(
          "INTEGRATION_ROLLBACK_FAILED",
          `Integration configuration was written, its journal failed, and rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          {
            cause: new AggregateError(
              [error, rollbackError],
              "Integration journal commit and configuration rollback both failed"
            )
          }
        );
      }
    }
    throw error;
  }
  return record;
}

export async function rollbackIntegrationPlan(
  inputPlan: unknown,
  options: IntegrationConfigOptions,
  dependencyOverrides: Partial<IntegrationConfigDependencies> = {}
): Promise<IntegrationRecord> {
  const dependencies = { ...integrationConfigDefaults, ...dependencyOverrides };
  const parsedPlan = integrationPlanSchema.safeParse(inputPlan);
  if (!parsedPlan.success) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Integration rollback plan failed strict domain validation"
    );
  }
  const plan = parsedPlan.data;
  if (plan.changes.length === 0) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "No-op integration plans have no configuration to roll back"
    );
  }
  const expectedTarget = integrationTarget(plan.harness, options.home);
  if (plan.targetPath !== expectedTarget) {
    throw new IntegrationError("INTEGRATION_UNSAFE_PATH", "Integration plan target is invalid");
  }
  await assertSafeTarget(plan.targetPath, options.home);
  await restoreIntegrationTarget(plan, options.home);
  const now = options.now?.() ?? new Date();
  const record: IntegrationRecord = {
    schemaVersion: 1,
    id: options.id?.() ?? randomUUID(),
    harness: plan.harness,
    action: "remove",
    status: "removed",
    targetPath: plan.targetPath,
    beforeFingerprint: plan.afterFingerprint,
    afterFingerprint: plan.expectedBeforeFingerprint,
    installedEntryFingerprint: plan.installedEntryFingerprint,
    createdAt: now.toISOString()
  };
  try {
    await dependencies.appendRecord(options.stateDirectory, record);
  } catch (error) {
    if (journalCommitIsUncertain(error)) throw uncertainJournalError(error, "remove");
    try {
      await atomicWrite(plan.targetPath, stableJson(plan.afterConfig), options.home);
    } catch (compensationError) {
      throw new IntegrationError(
        "INTEGRATION_ROLLBACK_FAILED",
        `Integration rollback could not journal removal or restore the installed configuration: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
        {
          cause: new AggregateError(
            [error, compensationError],
            "Integration rollback journal and installed-configuration compensation both failed"
          )
        }
      );
    }
    throw new IntegrationError(
      "INTEGRATION_ROLLBACK_FAILED",
      "Integration rollback could not journal removal; the installed configuration was restored to match the retained record",
      { cause: error }
    );
  }
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
    if (harness === "github-copilot") {
      const expectedFingerprint = hash(stableJson(copilotHookConfig()));
      if (current.exists && current.fingerprint === expectedFingerprint) {
        if (latest?.status === "installed" && latest.afterFingerprint !== current.fingerprint) {
          return {
            harness,
            status: "drifted",
            targetPath,
            lastChangedAt: latest.createdAt,
            message: "The recorded Copilot Hook fingerprint changed"
          };
        }
        return {
          harness,
          status: "installed",
          targetPath,
          ...(latest ? { lastChangedAt: latest.createdAt } : {})
        };
      }
      if (current.exists || latest?.status === "installed") {
        return {
          harness,
          status: "drifted",
          targetPath,
          ...(latest ? { lastChangedAt: latest.createdAt } : {}),
          message: "The managed Copilot Hook is missing or changed"
        };
      }
      return {
        harness,
        status: "not-installed",
        targetPath,
        ...(latest ? { lastChangedAt: latest.createdAt } : {})
      };
    }
    const groups = managedEvents(harness).map((event) => ({
      event,
      groups: managedGroups(current.config, harness, event)
    }));
    if (groups.some((entry) => entry.groups.length > 1)) {
      return { harness, status: "drifted", targetPath, message: "Duplicate managed hooks" };
    }
    if (groups.every((entry) => entry.groups.length === 1)) {
      const fingerprint = bundleFingerprint(installedBundle(current.config, harness));
      if (latest?.status === "installed" && fingerprint !== latest.installedEntryFingerprint) {
        return {
          harness,
          status: "drifted",
          targetPath,
          lastChangedAt: latest.createdAt,
          message: "The recorded Skill Steward hook changed"
        };
      }
      return {
        harness,
        status: harness === "codex" ? "needs-trust" : "installed",
        targetPath,
        ...(latest ? { lastChangedAt: latest.createdAt } : {})
      };
    }
    if (groups.some((entry) => entry.groups.length === 1)) {
      return {
        harness,
        status: "drifted",
        targetPath,
        ...(latest ? { lastChangedAt: latest.createdAt } : {}),
        message: "The Skill Steward lifecycle Hook bundle is incomplete"
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
  options: IntegrationConfigOptions,
  dependencyOverrides: Partial<IntegrationConfigDependencies> = {}
): Promise<IntegrationRecord> {
  const dependencies = { ...integrationConfigDefaults, ...dependencyOverrides };
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
  const commitRemoval = async (record: IntegrationRecord): Promise<IntegrationRecord> => {
    try {
      await dependencies.appendRecord(options.stateDirectory, record);
      return record;
    } catch (error) {
      if (journalCommitIsUncertain(error)) throw uncertainJournalError(error, "remove");
      try {
        await atomicWrite(targetPath, before.source, options.home);
      } catch (rollbackError) {
        throw new IntegrationError(
          "INTEGRATION_ROLLBACK_FAILED",
          `Integration configuration was removed, its journal failed, and restoration was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          {
            cause: new AggregateError(
              [error, rollbackError],
              "Integration removal journal commit and configuration restoration both failed"
            )
          }
        );
      }
      throw error;
    }
  };
  if (harness === "github-copilot") {
    const expectedFingerprint = hash(stableJson(copilotHookConfig()));
    if (
      !before.exists
      || before.fingerprint !== expectedFingerprint
      || before.fingerprint !== latest.afterFingerprint
    ) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "Copilot Hook changed since installation; removal was not applied"
      );
    }
    await unlink(targetPath);
    const now = options.now?.() ?? new Date();
    const record: IntegrationRecord = {
      schemaVersion: 1,
      id: options.id?.() ?? randomUUID(),
      harness,
      action: "remove",
      status: "removed",
      targetPath,
      beforeFingerprint: before.fingerprint,
      afterFingerprint: hash(""),
      installedEntryFingerprint: latest.installedEntryFingerprint,
      createdAt: now.toISOString()
    };
    return commitRemoval(record);
  }
  const groups = installedBundle(before.config, harness);
  if (
    groups.length !== managedEvents(harness).length ||
    bundleFingerprint(groups) !== latest.installedEntryFingerprint
  ) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Skill Steward hook changed since installation; removal was not applied"
    );
  }
  const afterConfig = managedEvents(harness).reduce(
    (config, event) => removeManagedGroup(config, harness, event),
    before.config
  );
  const afterSource = stableJson(afterConfig);
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const path = backupPath(targetPath, now, `${id}-remove`);
  await writeBackup(path, before.source, options.home);
  await atomicWrite(targetPath, afterSource, options.home);
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
  return commitRemoval(record);
}
