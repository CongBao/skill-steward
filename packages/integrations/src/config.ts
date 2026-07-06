import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appendIntegrationRecord,
  assertIntegrationMutationLeaseOwned,
  bindIntegrationRecordV2,
  integrationRecordV2BindingSchema,
  latestIntegrationRecord,
  readIntegrationRecordJournal,
  readIntegrationRecoveryState,
  writeReviewedPlan,
  type IntegrationMutationLeaseContext,
  type IntegrationRecord,
  type IntegrationRecordV2
} from "@skill-steward/store";
import {
  integrationHarnessSchema,
  type IntegrationHarness
} from "./domain.js";
import { copilotHookConfig, copilotHookTarget } from "./config-adapters.js";
import {
  companionSubplanSchema,
  deriveCompanionTransactionAvailability,
  type CompanionTransactionAvailability
} from "./companion-domain.js";
import { inspectCompanionSkillWithProof } from "./companion-inspector-internal.js";
import { resolveCompanionConsumersAfterDisconnect } from "./companion-legacy.js";
import { inspectCompanionTree } from "./companion-manifest.js";
import type { CompanionSkillStatus } from "./companion-shared.js";

export type IntegrationErrorCode =
  | "INTEGRATION_COMPANION_ACTION_UNAVAILABLE"
  | "INTEGRATION_CONFIG_INVALID"
  | "INTEGRATION_DUPLICATE"
  | "INTEGRATION_DRIFTED"
  | "INTEGRATION_LEGACY_CLEANUP_UNAVAILABLE"
  | "INTEGRATION_NOT_INSTALLED"
  | "INTEGRATION_PLAN_EXPIRED"
  | "INTEGRATION_PLAN_INVALID"
  | "INTEGRATION_PLAN_MISMATCH"
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

function leaseOwnershipWasLost(error: unknown): boolean {
  return errorCode(error)?.startsWith("INTEGRATION_LEASE_") ?? false;
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
  lifecycleProtocolVersion: z.literal(2),
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
  companion: companionSubplanSchema,
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
  if (
    plan.changes.length === 0
    && plan.expectedBeforeFingerprint !== plan.afterFingerprint
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["afterFingerprint"],
      message: "No-op integration plans must retain the exact configuration bytes"
    });
  }
});

export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;

const disconnectConfigurationStateSchema = z.object({
  state: z.literal("file"),
  fingerprint: fingerprintSchema,
  config: z.custom<JsonObject>(
    (value) => isObject(value) && isJsonValue(value),
    "Disconnect configuration must be a JSON object"
  )
}).strict();

const disconnectConsumersSchema = z.array(integrationHarnessSchema).max(3).superRefine(
  (consumers, context) => {
    if (
      new Set(consumers).size !== consumers.length
      || JSON.stringify(consumers) !== JSON.stringify([...consumers].sort())
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Disconnect consumers must be sorted and unique"
      });
    }
  }
);

export const integrationDisconnectPlanSchema = z.object({
  lifecycleProtocolVersion: z.literal(2),
  action: z.literal("disconnect"),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  harness: integrationHarnessSchema,
  lifecycleHead: z.object({
    recordId: z.string().min(1).max(128),
    binding: integrationRecordV2BindingSchema
  }).strict(),
  consumerRecord: z.object({
    recordId: z.string().min(1).max(128),
    binding: integrationRecordV2BindingSchema
  }).strict(),
  configuration: z.object({
    path: normalizedAbsolutePathSchema,
    before: disconnectConfigurationStateSchema,
    after: disconnectConfigurationStateSchema,
    installedEntryFingerprint: fingerprintSchema
  }).strict(),
  companion: z.object({
    path: normalizedAbsolutePathSchema,
    status: z.enum(["retained", "removed"]),
    fingerprint: fingerprintSchema,
    installedFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    expectedConsumers: disconnectConsumersSchema,
    remainingConsumers: disconnectConsumersSchema
  }).strict(),
  readiness: z.object({
    trigger: z.object({
      planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
      harness: integrationHarnessSchema,
      createdAt: z.string().datetime()
    }).strict()
  }).strict(),
  availability: z.object({
    disconnectAvailable: z.literal(true),
    reason: z.null()
  }).strict(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().superRefine((plan, context) => {
  if (Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== INTEGRATION_PLAN_TTL_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Disconnect plan must expire ten minutes after creation"
    });
  }
  if (
    plan.readiness.trigger.planId !== plan.id
    || plan.readiness.trigger.harness !== plan.harness
    || plan.readiness.trigger.createdAt !== plan.createdAt
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readiness", "trigger"],
      message: "Disconnect readiness trigger must exactly match its plan"
    });
  }
  if (
    hash(stableJson(plan.configuration.after.config))
      !== plan.configuration.after.fingerprint
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["configuration"],
      message: "Disconnect after configuration fingerprint must match exact published bytes"
    });
  }
  if (
    !plan.companion.expectedConsumers.includes(plan.harness)
    || plan.companion.remainingConsumers.includes(plan.harness)
    || JSON.stringify(plan.companion.remainingConsumers)
      !== JSON.stringify(plan.companion.expectedConsumers.filter(
        (harness) => harness !== plan.harness
      ))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companion", "remainingConsumers"],
      message: "Disconnect remaining consumers must remove exactly its Harness"
    });
  }
  if (plan.companion.fingerprint !== plan.companion.installedFingerprint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companion", "fingerprint"],
      message: "Disconnect companion must match the recorded installed fingerprint"
    });
  }
  const hasRemainingConsumers = plan.companion.remainingConsumers.length > 0;
  if (
    (plan.companion.status === "retained") !== hasRemainingConsumers
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companion", "status"],
      message: "Disconnect companion status must match its remaining consumer set"
    });
  }
});

export type IntegrationDisconnectPlan = z.infer<typeof integrationDisconnectPlanSchema>;

export type IntegrationApplyAvailability = CompanionTransactionAvailability | {
  state: "blocked";
  action: "unknown";
  actionLabel: "Review integration plan";
  transactionEligible: false;
  applyAvailable: false;
  unavailableReason:
    | "INTEGRATION_PLAN_PROTOCOL_UNSUPPORTED"
    | "INTEGRATION_PLAN_INVALID";
};

export function integrationApplyAvailability(
  inputPlan: unknown
): IntegrationApplyAvailability {
  if (
    !isObject(inputPlan)
    || inputPlan.lifecycleProtocolVersion !== 2
  ) {
    return {
      state: "blocked",
      action: "unknown",
      actionLabel: "Review integration plan",
      transactionEligible: false,
      applyAvailable: false,
      unavailableReason: "INTEGRATION_PLAN_PROTOCOL_UNSUPPORTED"
    };
  }
  const parsed = integrationPlanSchema.safeParse(inputPlan);
  if (!parsed.success) {
    return {
      state: "blocked",
      action: "unknown",
      actionLabel: "Review integration plan",
      transactionEligible: false,
      applyAvailable: false,
      unavailableReason: "INTEGRATION_PLAN_INVALID"
    };
  }
  return deriveCompanionTransactionAvailability(parsed.data.companion, process.platform);
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
  companion: {
    status: CompanionSkillStatus;
    reason: string;
    path: string;
    proofCategory: "new" | "recorded" | "legacy-alpha" | "conflict" | "unknown";
  };
}

type HookIntegrationStatus = Omit<IntegrationStatus, "companion">;

export interface IntegrationConfigOptions {
  home: string;
  stateDirectory: string;
  companionSourceDirectory?: string;
  now?: () => Date;
  id?: () => string;
}

export interface IntegrationMutationConfigOptions extends IntegrationConfigOptions {
  leaseContext: IntegrationMutationLeaseContext;
}

export interface IntegrationConfigDependencies {
  appendRecord: (
    ...args: Parameters<typeof appendIntegrationRecord>
  ) => Promise<Awaited<ReturnType<typeof appendIntegrationRecord>> | void>;
  beforeLegacyConfigMutation: () => Promise<void>;
  beforeLegacyConfigPublish: () => Promise<void>;
  beforeLegacyJournalAppend: () => Promise<void>;
  beforeLegacyJournalPublish: () => Promise<void>;
}

const integrationConfigDefaults: IntegrationConfigDependencies = {
  appendRecord: appendIntegrationRecord,
  beforeLegacyConfigMutation: async () => undefined,
  beforeLegacyConfigPublish: async () => undefined,
  beforeLegacyJournalAppend: async () => undefined,
  beforeLegacyJournalPublish: async () => undefined
};

const defaultCompanionSourceDirectory = fileURLToPath(
  new URL("../assets/skill-steward-preflight", import.meta.url)
);

function companionSourceDirectory(options: IntegrationConfigOptions): string {
  return resolve(options.companionSourceDirectory ?? defaultCompanionSourceDirectory);
}

function hash(value: string | Uint8Array): string {
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

async function revalidateCompanionSubplan(
  plan: IntegrationPlan,
  options: IntegrationConfigOptions,
  harness: IntegrationHarness
): Promise<void> {
  const current = await inspectCompanionSkillWithProof({
    home: options.home,
    sourceDirectory: companionSourceDirectory(options),
    stateDirectory: options.stateDirectory,
    harness
  });
  if (canonicalJson(current.subplan) !== canonicalJson(plan.companion)) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Companion Skill state changed after this plan was reviewed; the plan was consumed without making changes"
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertLegacyCleanupAvailable(
  stateDirectory: string
): Promise<Awaited<ReturnType<typeof readIntegrationRecordJournal>>> {
  let journal: Awaited<ReturnType<typeof readIntegrationRecordJournal>>;
  try {
    journal = await readIntegrationRecordJournal(stateDirectory);
  } catch (error) {
    throw new IntegrationError(
      "INTEGRATION_LEGACY_CLEANUP_UNAVAILABLE",
      "Legacy v1 cleanup is unavailable because validated lifecycle history could not be read safely; use the reviewed v2 disconnect flow",
      { cause: error }
    );
  }
  if (
    journal.changedDuringRead
    || journal.orderedRecords.some((record) => record.schemaVersion === 2)
  ) {
    throw new IntegrationError(
      "INTEGRATION_LEGACY_CLEANUP_UNAVAILABLE",
      "Legacy v1 cleanup is unavailable because validated lifecycle history contains v2 evidence or the lifecycle snapshot could not be proven stable; use the reviewed v2 disconnect flow"
    );
  }
  return journal;
}

async function assertLegacyCleanupLease(
  options: IntegrationMutationConfigOptions
): Promise<void> {
  await assertIntegrationMutationLeaseOwned(
    options.leaseContext,
    options.stateDirectory
  );
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

async function readTargetState(targetPath: string): Promise<{
  exists: boolean;
  source: string;
  bytes: Buffer;
  fingerprint: string;
}> {
  try {
    const bytes = await readFile(targetPath);
    return {
      exists: true,
      source: bytes.toString("utf8"),
      bytes,
      fingerprint: hash(bytes)
    };
  } catch (error) {
    if (isMissing(error)) {
      const bytes = Buffer.alloc(0);
      return { exists: false, source: "", bytes, fingerprint: hash(bytes) };
    }
    throw error;
  }
}

async function readConfig(targetPath: string): Promise<{
  exists: boolean;
  source: string;
  bytes: Buffer;
  fingerprint: string;
  config: JsonObject;
}> {
  const state = await readTargetState(targetPath);
  return {
    ...state,
    config: state.exists ? parseConfig(state.source) : {}
  };
}

async function requireExactTargetState(input: {
  targetPath: string;
  expectedExists: boolean;
  expectedFingerprint: string;
  message: string;
}): Promise<void> {
  const current = await readTargetState(input.targetPath);
  if (
    current.exists !== input.expectedExists
    || current.fingerprint !== input.expectedFingerprint
  ) {
    throw new IntegrationError("INTEGRATION_DRIFTED", input.message);
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

async function atomicWrite(
  path: string,
  source: string | Uint8Array,
  home: string,
  expected: {
    exists: boolean;
    fingerprint: string;
    message: string;
  },
  beforePublish: () => Promise<void> = async () => undefined
): Promise<void> {
  await assertSafeTarget(path, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeTarget(path, home);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined = await open(
    temporary,
    "wx",
    0o600
  );
  let renamed = false;
  try {
    if (typeof source === "string") await handle.writeFile(source, "utf8");
    else await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeTarget(path, home);
    await requireExactTargetState({
      targetPath: path,
      expectedExists: expected.exists,
      expectedFingerprint: expected.fingerprint,
      message: expected.message
    });
    await beforePublish();
    await rename(temporary, path);
    renamed = true;
  } finally {
    await handle?.close();
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

async function writeBackup(
  path: string,
  source: string | Uint8Array,
  home: string
): Promise<void> {
  await assertSafeTarget(path, home);
  if (typeof source === "string") {
    await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } else {
    await writeFile(path, source, { mode: 0o600, flag: "wx" });
  }
}

async function restoreIntegrationTarget(
  plan: IntegrationPlan,
  home: string,
  assertBeforeMutation: () => Promise<void> = async () => undefined,
  beforePublish: () => Promise<void> = assertBeforeMutation
): Promise<void> {
  await assertSafeTarget(plan.targetPath, home);
  const current = await readTargetState(plan.targetPath);
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
    const backupSource = await readFile(plan.backupPath);
    if (hash(backupSource) !== plan.expectedBeforeFingerprint) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "Integration backup changed before rollback"
      );
    }
    await assertBeforeMutation();
    await atomicWrite(plan.targetPath, backupSource, home, {
      exists: true,
      fingerprint: plan.afterFingerprint,
      message: "Harness configuration changed while integration rollback was prepared"
    }, beforePublish);
    await assertBeforeMutation();
    await unlink(plan.backupPath);
    return;
  }
  if (plan.expectedBeforeFingerprint !== hash("")) {
    throw new IntegrationError(
      "INTEGRATION_PLAN_INVALID",
      "Integration rollback is missing its reviewed backup"
    );
  }
  await assertBeforeMutation();
  await unlink(plan.targetPath);
}

const integrationHarnesses: IntegrationHarness[] = [
  "claude-code",
  "codex",
  "github-copilot"
];

async function currentCopilotTombstoneRecord(input: {
  stateDirectory: string;
  targetPath: string;
  currentFingerprint: string;
  home: string;
}): Promise<IntegrationRecordV2 | null> {
  const tombstoneFingerprint = hash(stableJson({ version: 1, hooks: {} }));
  if (input.currentFingerprint !== tombstoneFingerprint) return null;
  let journal: Awaited<ReturnType<typeof readIntegrationRecordJournal>>;
  try {
    journal = await readIntegrationRecordJournal(input.stateDirectory);
  } catch {
    return null;
  }
  if (journal.changedDuringRead) return null;
  const record = journal.orderedRecords[0];
  const harnessHead = journal.orderedRecords.find(
    (candidate) => candidate.harness === "github-copilot"
  );
  if (
    record?.schemaVersion !== 2
    || harnessHead !== record
    || record.harness !== "github-copilot"
    || record.action !== "remove"
    || record.status !== "removed"
    || record.targetPath !== input.targetPath
    || record.afterFingerprint !== tombstoneFingerprint
    || record.beforeFingerprint !== record.installedEntryFingerprint
    || record.companion.path !== resolve(
      input.home,
      ".agents",
      "skills",
      "skill-steward-preflight"
    )
    || record.companion.consumers.includes("github-copilot")
  ) return null;
  const companionTransitionIsExact = record.companion.before.state === "exact"
    && record.companion.before.fingerprint === record.companion.installedFingerprint
    && (
      record.companion.action === "retain"
        ? record.companion.after.state === "exact"
          && record.companion.after.fingerprint === record.companion.installedFingerprint
        : record.companion.action === "remove"
          ? record.companion.after.state === "absent"
          && record.companion.consumers.length === 0
          : false
    );
  if (!companionTransitionIsExact) return null;
  const currentConsumers = integrationHarnesses.filter((harness) =>
    journal.orderedRecords.find((candidate) => candidate.harness === harness)?.status
      === "installed"
  ).sort();
  return JSON.stringify(currentConsumers) === JSON.stringify(record.companion.consumers)
    ? record
    : null;
}

function companionProvesCurrentCopilotTombstone(
  companion: IntegrationPlan["companion"],
  record: IntegrationRecordV2
): boolean {
  if (record.companion.action === "remove") {
    return record.companion.after.state === "absent"
      && companion.action === "create"
      && companion.expectedBefore.state === "absent"
      && companion.proof.kind === "new";
  }
  return record.companion.action === "retain"
    && companion.action === "none"
    && companion.expectedBefore.state === "exact"
    && companion.proof.kind === "recorded"
    && companion.proof.recordId === record.id
    && companion.expectedBefore.fingerprint === record.companion.installedFingerprint
    && companion.after.fingerprint === record.companion.installedFingerprint
    && companion.source.fingerprint === record.companion.source.fingerprint;
}

async function planIntegrationInternal(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions,
  claimedRecovery = false
): Promise<IntegrationPlan> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  await assertSafeTarget(targetPath, options.home);
  const before = await readConfig(targetPath);
  const companion = (await inspectCompanionSkillWithProof({
    home: options.home,
    sourceDirectory: companionSourceDirectory(options),
    stateDirectory: options.stateDirectory,
    harness
  }, claimedRecovery ? { recoverySummary: { status: "clear" } } : {})).subplan;
  if (harness === "github-copilot") {
    const afterConfig = copilotHookConfig();
    const afterSource = stableJson(afterConfig);
    const afterFingerprint = hash(afterSource);
    const tombstoneRecord = before.exists
      ? await currentCopilotTombstoneRecord({
          stateDirectory: options.stateDirectory,
          targetPath,
          currentFingerprint: before.fingerprint,
          home: options.home
        })
      : null;
    const exactTombstone = tombstoneRecord !== null
      && companionProvesCurrentCopilotTombstone(companion, tombstoneRecord);
    const fullyInstalled = before.exists && before.fingerprint === afterFingerprint;
    if (before.exists && !fullyInstalled && !exactTombstone) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "The dedicated Copilot Hook file already exists with different content"
      );
    }
    const now = options.now?.() ?? new Date();
    return {
      lifecycleProtocolVersion: 2,
      id: options.id?.() ?? randomUUID(),
      harness,
      targetPath,
      expectedBeforeFingerprint: before.fingerprint,
      afterConfig,
      afterFingerprint,
      installedEntryFingerprint: afterFingerprint,
      companion,
      changes: fullyInstalled ? [] : [{ operation: "write", path: targetPath }],
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
  const afterFingerprint = fullyInstalled ? before.fingerprint : hash(afterSource);
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const path = before.exists && !fullyInstalled
    ? backupPath(targetPath, now, id)
    : undefined;
  return {
    lifecycleProtocolVersion: 2,
    id,
    harness,
    targetPath,
    ...(path ? { backupPath: path } : {}),
    expectedBeforeFingerprint: before.fingerprint,
    afterConfig,
    afterFingerprint,
    installedEntryFingerprint: bundleFingerprint(installedBundle(afterConfig, harness)),
    companion,
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

export async function planIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationPlan> {
  return planIntegrationInternal(inputHarness, options);
}

/** Package-private: the coordinator has already claimed and exclusively owns this recovery intent. */
export async function revalidateClaimedIntegrationPlan(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationPlan> {
  return planIntegrationInternal(inputHarness, options, true);
}

function unavailableDisconnect(message: string, cause?: unknown): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function exactV2RecordBinding(record: IntegrationRecordV2): {
  recordId: string;
  binding: ReturnType<typeof bindIntegrationRecordV2>;
} {
  return { recordId: record.id, binding: bindIntegrationRecordV2(record) };
}

function disconnectAfterConfig(
  harness: IntegrationHarness,
  before: JsonObject
): JsonObject {
  if (harness === "github-copilot") return { version: 1, hooks: {} };
  return managedEvents(harness).reduce(
    (config, event) => removeManagedGroup(config, harness, event),
    before
  );
}

async function planIntegrationDisconnectInternal(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions,
  input: {
    persist: boolean;
    claimedRecovery: boolean;
  }
): Promise<IntegrationDisconnectPlan> {
  if (process.platform === "win32") {
    throw unavailableDisconnect("Reviewed disconnect is unavailable on this platform");
  }
  const harness = integrationHarnessSchema.parse(inputHarness);
  if (!input.claimedRecovery) {
    let recovery: Awaited<ReturnType<typeof readIntegrationRecoveryState>>;
    try {
      recovery = await readIntegrationRecoveryState(options.stateDirectory);
    } catch (error) {
      throw unavailableDisconnect(
        "Reviewed disconnect recovery state could not be proven",
        error
      );
    }
    if (recovery.status !== "clear") {
      throw unavailableDisconnect(
        recovery.status === "unresolved"
          ? "Reviewed disconnect is unavailable while integration recovery is required"
          : "Reviewed disconnect recovery state could not be proven"
      );
    }
  }
  let journal: Awaited<ReturnType<typeof readIntegrationRecordJournal>>;
  try {
    journal = await readIntegrationRecordJournal(options.stateDirectory);
  } catch (error) {
    throw unavailableDisconnect("Reviewed disconnect lifecycle evidence could not be read", error);
  }
  if (journal.changedDuringRead) {
    throw unavailableDisconnect("Reviewed disconnect lifecycle evidence changed during planning");
  }
  const lifecycleHead = journal.orderedRecords[0];
  if (lifecycleHead?.schemaVersion !== 2) {
    throw unavailableDisconnect("Reviewed disconnect requires a current lifecycle v2 head");
  }
  const selectedHarnessHead = journal.orderedRecords.find(
    (record) => record.harness === harness
  );
  const consumerRecord = selectedHarnessHead?.schemaVersion === 2
    ? selectedHarnessHead
    : undefined;
  if (
    consumerRecord === undefined
    || consumerRecord.status !== "installed"
    || consumerRecord.action !== "apply"
    || !lifecycleHead.companion.consumers.includes(harness)
  ) {
    throw new IntegrationError(
      "INTEGRATION_NOT_INSTALLED",
      "The selected Harness is not a current lifecycle v2 companion consumer"
    );
  }
  const companionPath = resolve(
    options.home,
    ".agents",
    "skills",
    "skill-steward-preflight"
  );
  if (
    lifecycleHead.companion.path !== companionPath
    || lifecycleHead.companion.after.state !== "exact"
  ) {
    throw unavailableDisconnect("Current companion lifecycle evidence is contradictory");
  }
  let companion;
  try {
    companion = await inspectCompanionTree(companionPath, {
      boundary: options.home,
      platform: process.platform
    });
  } catch (error) {
    throw unavailableDisconnect("Current companion tree could not be proven exactly", error);
  }
  if (
    companion.fingerprint !== lifecycleHead.companion.installedFingerprint
    || lifecycleHead.companion.after.fingerprint
      !== lifecycleHead.companion.installedFingerprint
  ) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Current companion tree changed after lifecycle v2 finalize"
    );
  }

  const targetPath = integrationTarget(harness, options.home);
  if (consumerRecord.targetPath !== targetPath) {
    throw unavailableDisconnect("Current Harness lifecycle target is contradictory");
  }
  await assertSafeTarget(targetPath, options.home);
  const before = await readConfig(targetPath);
  if (!before.exists || before.fingerprint !== consumerRecord.afterFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Current Harness configuration changed after lifecycle v2 finalize"
    );
  }
  if (harness === "github-copilot") {
    const expected = stableJson(copilotHookConfig());
    if (
      before.source !== expected
      || consumerRecord.installedEntryFingerprint !== before.fingerprint
    ) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "Current Copilot Hook does not exactly match its installed lifecycle entry"
      );
    }
  } else {
    const bundle = installedBundle(before.config, harness);
    if (
      bundle.length !== managedEvents(harness).length
      || bundleFingerprint(bundle) !== consumerRecord.installedEntryFingerprint
    ) {
      throw new IntegrationError(
        "INTEGRATION_DRIFTED",
        "Current Harness Hook does not exactly match its installed lifecycle entry"
      );
    }
  }
  const afterConfig = disconnectAfterConfig(harness, before.config);
  const afterSource = stableJson(afterConfig);
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const id = options.id?.() ?? randomUUID();
  const expectedConsumers = [...lifecycleHead.companion.consumers];
  const consumerResolution = await resolveCompanionConsumersAfterDisconnect(
    options.home,
    harness,
    journal
  );
  if (consumerResolution.state === "unknown") {
    throw unavailableDisconnect("Another companion consumer could not be proven exactly");
  }
  if (consumerResolution.state === "conflict") {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Another companion consumer changed after lifecycle v2 finalize"
    );
  }
  const remainingConsumers = consumerResolution.consumers;
  const plan = integrationDisconnectPlanSchema.parse({
    lifecycleProtocolVersion: 2,
    action: "disconnect",
    id,
    harness,
    lifecycleHead: exactV2RecordBinding(lifecycleHead),
    consumerRecord: exactV2RecordBinding(consumerRecord),
    configuration: {
      path: targetPath,
      before: {
        state: "file",
        fingerprint: before.fingerprint,
        config: before.config
      },
      after: {
        state: "file",
        fingerprint: hash(afterSource),
        config: afterConfig
      },
      installedEntryFingerprint: consumerRecord.installedEntryFingerprint
    },
    companion: {
      path: companionPath,
      status: remainingConsumers.length === 0 ? "removed" : "retained",
      fingerprint: companion.fingerprint,
      installedFingerprint: lifecycleHead.companion.installedFingerprint,
      sourceFingerprint: lifecycleHead.companion.source.fingerprint,
      expectedConsumers,
      remainingConsumers
    },
    readiness: {
      trigger: { planId: id, harness, createdAt }
    },
    availability: { disconnectAvailable: true, reason: null },
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + INTEGRATION_PLAN_TTL_MS).toISOString()
  });
  if (input.persist) {
    await writeReviewedPlan(options.stateDirectory, {
      schemaVersion: 1,
      id: plan.id,
      kind: "integration-disconnect",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
  }
  return plan;
}

/** Package-private until the Phase 4 common-surface activation gate. */
export async function planIntegrationDisconnect(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationDisconnectPlan> {
  return planIntegrationDisconnectInternal(inputHarness, options, {
    persist: true,
    claimedRecovery: false
  });
}

/** Package-private: the coordinator owns the reviewed plan and recovery intent. */
export async function revalidateClaimedIntegrationDisconnect(
  plan: IntegrationDisconnectPlan,
  options: IntegrationConfigOptions
): Promise<IntegrationDisconnectPlan> {
  return planIntegrationDisconnectInternal(plan.harness, {
    ...options,
    now: () => new Date(plan.createdAt),
    id: () => plan.id
  }, {
    persist: false,
    claimedRecovery: true
  });
}

export async function applyIntegrationPlan(
  inputPlan: unknown,
  options: IntegrationConfigOptions
): Promise<IntegrationRecord> {
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
  const expectedCompanionPath = resolve(
    options.home,
    ".agents",
    "skills",
    "skill-steward-preflight"
  );
  if (
    plan.companion.path !== expectedCompanionPath
    || plan.companion.source.path !== companionSourceDirectory(options)
  ) {
    throw new IntegrationError(
      "INTEGRATION_UNSAFE_PATH",
      "Integration plan companion target or source is invalid"
    );
  }
  if (plan.targetPath !== integrationTarget(harness, options.home)) {
    throw new IntegrationError("INTEGRATION_UNSAFE_PATH", "Integration plan target is invalid");
  }

  await assertSafeTarget(plan.targetPath, options.home);
  const currentConfig = await readConfig(plan.targetPath);
  if (currentConfig.fingerprint !== plan.expectedBeforeFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Harness configuration changed after this plan was reviewed; the plan was consumed without making changes"
    );
  }
  await revalidateCompanionSubplan(plan, options, harness);
  throw new IntegrationError(
    "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
    "Companion lifecycle apply remains read-only in this release; the reviewed plan was revalidated and no changes were made. Apply becomes available with the transaction-safe lifecycle phase."
  );
}

export async function applyIntegrationPlanInternal(
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
  const expectedCompanionPath = resolve(
    options.home,
    ".agents",
    "skills",
    "skill-steward-preflight"
  );
  if (
    plan.companion.path !== expectedCompanionPath
    || plan.companion.source.path !== companionSourceDirectory(options)
  ) {
    throw new IntegrationError(
      "INTEGRATION_UNSAFE_PATH",
      "Integration plan companion target or source is invalid"
    );
  }
  if (plan.companion.action !== "none") {
    throw new IntegrationError(
      "INTEGRATION_COMPANION_ACTION_UNAVAILABLE",
      "This companion action requires the reviewed lifecycle transaction, which is not available yet; no changes were made. Resolve any conflict and create a fresh plan after lifecycle transactions are enabled."
    );
  }
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
  const exactConfigNoop = plan.changes.length === 0;
  const expectedAfterFingerprint = exactConfigNoop
    ? before.fingerprint
    : hash(afterSource);
  if (expectedAfterFingerprint !== plan.afterFingerprint) {
    throw new IntegrationError("INTEGRATION_DRIFTED", "Integration plan content changed");
  }
  const expectedInstalledFingerprint = harness === "github-copilot"
    ? plan.afterFingerprint
    : bundleFingerprint(installedBundle(expectedConfig, harness));
  if (plan.installedEntryFingerprint !== expectedInstalledFingerprint) {
    throw new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Integration plan managed entry fingerprint changed"
    );
  }
  const fullyInstalled = harness === "github-copilot"
    ? before.exists && before.fingerprint === hash(stableJson(copilotHookConfig()))
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
    await writeBackup(plan.backupPath, before.bytes, options.home);
  }
  if (plan.changes.length > 0) {
    await atomicWrite(plan.targetPath, afterSource, options.home, {
      exists: before.exists,
      fingerprint: before.fingerprint,
      message: "Harness configuration changed while integration apply was prepared"
    });
  }
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
  options: IntegrationMutationConfigOptions,
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
  await assertLegacyCleanupLease(options);
  await assertLegacyCleanupAvailable(options.stateDirectory);
  const expectedTarget = integrationTarget(plan.harness, options.home);
  if (plan.targetPath !== expectedTarget) {
    throw new IntegrationError("INTEGRATION_UNSAFE_PATH", "Integration plan target is invalid");
  }
  await assertSafeTarget(plan.targetPath, options.home);
  await dependencies.beforeLegacyConfigMutation();
  await assertLegacyCleanupLease(options);
  await restoreIntegrationTarget(
    plan,
    options.home,
    () => assertLegacyCleanupLease(options),
    async () => {
      await dependencies.beforeLegacyConfigPublish();
      await assertLegacyCleanupLease(options);
    }
  );
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
  await dependencies.beforeLegacyJournalAppend();
  await assertLegacyCleanupLease(options);
  try {
    await dependencies.appendRecord(options.stateDirectory, record, {
      beforePublish: async () => {
        await dependencies.beforeLegacyJournalPublish();
        await assertLegacyCleanupLease(options);
      }
    });
  } catch (error) {
    if (leaseOwnershipWasLost(error)) throw error;
    if (journalCommitIsUncertain(error)) throw uncertainJournalError(error, "remove");
    try {
      await requireExactTargetState({
        targetPath: plan.targetPath,
        expectedExists: plan.expectedBeforeFingerprint !== hash(""),
        expectedFingerprint: plan.expectedBeforeFingerprint,
        message: "Harness configuration changed while integration rollback was journaling"
      });
      await assertLegacyCleanupLease(options);
      await atomicWrite(plan.targetPath, stableJson(plan.afterConfig), options.home, {
        exists: plan.expectedBeforeFingerprint !== hash(""),
        fingerprint: plan.expectedBeforeFingerprint,
        message: "Harness configuration changed while rollback compensation was prepared"
      }, () => assertLegacyCleanupLease(options));
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

async function integrationHookStatus(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<HookIntegrationStatus> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  let latest: IntegrationRecord | null = null;
  try {
    latest = await latestIntegrationRecord(options.stateDirectory, harness);
  } catch {
    latest = null;
  }
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
      if (current.exists) {
        const tombstoneRecord = await currentCopilotTombstoneRecord({
          stateDirectory: options.stateDirectory,
          targetPath,
          currentFingerprint: current.fingerprint,
          home: options.home
        });
        if (tombstoneRecord !== null) {
          return {
            harness,
            status: "not-installed",
            targetPath,
            lastChangedAt: tombstoneRecord.createdAt
          };
        }
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

export async function integrationStatus(
  inputHarness: IntegrationHarness,
  options: IntegrationConfigOptions
): Promise<IntegrationStatus> {
  const harness = integrationHarnessSchema.parse(inputHarness);
  const [hook, companionInspection] = await Promise.all([
    integrationHookStatus(harness, options),
    inspectCompanionSkillWithProof({
      home: options.home,
      sourceDirectory: companionSourceDirectory(options),
      stateDirectory: options.stateDirectory,
      harness
    }).catch(() => ({
      status: "unknown" as const,
      reason: "COMPANION_INSPECTION_UNAVAILABLE",
      path: resolve(options.home, ".agents", "skills", "skill-steward-preflight"),
      subplan: undefined
    }))
  ]);
  return {
    ...hook,
    companion: {
      status: companionInspection.status,
      reason: companionInspection.reason,
      path: companionInspection.path,
      proofCategory: companionInspection.subplan?.proof.kind ?? "unknown"
    }
  };
}

export async function removeIntegration(
  inputHarness: IntegrationHarness,
  options: IntegrationMutationConfigOptions,
  dependencyOverrides: Partial<IntegrationConfigDependencies> = {}
): Promise<IntegrationRecord> {
  const dependencies = { ...integrationConfigDefaults, ...dependencyOverrides };
  const harness = integrationHarnessSchema.parse(inputHarness);
  const targetPath = integrationTarget(harness, options.home);
  await assertLegacyCleanupLease(options);
  await assertSafeTarget(targetPath, options.home);
  const journal = await assertLegacyCleanupAvailable(options.stateDirectory);
  const latest = journal.records.find((record) => record.harness === harness) ?? null;
  if (!latest || latest.status !== "installed") {
    throw new IntegrationError(
      "INTEGRATION_NOT_INSTALLED",
      "No installed Skill Steward integration record was found"
    );
  }
  const before = await readConfig(targetPath);
  const commitRemoval = async (record: IntegrationRecord): Promise<IntegrationRecord> => {
    await dependencies.beforeLegacyJournalAppend();
    await assertLegacyCleanupLease(options);
    try {
      await dependencies.appendRecord(options.stateDirectory, record, {
        beforePublish: async () => {
          await dependencies.beforeLegacyJournalPublish();
          await assertLegacyCleanupLease(options);
        }
      });
      return record;
    } catch (error) {
      if (leaseOwnershipWasLost(error)) throw error;
      if (journalCommitIsUncertain(error)) throw uncertainJournalError(error, "remove");
      try {
        await requireExactTargetState({
          targetPath,
          expectedExists: harness !== "github-copilot",
          expectedFingerprint: record.afterFingerprint,
          message: "Harness configuration changed while integration removal was journaling"
        });
        await assertLegacyCleanupLease(options);
        await atomicWrite(targetPath, before.bytes, options.home, {
          exists: harness !== "github-copilot",
          fingerprint: record.afterFingerprint,
          message: "Harness configuration changed while removal restoration was prepared"
        }, () => assertLegacyCleanupLease(options));
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
    await dependencies.beforeLegacyConfigMutation();
    await assertLegacyCleanupLease(options);
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
  await dependencies.beforeLegacyConfigMutation();
  await assertLegacyCleanupLease(options);
  await writeBackup(path, before.bytes, options.home);
  await assertLegacyCleanupLease(options);
  await atomicWrite(targetPath, afterSource, options.home, {
    exists: before.exists,
    fingerprint: before.fingerprint,
    message: "Harness configuration changed while integration removal was prepared"
  }, async () => {
    await dependencies.beforeLegacyConfigPublish();
    await assertLegacyCleanupLease(options);
  });
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
