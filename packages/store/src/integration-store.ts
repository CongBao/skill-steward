import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const INTEGRATIONS_FILE = "integrations.json";
const INTEGRATION_RECORDS_DIRECTORY = "integration-records";
const MAX_RECORDS = 100;
const MAX_JOURNAL_FILE_BYTES = 1024 * 1024;
const MAX_RECORD_DIRECTORY_ENTRIES = 256;
const MAX_RECORD_FRAGMENTS = 200;
const MAX_FRAGMENT_READ_CONCURRENCY = 8;
const MAX_SNAPSHOT_ATTEMPTS = 32;
const MAX_SNAPSHOT_RETRY_BUDGET_MS = 2_000;
const MAX_SNAPSHOT_RETRY_DELAY_MS = 50;
const fragmentNamePattern = /^[1-9][0-9]*-[1-9][0-9]*-[0-9]{12}-[0-9a-f-]{36}\.json$/;

const integrationHarnessSchema = z.enum(["codex", "claude-code", "github-copilot"]);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const normalizedAbsolutePathSchema = z.string().min(1).refine(
  (path) => isAbsolute(path) && normalize(path) === path,
  "Path must be absolute and normalized"
);

export const integrationRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  harness: integrationHarnessSchema,
  action: z.enum(["apply", "remove"]),
  status: z.enum(["installed", "removed"]),
  targetPath: z.string().min(1),
  backupPath: z.string().min(1).optional(),
  beforeFingerprint: fingerprintSchema,
  afterFingerprint: fingerprintSchema,
  installedEntryFingerprint: fingerprintSchema,
  createdAt: z.string().datetime()
}).strict().superRefine((record, context) => {
  if (
    (record.action === "apply" && record.status !== "installed")
    || (record.action === "remove" && record.status !== "removed")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Integration record action and status must agree"
    });
  }
});

const companionBeforeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("exact"), fingerprint: fingerprintSchema }).strict()
]);

const companionProofCategorySchema = z.discriminatedUnion("category", [
  z.object({ category: z.literal("new") }).strict(),
  z.object({ category: z.literal("recorded") }).strict(),
  z.object({ category: z.literal("legacy-alpha") }).strict()
]);

const companionAfterSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("exact"), fingerprint: fingerprintSchema }).strict()
]);

const companionTransitionSchema = z.object({
  action: z.enum(["none", "create", "upgrade", "retain", "remove"]),
  path: normalizedAbsolutePathSchema,
  before: companionBeforeSchema,
  after: companionAfterSchema,
  source: z.object({ fingerprint: fingerprintSchema }).strict(),
  proof: companionProofCategorySchema,
  installedFingerprint: fingerprintSchema,
  consumers: z.array(integrationHarnessSchema).max(3)
}).strict().superRefine((transition, context) => {
  const sorted = [...transition.consumers].sort();
  if (
    new Set(transition.consumers).size !== transition.consumers.length
    || JSON.stringify(sorted) !== JSON.stringify(transition.consumers)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["consumers"],
      message: "Companion consumers must be complete, sorted, and unique"
    });
  }
  if (transition.action === "create") {
    if (
      transition.before.state !== "absent"
      || transition.after.state !== "exact"
      || transition.proof.category !== "new"
      || transition.after.fingerprint !== transition.source.fingerprint
      || transition.after.fingerprint !== transition.installedFingerprint
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Create requires absent/new proof" });
    }
    return;
  }
  if (transition.before.state !== "exact") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Existing companion transitions require an exact before fingerprint"
    });
    return;
  }
  if (transition.proof.category === "new") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Existing companion transitions require recorded or legacy proof"
    });
  }
  if (transition.action === "none" && (
    transition.after.state !== "exact"
    || transition.before.fingerprint !== transition.after.fingerprint
    || transition.after.fingerprint !== transition.source.fingerprint
    || transition.after.fingerprint !== transition.installedFingerprint
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "None requires identical before and installed fingerprints"
    });
  }
  if (transition.action === "upgrade" && (
    transition.after.state !== "exact"
    || transition.before.fingerprint === transition.after.fingerprint
    || transition.after.fingerprint !== transition.source.fingerprint
    || transition.after.fingerprint !== transition.installedFingerprint
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Upgrade requires different before and installed fingerprints"
    });
  }
  if (transition.action === "retain" && (
    transition.after.state !== "exact"
    || transition.before.fingerprint !== transition.after.fingerprint
    || transition.before.fingerprint !== transition.installedFingerprint
    || transition.proof.category !== "recorded"
    || transition.consumers.length === 0
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Retain requires an exact recorded tree and remaining consumers"
    });
  }
  if (transition.action === "remove" && (
    transition.after.state !== "absent"
    || transition.before.fingerprint !== transition.installedFingerprint
    || transition.proof.category !== "recorded"
    || transition.consumers.length !== 0
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Remove requires an exact recorded tree and no remaining consumers"
    });
  }
});

export const integrationRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  harness: integrationHarnessSchema,
  action: z.enum(["apply", "remove"]),
  status: z.enum(["installed", "removed"]),
  targetPath: normalizedAbsolutePathSchema,
  backupPath: normalizedAbsolutePathSchema.optional(),
  beforeFingerprint: fingerprintSchema,
  afterFingerprint: fingerprintSchema,
  installedEntryFingerprint: fingerprintSchema,
  companion: companionTransitionSchema,
  trigger: z.object({
    planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    harness: integrationHarnessSchema,
    createdAt: z.string().datetime()
  }).strict(),
  createdAt: z.string().datetime()
}).strict().superRefine((record, context) => {
  if (record.trigger.harness !== record.harness) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger", "harness"],
      message: "Lifecycle trigger Harness must match the integration record"
    });
  }
  if (record.trigger.createdAt !== record.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger", "createdAt"],
      message: "Lifecycle trigger timestamp must match the integration record"
    });
  }
  const applying = record.action === "apply" && record.status === "installed";
  const removing = record.action === "remove" && record.status === "removed";
  const applyTransition = record.companion.action === "none"
    || record.companion.action === "create"
    || record.companion.action === "upgrade";
  const removalTransition = record.companion.action === "retain"
    || record.companion.action === "remove";
  if (!((applying && applyTransition) || (removing && removalTransition))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Integration and companion transition actions must agree"
    });
  }
  if (applying && !record.companion.consumers.includes(record.harness)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companion", "consumers"],
      message: "Installed lifecycle evidence must include its triggering Harness"
    });
  }
  if (removing && record.companion.consumers.includes(record.harness)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companion", "consumers"],
      message: "Removed lifecycle evidence must exclude its triggering Harness"
    });
  }
});

export const integrationRecordSchema = z.union([
  integrationRecordV1Schema,
  integrationRecordV2Schema
]);

const integrationFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(integrationRecordV1Schema).max(MAX_RECORDS)
}).strict();

const integrationFragmentV1Schema = z.object({
  schemaVersion: z.literal(1),
  limit: z.number().int().min(1).max(MAX_RECORDS),
  record: integrationRecordV1Schema
}).strict();

const integrationFragmentV2Schema = z.object({
  schemaVersion: z.literal(2),
  limit: z.number().int().min(1).max(MAX_RECORDS),
  record: integrationRecordV2Schema
}).strict();

const integrationFragmentSchema = z.discriminatedUnion("schemaVersion", [
  integrationFragmentV1Schema,
  integrationFragmentV2Schema
]);

export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;
export type IntegrationRecordV1 = z.infer<typeof integrationRecordV1Schema>;
export type IntegrationRecordV2 = z.infer<typeof integrationRecordV2Schema>;

export class IntegrationJournalCommitUncertainError extends Error {
  readonly code = "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN";

  constructor(commitError: unknown, cleanupError: unknown) {
    super(
      "Integration record publication failed and removal of its owned fragment could not be proven",
      {
        cause: new AggregateError(
          [commitError, cleanupError],
          "Integration record publication and owned-fragment cleanup both failed"
        )
      }
    );
    this.name = "IntegrationJournalCommitUncertainError";
  }
}

interface IntegrationFragment {
  fileName: string;
  identity: BigIntStats;
  publishedAt: bigint;
  limit: number;
  record: IntegrationRecord;
}

let processSequence = 0;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}

interface StateDirectoryProof {
  identity: DirectoryIdentity;
  path: string;
  physicalPath: string;
}

interface RecordsDirectoryStorage {
  directory: string;
  identity: DirectoryIdentity;
  physicalDirectory: string;
  state: StateDirectoryProof;
}

interface FileReadOptions {
  context: IntegrationStoreContext;
  initial: BigIntStats;
  label: string;
  path: string;
  physicalParent: string;
  validateParent: () => Promise<void>;
}

interface IntegrationStoreContext {
  platform: NodeJS.Platform;
}

export interface IntegrationRecordStore {
  readIntegrationRecords(stateDirectory: string): Promise<IntegrationRecord[]>;
  appendIntegrationRecord(
    stateDirectory: string,
    input: IntegrationRecord,
    options?: { limit?: number }
  ): Promise<void>;
  latestIntegrationRecord(
    stateDirectory: string,
    harness: IntegrationRecord["harness"]
  ): Promise<IntegrationRecord | null>;
}

const defaultContext: IntegrationStoreContext = { platform: process.platform };

class IntegrationFileChangedError extends Error {
  constructor(
    label: string,
    readonly stage: string,
    readonly disappeared: boolean,
    options?: ErrorOptions
  ) {
    super(`${label} changed during the operation (${stage})`, options);
    this.name = "IntegrationFileChangedError";
  }
}

class IntegrationSnapshotChangedError extends Error {
  constructor(readonly stage: string, options?: ErrorOptions) {
    super(`Integration record snapshot changed during ${stage}`, options);
    this.name = "IntegrationSnapshotChangedError";
  }
}

class IntegrationSnapshotUnavailableError extends Error {
  readonly code = "INTEGRATION_RECORD_SNAPSHOT_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("Integration record snapshot did not stabilize after bounded retries", options);
    this.name = "IntegrationSnapshotUnavailableError";
  }
}

class IntegrationPublishedOwnershipError extends Error {
  readonly code = "INTEGRATION_PUBLISHED_OWNERSHIP_UNPROVABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrationPublishedOwnershipError";
  }
}

function recordsPath(stateDirectory: string): string {
  const statePath = resolve(stateDirectory);
  const directory = resolve(statePath, INTEGRATION_RECORDS_DIRECTORY);
  if (dirname(directory) !== statePath) {
    throw new Error("Integration record directory must remain inside the state directory");
  }
  return directory;
}

async function inspectDirectory(
  path: string,
  context?: IntegrationStoreContext
): Promise<DirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw Object.assign(
      new Error("EEXIST: Integration record storage must be a regular directory"),
      { code: "EEXIST" }
    );
  }
  if (context?.platform === "win32" && metadata.ino === 0n) {
    throw new Error("Integration directory identity cannot be proven on this platform");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertSameDirectory(
  path: string,
  expected: DirectoryIdentity,
  context?: IntegrationStoreContext
): Promise<void> {
  const actual = await inspectDirectory(path, context);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Integration record directory changed during the operation");
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function sameOwnedFileAcrossRename(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function assertProvableOwnedFile(
  metadata: BigIntStats,
  label: string,
  context: IntegrationStoreContext
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (context.platform === "win32" && metadata.ino === 0n) {
    throw new Error(`${label} identity cannot be proven on this platform`);
  }
  if (context.platform !== "win32" && (metadata.mode & 0o777n) !== 0o600n) {
    throw new Error(`${label} must have private permissions`);
  }
}

function samePhysicalPath(
  left: string,
  right: string,
  context: IntegrationStoreContext
): boolean {
  return context.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function inspectStateDirectory(
  statePath: string,
  context: IntegrationStoreContext
): Promise<StateDirectoryProof> {
  const identity = await inspectDirectory(statePath, context);
  const physicalPath = await realpath(statePath);
  await assertSameDirectory(statePath, identity, context);
  if (!samePhysicalPath(await realpath(statePath), physicalPath, context)) {
    throw new Error("Integration state directory changed during the operation");
  }
  return { identity, path: statePath, physicalPath };
}

async function assertSameStateDirectory(
  proof: StateDirectoryProof,
  context: IntegrationStoreContext
): Promise<void> {
  try {
    const [actual, physicalPath] = await Promise.all([
      inspectDirectory(proof.path, context),
      realpath(proof.path)
    ]);
    if (
      actual.device !== proof.identity.device
      || actual.inode !== proof.identity.inode
    ) {
      throw new Error("Integration state directory identity changed");
    }
    if (!samePhysicalPath(physicalPath, proof.physicalPath, context)) {
      throw new Error("Integration state directory physical path changed");
    }
  } catch (error) {
    throw new Error("Integration state directory changed during the operation", {
      cause: error
    });
  }
}

async function assertSameRecordsDirectory(
  storage: RecordsDirectoryStorage,
  context: IntegrationStoreContext
): Promise<void> {
  try {
    const [actual, physicalDirectory] = await Promise.all([
      inspectDirectory(storage.directory, context),
      realpath(storage.directory)
    ]);
    if (
      actual.device !== storage.identity.device
      || actual.inode !== storage.identity.inode
    ) {
      throw new Error("Integration record directory identity changed");
    }
    if (!samePhysicalPath(physicalDirectory, storage.physicalDirectory, context)) {
      throw new Error("Integration record directory physical path changed");
    }
    if (!samePhysicalPath(dirname(physicalDirectory), storage.state.physicalPath, context)) {
      throw new Error("Integration record directory escaped the state directory");
    }
  } catch (error) {
    throw new Error("Integration record directory changed during the operation", {
      cause: error
    });
  }
}

async function assertSameRecordsStorage(
  storage: RecordsDirectoryStorage,
  context: IntegrationStoreContext
): Promise<void> {
  await Promise.all([
    assertSameStateDirectory(storage.state, context),
    assertSameRecordsDirectory(storage, context)
  ]);
}

async function removeOwnedPath(
  path: string,
  expected: BigIntStats,
  storage: RecordsDirectoryStorage,
  context: IntegrationStoreContext
): Promise<void> {
  await assertSameRecordsStorage(storage, context);
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      await assertSameRecordsStorage(storage, context);
      return;
    }
    throw error;
  }
  if (!sameFileIdentity(expected, current)) {
    throw new IntegrationPublishedOwnershipError(
      "Integration published fragment ownership changed before compensation"
    );
  }
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await assertSameRecordsStorage(storage, context);
}

async function removeOwnedTemporaryPath(
  path: string,
  expected: BigIntStats
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameFileIdentity(expected, current)) {
    throw new IntegrationPublishedOwnershipError(
      "Temporary integration record fragment ownership changed before cleanup"
    );
  }
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function settleRenamedTemporaryPath(
  path: string,
  expectedBeforeRename: BigIntStats,
  context: IntegrationStoreContext
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw new IntegrationPublishedOwnershipError(
      "Integration rename source disappearance could not be verified",
      { cause: error }
    );
  }
  try {
    assertProvableOwnedFile(current, "Temporary integration record fragment", context);
  } catch (error) {
    throw new IntegrationPublishedOwnershipError(
      "Integration rename source remained with unprovable ownership",
      { cause: error }
    );
  }
  if (!sameOwnedFileAcrossRename(expectedBeforeRename, current)) {
    throw new IntegrationPublishedOwnershipError(
      "Integration rename source remained but no longer matched the owned temporary file"
    );
  }
  await removeOwnedTemporaryPath(path, current);
}

async function readBoundedBytes(
  handle: FileHandle,
  label: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (true) {
    const remaining = MAX_JOURNAL_FILE_BYTES + 1 - total;
    if (remaining <= 0) {
      throw new Error(`${label} exceeds the byte limit`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    position += bytesRead;
  }
  if (total > MAX_JOURNAL_FILE_BYTES) {
    throw new Error(`${label} exceeds the byte limit`);
  }
  return Buffer.concat(chunks, total);
}

async function throwFileChanged(
  path: string,
  label: string,
  stage: string
): Promise<never> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new IntegrationFileChangedError(label, stage, true, { cause: error });
    }
    throw error;
  }
  throw new IntegrationFileChangedError(label, stage, false);
}

async function readConstrainedUtf8File(options: FileReadOptions): Promise<string> {
  const {
    context,
    initial,
    label,
    path,
    physicalParent,
    validateParent
  } = options;
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (context.platform === "win32" && initial.ino === 0n) {
    throw new Error(`${label} identity cannot be proven on this platform`);
  }
  const initialPhysicalPath = await realpath(path);
  if (!samePhysicalPath(dirname(initialPhysicalPath), physicalParent, context)) {
    throw new Error(`${label} escaped its private directory`);
  }
  await validateParent();
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(
        path,
        constants.O_RDONLY | (context.platform === "win32" ? 0 : constants.O_NOFOLLOW)
      );
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error.code === "ENOENT" || error.code === "ELOOP")
      ) {
        throw new IntegrationFileChangedError(label, "open", error.code === "ENOENT", {
          cause: error
        });
      }
      throw error;
    }
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(initial, opened)) {
      await throwFileChanged(path, label, "open identity validation");
    }
    if (opened.size > BigInt(MAX_JOURNAL_FILE_BYTES)) {
      throw new Error(`${label} exceeds the byte limit`);
    }
    const bytes = await readBoundedBytes(handle, label);
    const afterRead = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, afterRead) || BigInt(bytes.length) !== opened.size) {
      await throwFileChanged(path, label, "post-read identity validation");
    }
    await validateParent();
    let current: BigIntStats;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      throw new IntegrationFileChangedError(
        label,
        "path revalidation",
        isMissing(error),
        { cause: error }
      );
    }
    if (!sameFileIdentity(initial, current)) {
      await throwFileChanged(path, label, "path identity validation");
    }
    const currentPhysicalPath = await realpath(path);
    if (
      !samePhysicalPath(initialPhysicalPath, currentPhysicalPath, context)
      || !samePhysicalPath(dirname(currentPhysicalPath), physicalParent, context)
    ) {
      throw new IntegrationFileChangedError(label, "physical path revalidation", false);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} must contain valid UTF-8`, { cause: error });
    }
  } finally {
    await handle?.close();
  }
}

async function verifyOwnedPublishedFragment(
  path: string,
  expectedIdentity: BigIntStats,
  compareAcrossRename: boolean,
  expectedSource: string,
  storage: RecordsDirectoryStorage,
  context: IntegrationStoreContext
): Promise<BigIntStats> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    throw new IntegrationPublishedOwnershipError(
      "Integration published fragment path could not be verified",
      { cause: error }
    );
  }
  assertProvableOwnedFile(metadata, "Published integration record fragment", context);
  const sameIdentity = compareAcrossRename
    ? sameOwnedFileAcrossRename(expectedIdentity, metadata)
    : sameFileIdentity(expectedIdentity, metadata);
  if (!sameIdentity) {
    throw new IntegrationPublishedOwnershipError(
      "Integration published fragment does not match the owned file identity"
    );
  }
  let source: string;
  try {
    source = await readConstrainedUtf8File({
      context,
      initial: metadata,
      label: "Published integration record fragment",
      path,
      physicalParent: storage.physicalDirectory,
      validateParent: () => assertSameRecordsDirectory(storage, context)
    });
  } catch (error) {
    throw new IntegrationPublishedOwnershipError(
      "Integration published fragment could not be read through its owned path",
      { cause: error }
    );
  }
  if (source !== expectedSource) {
    throw new IntegrationPublishedOwnershipError(
      "Integration published fragment content does not match the owned record"
    );
  }
  await assertSameStateDirectory(storage.state, context);
  integrationFragmentSchema.parse(JSON.parse(source));
  return metadata;
}

async function verifyOpenedTemporaryFragment(
  path: string,
  handle: FileHandle,
  expectedIdentity: BigIntStats,
  storage: RecordsDirectoryStorage,
  context: IntegrationStoreContext
): Promise<void> {
  const initialPhysicalPath = await realpath(path);
  if (!samePhysicalPath(dirname(initialPhysicalPath), storage.physicalDirectory, context)) {
    throw new IntegrationPublishedOwnershipError(
      "Temporary integration record fragment escaped the bound storage"
    );
  }
  await assertSameRecordsStorage(storage, context);
  const [opened, current, currentPhysicalPath] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
    realpath(path)
  ]);
  if (
    !sameFileIdentity(expectedIdentity, opened)
    || !sameFileIdentity(expectedIdentity, current)
    || !samePhysicalPath(initialPhysicalPath, currentPhysicalPath, context)
    || !samePhysicalPath(dirname(currentPhysicalPath), storage.physicalDirectory, context)
  ) {
    throw new IntegrationPublishedOwnershipError(
      "Temporary integration record fragment changed before its content write"
    );
  }
  await assertSameRecordsStorage(storage, context);
}

async function secureDirectory(
  path: string,
  state: StateDirectoryProof,
  expected: DirectoryIdentity,
  context: IntegrationStoreContext
): Promise<string> {
  await assertSameStateDirectory(state, context);
  if (context.platform === "win32") {
    await assertSameDirectory(path, expected, context);
    const physicalDirectory = await realpath(path);
    if (!samePhysicalPath(dirname(physicalDirectory), state.physicalPath, context)) {
      throw new Error("Integration record directory escaped the state directory");
    }
    await assertSameDirectory(path, expected, context);
    if (!samePhysicalPath(await realpath(path), physicalDirectory, context)) {
      throw new Error("Integration record directory changed during the operation");
    }
    return physicalDirectory;
  }
  const physicalDirectory = await realpath(path);
  if (!samePhysicalPath(dirname(physicalDirectory), state.physicalPath, context)) {
    throw new Error("Integration record directory escaped the state directory");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isDirectory()
      || metadata.dev !== expected.device
      || metadata.ino !== expected.inode
    ) {
      throw new Error("Integration record directory changed during the operation");
    }
    if ((metadata.mode & 0o777n) !== 0o700n) {
      await handle.chmod(0o700);
    }
    const secured = await handle.stat({ bigint: true });
    if ((secured.mode & 0o777n) !== 0o700n) {
      throw new Error("Integration record directory must have private permissions");
    }
  } finally {
    await handle.close();
  }
  await assertSameDirectory(path, expected, context);
  if (!samePhysicalPath(await realpath(path), physicalDirectory, context)) {
    throw new Error("Integration record directory changed during the operation");
  }
  return physicalDirectory;
}

async function openRecordsDirectory(
  stateDirectory: string,
  create: boolean,
  context: IntegrationStoreContext,
  expectedState?: StateDirectoryProof
): Promise<RecordsDirectoryStorage | null> {
  const statePath = resolve(stateDirectory);
  if (create) {
    await mkdir(statePath, { recursive: true, mode: 0o700 });
  }
  let state: StateDirectoryProof;
  if (expectedState) {
    if (expectedState.path !== statePath) {
      throw new Error("Integration state directory proof does not match the requested path");
    }
    await assertSameStateDirectory(expectedState, context);
    state = expectedState;
  } else {
    try {
      state = await inspectStateDirectory(statePath, context);
    } catch (error) {
      if (!create && isMissing(error)) return null;
      throw error;
    }
  }
  const directory = recordsPath(statePath);
  if (create) {
    await assertSameStateDirectory(state, context);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    await assertSameStateDirectory(state, context);
  }
  let identity: DirectoryIdentity;
  try {
    identity = await inspectDirectory(directory, context);
  } catch (error) {
    if (!create && isMissing(error)) {
      await assertSameStateDirectory(state, context);
      return null;
    }
    throw error;
  }
  const physicalDirectory = await secureDirectory(directory, state, identity, context);
  const storage = { directory, identity, physicalDirectory, state };
  await assertSameRecordsStorage(storage, context);
  return storage;
}

async function readLegacyRecords(
  stateDirectory: string,
  context: IntegrationStoreContext,
  expectedState?: StateDirectoryProof
): Promise<IntegrationRecord[]> {
  const statePath = resolve(stateDirectory);
  let state: StateDirectoryProof;
  if (expectedState) {
    if (expectedState.path !== statePath) {
      throw new Error("Integration state directory proof does not match the requested path");
    }
    await assertSameStateDirectory(expectedState, context);
    state = expectedState;
  } else {
    try {
      state = await inspectStateDirectory(statePath, context);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  const path = resolve(statePath, INTEGRATIONS_FILE);
  if (dirname(path) !== statePath) {
    throw new Error("Legacy integration journal must remain inside the state directory");
  }
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      await assertSameStateDirectory(state, context);
      return [];
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Legacy integration journal must be a regular file");
  }
  let source: string;
  try {
    source = await readConstrainedUtf8File({
      context,
      initial: metadata,
      label: "Legacy integration journal",
      path,
      physicalParent: state.physicalPath,
      validateParent: () => assertSameStateDirectory(state, context)
    });
  } catch (error) {
    if (isMissing(error)) {
      throw new IntegrationFileChangedError(
        "Legacy integration journal",
        "post-sample read",
        true,
        { cause: error }
      );
    }
    throw error;
  }
  return integrationFileSchema.parse(JSON.parse(source)).records;
}

interface IntegrationFragmentSnapshot {
  changedDuringRead: boolean;
  fragments: IntegrationFragment[];
  storage?: RecordsDirectoryStorage;
}

async function readBoundedFragmentNames(directory: string): Promise<string[]> {
  const handle = await opendir(directory);
  const names: string[] = [];
  let entries = 0;
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_RECORD_DIRECTORY_ENTRIES) {
        throw new Error("Integration record directory exceeds the entry limit");
      }
      if (!fragmentNamePattern.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > MAX_RECORD_FRAGMENTS) {
        throw new Error("Integration record directory exceeds the fragment limit");
      }
    }
  } finally {
    await handle.close();
  }
  return names;
}

async function readFragmentBatch(
  storage: RecordsDirectoryStorage,
  fileNames: string[],
  context: IntegrationStoreContext
): Promise<IntegrationFragment[]> {
  const fragments: IntegrationFragment[] = [];
  for (let index = 0; index < fileNames.length; index += MAX_FRAGMENT_READ_CONCURRENCY) {
    const settled = await Promise.allSettled(
      fileNames.slice(index, index + MAX_FRAGMENT_READ_CONCURRENCY).map((fileName) =>
        readFragment(storage, fileName, context)
      )
    );
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failed) throw failed.reason;
    fragments.push(...settled.map((result) =>
      (result as PromiseFulfilledResult<IntegrationFragment>).value
    ));
  }
  return fragments;
}

async function readFragmentSnapshotAttempt(
  stateDirectory: string,
  context: IntegrationStoreContext,
  expectedState?: StateDirectoryProof,
  expectedStorage?: RecordsDirectoryStorage
): Promise<IntegrationFragmentSnapshot> {
  let storage: RecordsDirectoryStorage | null;
  if (expectedStorage) {
    if (expectedStorage.directory !== recordsPath(stateDirectory)) {
      throw new Error("Integration record storage proof does not match the requested path");
    }
    if (expectedState && expectedStorage.state !== expectedState) {
      throw new Error("Integration record storage proof does not match the state proof");
    }
    await assertSameRecordsStorage(expectedStorage, context);
    storage = expectedStorage;
  } else {
    storage = await openRecordsDirectory(
      stateDirectory,
      false,
      context,
      expectedState
    );
  }
  if (!storage) return { changedDuringRead: false, fragments: [] };
  const { directory } = storage;
  const initialNames = await readBoundedFragmentNames(directory);
  await assertSameRecordsStorage(storage, context);
  const fragments = await readFragmentBatch(storage, initialNames, context);
  await assertSameRecordsStorage(storage, context);
  const finalNames = await readBoundedFragmentNames(directory);
  await assertSameRecordsStorage(storage, context);
  if (
    initialNames.length !== finalNames.length
    || initialNames.some((name) => !finalNames.includes(name))
  ) {
    throw new IntegrationSnapshotChangedError("fragment name-set validation");
  }
  for (let index = 0; index < fragments.length; index += MAX_FRAGMENT_READ_CONCURRENCY) {
    const settled = await Promise.allSettled(
      fragments.slice(index, index + MAX_FRAGMENT_READ_CONCURRENCY).map(async (fragment) => {
        const path = join(directory, fragment.fileName);
        let current: BigIntStats;
        try {
          current = await lstat(path, { bigint: true });
        } catch (error) {
          if (isMissing(error)) {
            throw new IntegrationSnapshotChangedError(
              "final fragment identity validation",
              { cause: error }
            );
          }
          throw error;
        }
        if (!sameFileIdentity(fragment.identity, current)) {
          try {
            await throwFileChanged(
              path,
              "Integration record fragment",
              "final identity validation"
            );
          } catch (error) {
            if (error instanceof IntegrationFileChangedError && error.disappeared) {
              throw new IntegrationSnapshotChangedError(
                "final fragment identity validation",
                { cause: error }
              );
            }
            throw error;
          }
        }
      })
    );
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failed) throw failed.reason;
  }
  await assertSameRecordsStorage(storage, context);
  fragments.sort((left, right) => {
    if (left.publishedAt !== right.publishedAt) {
      return left.publishedAt > right.publishedAt ? -1 : 1;
    }
    return right.fileName.localeCompare(left.fileName);
  });
  return { changedDuringRead: false, fragments, storage };
}

async function readFragments(
  stateDirectory: string,
  context: IntegrationStoreContext,
  expectedState?: StateDirectoryProof,
  expectedStorage?: RecordsDirectoryStorage
): Promise<IntegrationFragmentSnapshot> {
  let changedDuringRead = false;
  let lastChange: IntegrationSnapshotChangedError | undefined;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await readFragmentSnapshotAttempt(
        stateDirectory,
        context,
        expectedState,
        expectedStorage
      );
      return {
        ...snapshot,
        changedDuringRead: changedDuringRead || snapshot.changedDuringRead
      };
    } catch (error) {
      if (!(error instanceof IntegrationSnapshotChangedError)) throw error;
      changedDuringRead = true;
      lastChange = error;
      const elapsed = Date.now() - startedAt;
      if (
        attempt + 1 >= MAX_SNAPSHOT_ATTEMPTS
        || elapsed >= MAX_SNAPSHOT_RETRY_BUDGET_MS
      ) {
        break;
      }
      const retryDelay = Math.min(
        2 ** Math.min(attempt, 6),
        MAX_SNAPSHOT_RETRY_DELAY_MS,
        MAX_SNAPSHOT_RETRY_BUDGET_MS - elapsed
      );
      if (retryDelay > 0) await delay(retryDelay);
    }
  }
  throw new IntegrationSnapshotUnavailableError({
    cause: lastChange
  });
}

async function readFragment(
  storage: RecordsDirectoryStorage,
  fileName: string,
  context: IntegrationStoreContext
): Promise<IntegrationFragment> {
  const { directory } = storage;
  const path = join(directory, fileName);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      throw new IntegrationSnapshotChangedError("fragment metadata sampling", { cause: error });
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Integration record fragment must be a regular file");
  }
  if (context.platform !== "win32" && (metadata.mode & 0o777n) !== 0o600n) {
    throw new Error("Integration record fragment must have private permissions");
  }
  let source: string;
  try {
    source = await readConstrainedUtf8File({
      context,
      initial: metadata,
      label: "Integration record fragment",
      path,
      physicalParent: storage.physicalDirectory,
      validateParent: () => assertSameRecordsDirectory(storage, context)
    });
  } catch (error) {
    if (
      isMissing(error)
      || (error instanceof IntegrationFileChangedError && error.disappeared)
    ) {
      throw new IntegrationSnapshotChangedError("fragment content read", { cause: error });
    }
    throw error;
  }
  const fragment = integrationFragmentSchema.parse(
    JSON.parse(source)
  );
  return {
    fileName,
    identity: metadata,
    publishedAt: metadata.ctimeNs,
    limit: fragment.limit,
    record: fragment.record
  };
}

async function cleanupOldFragments(
  stateDirectory: string,
  context: IntegrationStoreContext,
  expectedStorage: RecordsDirectoryStorage
): Promise<void> {
  const { fragments, storage } = await readFragments(
    stateDirectory,
    context,
    expectedStorage.state,
    expectedStorage
  );
  if (!storage) return;
  const { directory } = storage;
  await Promise.all(fragments.slice(MAX_RECORDS).map(async ({ fileName, identity }) => {
    await assertSameRecordsStorage(storage, context);
    const path = join(directory, fileName);
    let current: BigIntStats;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!sameFileIdentity(identity, current)) {
      throw new Error("Integration record fragment changed before cleanup");
    }
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await assertSameRecordsStorage(storage, context);
  }));
  await assertSameRecordsStorage(storage, context);
}

export interface IntegrationRecordJournal {
  changedDuringRead: boolean;
  records: IntegrationRecord[];
  orderedRecords: IntegrationRecord[];
}

interface IntegrationRecordJournalSnapshot extends IntegrationRecordJournal {
  storage?: RecordsDirectoryStorage;
}

function validateCrossVersionRecordIds(records: IntegrationRecord[]): void {
  const versions = new Map<string, IntegrationRecord["schemaVersion"]>();
  for (const record of records) {
    const version = versions.get(record.id);
    if (version !== undefined && version !== record.schemaVersion) {
      throw new Error("Integration record ID cannot be reused across schema versions");
    }
    versions.set(record.id, record.schemaVersion);
  }
}

async function readIntegrationRecordJournalWithContext(
  stateDirectory: string,
  context: IntegrationStoreContext,
  expectedState?: StateDirectoryProof,
  expectedStorage?: RecordsDirectoryStorage
): Promise<IntegrationRecordJournalSnapshot> {
  const statePath = resolve(stateDirectory);
  let state: StateDirectoryProof;
  if (expectedStorage) {
    if (expectedStorage.directory !== recordsPath(stateDirectory)) {
      throw new Error("Integration record storage proof does not match the requested path");
    }
    await assertSameRecordsStorage(expectedStorage, context);
    state = expectedStorage.state;
  } else if (expectedState) {
    if (expectedState.path !== statePath) {
      throw new Error("Integration state directory proof does not match the requested path");
    }
    await assertSameStateDirectory(expectedState, context);
    state = expectedState;
  } else {
    try {
      state = await inspectStateDirectory(statePath, context);
    } catch (error) {
      if (isMissing(error)) {
        return { changedDuringRead: false, orderedRecords: [], records: [] };
      }
      throw error;
    }
  }
  const [fragmentSnapshot, legacy] = await Promise.all([
    readFragments(stateDirectory, context, state, expectedStorage),
    readLegacyRecords(stateDirectory, context, state)
  ]);
  if (fragmentSnapshot.storage) {
    await assertSameRecordsStorage(fragmentSnapshot.storage, context);
  } else {
    await assertSameStateDirectory(state, context);
  }
  const { changedDuringRead, fragments } = fragmentSnapshot;
  const orderedRecords = [...fragments.map(({ record }) => record), ...legacy];
  validateCrossVersionRecordIds(orderedRecords);
  const limit = fragments[0]?.limit ?? MAX_RECORDS;
  const records: IntegrationRecord[] = [];
  const seen = new Set<string>();
  for (const record of orderedRecords) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
    if (records.length === limit) break;
  }
  return {
    changedDuringRead,
    orderedRecords,
    records,
    ...(fragmentSnapshot.storage ? { storage: fragmentSnapshot.storage } : {})
  };
}

async function readIntegrationRecordsWithContext(
  stateDirectory: string,
  context: IntegrationStoreContext
): Promise<IntegrationRecord[]> {
  return (await readIntegrationRecordJournalWithContext(stateDirectory, context)).records;
}

async function appendIntegrationRecordWithContext(
  stateDirectory: string,
  input: IntegrationRecord,
  options: { limit?: number },
  context: IntegrationStoreContext
): Promise<void> {
  const limit = options.limit ?? MAX_RECORDS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    throw new Error(`Integration record limit must be between 1 and ${MAX_RECORDS}`);
  }
  const record = integrationRecordSchema.parse(input);
  const fragment = integrationFragmentSchema.parse({
    schemaVersion: record.schemaVersion,
    limit,
    record
  });
  const serialized = `${JSON.stringify(fragment, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_FILE_BYTES) {
    throw new Error("Integration record fragment exceeds the byte limit");
  }
  const statePath = resolve(stateDirectory);
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const publicationState = await inspectStateDirectory(statePath, context);
  let storage = await openRecordsDirectory(
    stateDirectory,
    false,
    context,
    publicationState
  );
  if (!storage) {
    const prevalidation = await readIntegrationRecordJournalWithContext(
      stateDirectory,
      context,
      publicationState
    );
    validateCrossVersionRecordIds([...prevalidation.orderedRecords, record]);
    storage = await openRecordsDirectory(
      stateDirectory,
      true,
      context,
      publicationState
    );
  }
  if (!storage) throw new Error("Integration record directory was not created");
  const { directory } = storage;
  const publicationValidation = await readIntegrationRecordJournalWithContext(
    stateDirectory,
    context,
    publicationState,
    storage
  );
  validateCrossVersionRecordIds([...publicationValidation.orderedRecords, record]);
  await assertSameRecordsStorage(storage, context);
  const unique = randomUUID();
  const temporary = join(directory, `.${process.pid}-${unique}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | (context.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    0o600
  );
  let temporaryIdentity: BigIntStats | undefined;
  let destinationMayExist = false;
  let temporaryNeedsCleanup = true;
  let publishedIdentity: BigIntStats | undefined;
  let destination: string | undefined;
  try {
    const initialTemporaryIdentity = await handle.stat({ bigint: true });
    assertProvableOwnedFile(
      initialTemporaryIdentity,
      "Temporary integration record fragment",
      context
    );
    temporaryIdentity = initialTemporaryIdentity;
    await verifyOpenedTemporaryFragment(
      temporary,
      handle,
      temporaryIdentity,
      storage,
      context
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    if (context.platform !== "win32") await handle.chmod(0o600);
    const writtenTemporaryIdentity = await handle.stat({ bigint: true });
    assertProvableOwnedFile(
      writtenTemporaryIdentity,
      "Temporary integration record fragment",
      context
    );
    temporaryIdentity = writtenTemporaryIdentity;
    if (writtenTemporaryIdentity.size !== BigInt(Buffer.byteLength(serialized))) {
      throw new Error("Temporary integration record fragment size changed before publication");
    }
    await handle.close();
    processSequence += 1;
    destination = join(
      directory,
      `${Date.now()}-${process.pid}-${String(processSequence).padStart(12, "0")}-${unique}.json`
    );
    await assertSameRecordsStorage(storage, context);
    try {
      await rename(temporary, destination);
    } catch (renameError) {
      const settleOwnedTemporary = async (uncertaintyCause: unknown): Promise<unknown> => {
        temporaryNeedsCleanup = false;
        try {
          await removeOwnedTemporaryPath(temporary, writtenTemporaryIdentity);
          return uncertaintyCause;
        } catch (cleanupError) {
          return new AggregateError(
            [uncertaintyCause, cleanupError],
            "Integration rename outcome and temporary-fragment cleanup both failed"
          );
        }
      };
      let destinationMetadata: BigIntStats;
      try {
        destinationMetadata = await lstat(destination, { bigint: true });
      } catch (probeError) {
        if (isMissing(probeError)) {
          let temporaryCurrent: BigIntStats;
          try {
            temporaryCurrent = await lstat(temporary, { bigint: true });
          } catch (temporaryProbeError) {
            temporaryNeedsCleanup = false;
            throw new IntegrationJournalCommitUncertainError(
              renameError,
              temporaryProbeError
            );
          }
          if (sameFileIdentity(writtenTemporaryIdentity, temporaryCurrent)) {
            throw renameError;
          }
          temporaryNeedsCleanup = false;
          throw new IntegrationJournalCommitUncertainError(
            renameError,
            new IntegrationPublishedOwnershipError(
              "Integration rename left neither a provably absent destination nor the owned temporary file"
            )
          );
        }
        destinationMayExist = true;
        throw new IntegrationJournalCommitUncertainError(
          renameError,
          await settleOwnedTemporary(probeError)
        );
      }
      destinationMayExist = true;
      if (!sameOwnedFileAcrossRename(writtenTemporaryIdentity, destinationMetadata)) {
        const ownershipError = new IntegrationPublishedOwnershipError(
          "Integration rename destination does not match the owned temporary file"
        );
        throw new IntegrationJournalCommitUncertainError(
          renameError,
          await settleOwnedTemporary(ownershipError)
        );
      }
      temporaryNeedsCleanup = false;
      try {
        await settleRenamedTemporaryPath(
          temporary,
          writtenTemporaryIdentity,
          context
        );
      } catch (sourceError) {
        throw new IntegrationJournalCommitUncertainError(renameError, sourceError);
      }
      try {
        publishedIdentity = await verifyOwnedPublishedFragment(
          destination,
          writtenTemporaryIdentity,
          true,
          serialized,
          storage,
          context
        );
      } catch (verificationError) {
        throw new IntegrationJournalCommitUncertainError(renameError, verificationError);
      }
      throw new IntegrationJournalCommitUncertainError(
        renameError,
        new IntegrationPublishedOwnershipError(
          "Integration rename reported failure after the owned destination appeared"
        )
      );
    }
    destinationMayExist = true;
    temporaryNeedsCleanup = false;
    try {
      await settleRenamedTemporaryPath(
        temporary,
        writtenTemporaryIdentity,
        context
      );
    } catch (sourceError) {
      throw new IntegrationJournalCommitUncertainError(
        new IntegrationPublishedOwnershipError(
          "Integration rename returned success without proving source removal"
        ),
        sourceError
      );
    }
    await assertSameRecordsStorage(storage, context);
    publishedIdentity = await verifyOwnedPublishedFragment(
      destination,
      writtenTemporaryIdentity,
      true,
      serialized,
      storage,
      context
    );
    await cleanupOldFragments(stateDirectory, context, storage);
    await readIntegrationRecordJournalWithContext(
      stateDirectory,
      context,
      publicationState,
      storage
    );
    publishedIdentity = await verifyOwnedPublishedFragment(
      destination,
      publishedIdentity,
      false,
      serialized,
      storage,
      context
    );
  } catch (error) {
    if (destinationMayExist && destination) {
      if (!publishedIdentity) {
        if (error instanceof IntegrationJournalCommitUncertainError) throw error;
        throw new IntegrationJournalCommitUncertainError(
          error,
          new IntegrationPublishedOwnershipError(
            "Integration published fragment ownership was not verified"
          )
        );
      }
      try {
        await removeOwnedPath(destination, publishedIdentity, storage, context);
      } catch (cleanupError) {
        throw new IntegrationJournalCommitUncertainError(error, cleanupError);
      }
    }
    throw error;
  } finally {
    try {
      await handle.close();
    } catch {
      // The handle was already closed after a successful flush.
    }
    if (temporaryNeedsCleanup && temporaryIdentity) {
      try {
        await removeOwnedTemporaryPath(temporary, temporaryIdentity);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

async function latestIntegrationRecordWithContext(
  stateDirectory: string,
  harness: IntegrationRecord["harness"],
  context: IntegrationStoreContext
): Promise<IntegrationRecord | null> {
  return (await readIntegrationRecordsWithContext(stateDirectory, context)).find(
    (record) => record.harness === harness
  ) ?? null;
}

export function createIntegrationRecordStore(
  options: { platform?: NodeJS.Platform } = {}
): IntegrationRecordStore {
  const context: IntegrationStoreContext = {
    platform: options.platform ?? process.platform
  };
  return {
    readIntegrationRecords: (stateDirectory) =>
      readIntegrationRecordsWithContext(stateDirectory, context),
    appendIntegrationRecord: (stateDirectory, input, appendOptions = {}) =>
      appendIntegrationRecordWithContext(stateDirectory, input, appendOptions, context),
    latestIntegrationRecord: (stateDirectory, harness) =>
      latestIntegrationRecordWithContext(stateDirectory, harness, context)
  };
}

export async function readIntegrationRecords(
  stateDirectory: string
): Promise<IntegrationRecord[]> {
  return readIntegrationRecordsWithContext(stateDirectory, defaultContext);
}

export async function readIntegrationRecordJournal(
  stateDirectory: string
): Promise<IntegrationRecordJournal> {
  const { changedDuringRead, orderedRecords, records } =
    await readIntegrationRecordJournalWithContext(stateDirectory, defaultContext);
  return { changedDuringRead, orderedRecords, records };
}

export async function appendIntegrationRecord(
  stateDirectory: string,
  input: IntegrationRecord,
  options: { limit?: number } = {}
): Promise<void> {
  return appendIntegrationRecordWithContext(stateDirectory, input, options, defaultContext);
}

export async function latestIntegrationRecord(
  stateDirectory: string,
  harness: IntegrationRecord["harness"]
): Promise<IntegrationRecord | null> {
  return latestIntegrationRecordWithContext(stateDirectory, harness, defaultContext);
}
