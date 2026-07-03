import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const REVIEWED_PLANS_DIRECTORY = "reviewed-plans";
const MAX_CLEANUP_FILES = 1_000;
const CRASH_RESIDUE_GRACE_MS = 60 * 60 * 1_000;
const REVIEWED_PLAN_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const reviewedPlanIdSchema = z.string().regex(
  new RegExp(`^${REVIEWED_PLAN_ID_PATTERN}$`)
);
const pendingPlanNamePattern = new RegExp(`^(${REVIEWED_PLAN_ID_PATTERN})\\.json$`);
const temporaryNamePattern = new RegExp(
  `^\\.(${REVIEWED_PLAN_ID_PATTERN})\\.[1-9][0-9]*-${UUID_V4_PATTERN}\\.tmp$`
);
const claimedNamePattern = new RegExp(
  `^(${REVIEWED_PLAN_ID_PATTERN})\\.[1-9][0-9]*-${UUID_V4_PATTERN}\\.claimed$`
);
const cleanupNamePattern = new RegExp(
  `^\\.(${REVIEWED_PLAN_ID_PATTERN})\\.[1-9][0-9]*-${UUID_V4_PATTERN}\\.cleanup$`
);
const reviewedPlanKindSchema = z.enum([
  "installation",
  "governance",
  "integration",
  "evidence-policy",
  "evidence-erase"
]);

export type ReviewedPlanKind = z.infer<typeof reviewedPlanKindSchema>;

export interface ReviewedPlanEnvelope<TPayload = unknown> {
  schemaVersion: 1;
  id: string;
  kind: ReviewedPlanKind;
  createdAt: string;
  expiresAt: string;
  payload: TPayload;
}

export type ReviewedPlanStoreErrorCode =
  | "REVIEWED_PLAN_NOT_FOUND"
  | "REVIEWED_PLAN_EXPIRED"
  | "REVIEWED_PLAN_KIND_MISMATCH"
  | "REVIEWED_PLAN_INVALID"
  | "REVIEWED_PLAN_CONFLICT"
  | "REVIEWED_PLAN_UNSAFE_STATE";

export class ReviewedPlanStoreError extends Error {
  constructor(
    public readonly code: ReviewedPlanStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReviewedPlanStoreError";
  }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) {
          return false;
        }
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

const reviewedPlanEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: reviewedPlanIdSchema,
  kind: reviewedPlanKindSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payload: z.custom<unknown>(isJsonValue, "Reviewed plan payload must be JSON-serializable")
}).strict().refine(
  ({ createdAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(createdAt),
  { path: ["expiresAt"], message: "Reviewed plan expiry must be after creation" }
);

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function storeError(
  code: ReviewedPlanStoreErrorCode,
  message: string
): ReviewedPlanStoreError {
  return new ReviewedPlanStoreError(code, message);
}

function normalizeStoreError(error: unknown, operation: string): ReviewedPlanStoreError {
  if (error instanceof ReviewedPlanStoreError) return error;
  return storeError(
    "REVIEWED_PLAN_UNSAFE_STATE",
    `Unable to ${operation} reviewed plan state safely`
  );
}

function parseId(id: string): string {
  const parsed = reviewedPlanIdSchema.safeParse(id);
  if (!parsed.success) {
    throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan ID is unsafe");
  }
  return parsed.data;
}

function parseKind(kind: ReviewedPlanKind): ReviewedPlanKind {
  const parsed = reviewedPlanKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan kind is invalid");
  }
  return parsed.data;
}

function parseNow(now: Date): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan timestamp is invalid");
  }
  return timestamp;
}

function parseEnvelope(input: unknown): ReviewedPlanEnvelope {
  const parsed = reviewedPlanEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan envelope is invalid");
  }
  return parsed.data as ReviewedPlanEnvelope;
}

function reviewedPlansPath(stateDirectory: string): string {
  if (typeof stateDirectory !== "string" || stateDirectory.length === 0) {
    throw storeError("REVIEWED_PLAN_UNSAFE_STATE", "Reviewed plan state directory is invalid");
  }
  const statePath = resolve(stateDirectory);
  const directory = resolve(statePath, REVIEWED_PLANS_DIRECTORY);
  if (dirname(directory) !== statePath) {
    throw storeError("REVIEWED_PLAN_UNSAFE_STATE", "Reviewed plan directory escapes state");
  }
  return directory;
}

async function inspectDirectory(path: string): Promise<"missing" | "directory"> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw storeError(
        "REVIEWED_PLAN_UNSAFE_STATE",
        "Reviewed plan state must use physical directories"
      );
    }
    return "directory";
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function reviewedPlansDirectory(
  stateDirectory: string,
  create: boolean
): Promise<string | undefined> {
  const directory = reviewedPlansPath(stateDirectory);
  const statePath = dirname(directory);
  let stateStatus = await inspectDirectory(statePath);
  if (stateStatus === "missing" && create) {
    await mkdir(statePath, { recursive: true, mode: 0o700 });
    stateStatus = await inspectDirectory(statePath);
  }
  if (stateStatus === "missing") return undefined;

  let directoryStatus = await inspectDirectory(directory);
  if (directoryStatus === "missing" && create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    directoryStatus = await inspectDirectory(directory);
  }
  if (directoryStatus === "missing") return undefined;

  await chmod(directory, 0o700);
  await inspectDirectory(directory);
  return directory;
}

async function inspectPlanFile(path: string): Promise<"missing" | "file"> {
  return (await inspectPlanFileMetadata(path)) === undefined ? "missing" : "file";
}

async function inspectPlanFileMetadata(path: string): Promise<Stats | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw storeError(
        "REVIEWED_PLAN_UNSAFE_STATE",
        "Reviewed plan path must be a regular non-symlink file"
      );
    }
    return metadata;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readRegularFile(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw storeError(
        "REVIEWED_PLAN_UNSAFE_STATE",
        "Reviewed plan path must be a regular file"
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (isFileSystemError(error, "ELOOP")) {
      throw storeError(
        "REVIEWED_PLAN_UNSAFE_STATE",
        "Reviewed plan path must not be a symlink"
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function writeReviewedPlan<TPayload>(
  stateDirectory: string,
  input: ReviewedPlanEnvelope<TPayload>
): Promise<void> {
  try {
    const envelope = parseEnvelope(input);
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    const directory = await reviewedPlansDirectory(stateDirectory, true);
    if (directory === undefined) {
      throw storeError("REVIEWED_PLAN_UNSAFE_STATE", "Reviewed plan directory is unavailable");
    }
    const destination = resolve(directory, `${envelope.id}.json`);
    if (dirname(destination) !== directory) {
      throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan ID escapes state");
    }
    const temporary = resolve(
      directory,
      `.${envelope.id}.${process.pid}-${randomUUID()}.tmp`
    );
    let temporaryCreated = false;
    try {
      const destinationStatus = await inspectPlanFile(destination);
      if (destinationStatus === "file") {
        throw storeError("REVIEWED_PLAN_CONFLICT", "Reviewed plan already exists");
      }

      const temporaryHandle = await open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await temporaryHandle.writeFile(serialized, "utf8");
        await temporaryHandle.sync();
        await temporaryHandle.chmod(0o600);
      } finally {
        await temporaryHandle.close();
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw storeError("REVIEWED_PLAN_CONFLICT", "Reviewed plan already exists");
        }
        throw error;
      }
      await removeFile(temporary);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) await removeFile(temporary);
    }
  } catch (error) {
    throw normalizeStoreError(error, "write");
  }
}

export async function claimReviewedPlan(
  stateDirectory: string,
  input: { id: string; kind: ReviewedPlanKind; now?: Date }
): Promise<ReviewedPlanEnvelope<unknown>> {
  try {
    const id = parseId(input.id);
    const kind = parseKind(input.kind);
    const now = parseNow(input.now ?? new Date());
    const directory = await reviewedPlansDirectory(stateDirectory, false);
    if (directory === undefined) {
      throw storeError("REVIEWED_PLAN_NOT_FOUND", "Reviewed plan was not found");
    }
    const pending = resolve(directory, `${id}.json`);
    if (dirname(pending) !== directory || await inspectPlanFile(pending) === "missing") {
      throw storeError("REVIEWED_PLAN_NOT_FOUND", "Reviewed plan was not found");
    }
    const claimed = resolve(
      directory,
      `${id}.${process.pid}-${randomUUID()}.claimed`
    );
    try {
      await rename(pending, claimed);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw storeError("REVIEWED_PLAN_NOT_FOUND", "Reviewed plan was already claimed");
      }
      throw error;
    }

    try {
      let envelope: ReviewedPlanEnvelope;
      try {
        envelope = parseEnvelope(JSON.parse(await readRegularFile(claimed)) as unknown);
      } catch (error) {
        if (error instanceof ReviewedPlanStoreError) throw error;
        throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan content is invalid");
      }
      if (envelope.id !== id) {
        throw storeError("REVIEWED_PLAN_INVALID", "Reviewed plan ID does not match its file");
      }
      if (envelope.kind !== kind) {
        throw storeError(
          "REVIEWED_PLAN_KIND_MISMATCH",
          "Reviewed plan kind does not match the requested action"
        );
      }
      if (Date.parse(envelope.expiresAt) <= now) {
        throw storeError("REVIEWED_PLAN_EXPIRED", "Reviewed plan has expired");
      }
      return envelope;
    } finally {
      await removeFile(claimed);
    }
  } catch (error) {
    throw normalizeStoreError(error, "claim");
  }
}

export async function discardReviewedPlan(
  stateDirectory: string,
  inputId: string
): Promise<void> {
  try {
    const id = parseId(inputId);
    const directory = await reviewedPlansDirectory(stateDirectory, false);
    if (directory === undefined) return;
    const pending = resolve(directory, `${id}.json`);
    if (await inspectPlanFile(pending) === "missing") return;
    const owned = cleanupPath(directory, id);
    try {
      await rename(pending, owned);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    if (await inspectPlanFile(owned) === "file") await removeFile(owned);
  } catch (error) {
    throw normalizeStoreError(error, "discard");
  }
}

export async function cleanupExpiredReviewedPlans(
  stateDirectory: string,
  inputNow: Date = new Date()
): Promise<number> {
  try {
    const now = parseNow(inputNow);
    const directory = await reviewedPlansDirectory(stateDirectory, false);
    if (directory === undefined) return 0;
    let removed = 0;
    let inspected = 0;
    for await (const entry of await opendir(directory)) {
      const pendingMatch = pendingPlanNamePattern.exec(entry.name);
      const isCrashResidue = temporaryNamePattern.test(entry.name)
        || claimedNamePattern.test(entry.name)
        || cleanupNamePattern.test(entry.name);
      if (!pendingMatch && !isCrashResidue) continue;
      inspected += 1;
      const path = resolve(directory, entry.name);
      if (dirname(path) === directory) {
        if (pendingMatch) {
          const id = pendingMatch[1];
          if (id !== undefined && await cleanupPendingPlan(path, id, now)) removed += 1;
        } else {
          const metadata = await inspectPlanFileMetadata(path);
          if (
            metadata !== undefined
            && now - metadata.mtimeMs > CRASH_RESIDUE_GRACE_MS
            && await removeFile(path)
          ) {
            removed += 1;
          }
        }
      }
      if (inspected >= MAX_CLEANUP_FILES) break;
    }
    return removed;
  } catch (error) {
    throw normalizeStoreError(error, "clean up");
  }
}

async function cleanupPendingPlan(
  pending: string,
  id: string,
  now: number
): Promise<boolean> {
  if (await inspectPlanFile(pending) === "missing") return false;
  const owned = cleanupPath(dirname(pending), id);
  try {
    await rename(pending, owned);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }

  let source: string;
  try {
    source = await readRegularFile(owned);
  } catch (error) {
    await restoreOwnedPlan(owned, pending);
    throw error;
  }
  let envelope: ReviewedPlanEnvelope;
  try {
    envelope = parseEnvelope(JSON.parse(source) as unknown);
  } catch (error) {
    if (
      error instanceof SyntaxError
      || (
        error instanceof ReviewedPlanStoreError
        && error.code === "REVIEWED_PLAN_INVALID"
      )
    ) {
      return removeFile(owned);
    }
    await restoreOwnedPlan(owned, pending);
    throw error;
  }
  if (envelope.id !== id || Date.parse(envelope.expiresAt) <= now) {
    return removeFile(owned);
  }
  await restoreOwnedPlan(owned, pending);
  return false;
}

function cleanupPath(directory: string, id: string): string {
  return resolve(
    directory,
    `.${id}.${process.pid}-${randomUUID()}.cleanup`
  );
}

async function restoreOwnedPlan(owned: string, pending: string): Promise<void> {
  if (await inspectPlanFile(owned) === "missing") {
    throw storeError(
      "REVIEWED_PLAN_UNSAFE_STATE",
      "Owned reviewed plan disappeared before it could be restored"
    );
  }
  try {
    await link(owned, pending);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      throw storeError(
        "REVIEWED_PLAN_UNSAFE_STATE",
        "Reviewed plan could not be restored without overwriting newer state"
      );
    }
    throw error;
  }
  await removeFile(owned);
}
