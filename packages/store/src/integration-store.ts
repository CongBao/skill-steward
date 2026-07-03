import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const INTEGRATIONS_FILE = "integrations.json";
const INTEGRATION_RECORDS_DIRECTORY = "integration-records";
const MAX_RECORDS = 100;
const fragmentNamePattern = /^[1-9][0-9]*-[1-9][0-9]*-[0-9]{12}-[0-9a-f-]{36}\.json$/;

export const integrationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  harness: z.enum(["codex", "claude-code", "github-copilot"]),
  action: z.enum(["apply", "remove"]),
  status: z.enum(["installed", "removed"]),
  targetPath: z.string().min(1),
  backupPath: z.string().min(1).optional(),
  beforeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  afterFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  installedEntryFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
});

const integrationFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(integrationRecordSchema).max(MAX_RECORDS)
});

const integrationFragmentSchema = z.object({
  schemaVersion: z.literal(1),
  limit: z.number().int().min(1).max(MAX_RECORDS),
  record: integrationRecordSchema
}).strict();

export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;

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
  publishedAt: bigint;
  limit: number;
  record: IntegrationRecord;
}

let processSequence = 0;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface DirectoryIdentity {
  device: number;
  inode: number;
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

function recordsPath(stateDirectory: string): string {
  const statePath = resolve(stateDirectory);
  const directory = resolve(statePath, INTEGRATION_RECORDS_DIRECTORY);
  if (dirname(directory) !== statePath) {
    throw new Error("Integration record directory must remain inside the state directory");
  }
  return directory;
}

async function inspectDirectory(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw Object.assign(
      new Error("EEXIST: Integration record storage must be a regular directory"),
      { code: "EEXIST" }
    );
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertSameDirectory(
  path: string,
  expected: DirectoryIdentity
): Promise<void> {
  const actual = await inspectDirectory(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Integration record directory changed during the operation");
  }
}

async function secureDirectory(
  path: string,
  statePath: string,
  expected: DirectoryIdentity,
  context: IntegrationStoreContext
): Promise<void> {
  if (context.platform === "win32") {
    await assertSameDirectory(path, expected);
    const [physicalState, physicalDirectory] = await Promise.all([
      realpath(statePath),
      realpath(path)
    ]);
    if (dirname(physicalDirectory).toLowerCase() !== physicalState.toLowerCase()) {
      throw new Error("Integration record directory escaped the state directory");
    }
    await assertSameDirectory(path, expected);
    if ((await realpath(path)).toLowerCase() !== physicalDirectory.toLowerCase()) {
      throw new Error("Integration record directory changed during the operation");
    }
    return;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory()
      || metadata.dev !== expected.device
      || metadata.ino !== expected.inode
    ) {
      throw new Error("Integration record directory changed during the operation");
    }
    await handle.chmod(0o700);
    const secured = await handle.stat();
    if ((secured.mode & 0o777) !== 0o700) {
      throw new Error("Integration record directory must have private permissions");
    }
  } finally {
    await handle.close();
  }
  await assertSameDirectory(path, expected);
}

async function openRecordsDirectory(
  stateDirectory: string,
  create: boolean,
  context: IntegrationStoreContext
): Promise<{ directory: string; identity: DirectoryIdentity } | null> {
  const statePath = resolve(stateDirectory);
  if (create) {
    await mkdir(statePath, { recursive: true, mode: 0o700 });
  }
  try {
    await inspectDirectory(statePath);
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
  const directory = recordsPath(statePath);
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  }
  let identity: DirectoryIdentity;
  try {
    identity = await inspectDirectory(directory);
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
  await secureDirectory(directory, statePath, identity, context);
  return { directory, identity };
}

async function readLegacyRecords(stateDirectory: string): Promise<IntegrationRecord[]> {
  try {
    const source = await readFile(join(stateDirectory, INTEGRATIONS_FILE), "utf8");
    return integrationFileSchema.parse(JSON.parse(source)).records;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readFragments(
  stateDirectory: string,
  context: IntegrationStoreContext
): Promise<IntegrationFragment[]> {
  const storage = await openRecordsDirectory(stateDirectory, false, context);
  if (!storage) return [];
  const { directory, identity } = storage;
  const entries = await readdir(directory, { withFileTypes: true });
  await assertSameDirectory(directory, identity);
  const fragments = await Promise.all(entries.flatMap((entry) =>
    entry.isFile() && fragmentNamePattern.test(entry.name)
      ? [readFragment(directory, entry.name, context).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      })]
      : []
  ));
  return fragments.filter((fragment): fragment is IntegrationFragment => fragment !== null)
    .sort((left, right) => {
      if (left.publishedAt !== right.publishedAt) {
        return left.publishedAt > right.publishedAt ? -1 : 1;
      }
      return right.fileName.localeCompare(left.fileName);
    });
}

async function readFragment(
  directory: string,
  fileName: string,
  context: IntegrationStoreContext
): Promise<IntegrationFragment> {
  const path = join(directory, fileName);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Integration record fragment must be a regular file");
  }
  if (context.platform !== "win32" && (metadata.mode & 0o777n) !== 0o600n) {
    throw new Error("Integration record fragment must have private permissions");
  }
  const fragment = integrationFragmentSchema.parse(
    JSON.parse(await readFile(path, "utf8"))
  );
  return {
    fileName,
    publishedAt: metadata.ctimeNs,
    limit: fragment.limit,
    record: fragment.record
  };
}

async function cleanupOldFragments(
  stateDirectory: string,
  context: IntegrationStoreContext
): Promise<void> {
  const fragments = await readFragments(stateDirectory, context);
  const directory = recordsPath(stateDirectory);
  await Promise.all(fragments.slice(MAX_RECORDS).map(async ({ fileName }) => {
    try {
      await unlink(join(directory, fileName));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }));
}

async function readIntegrationRecordsWithContext(
  stateDirectory: string,
  context: IntegrationStoreContext
): Promise<IntegrationRecord[]> {
  const [fragments, legacy] = await Promise.all([
    readFragments(stateDirectory, context),
    readLegacyRecords(stateDirectory)
  ]);
  const limit = fragments[0]?.limit ?? MAX_RECORDS;
  const records: IntegrationRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...fragments.map(({ record }) => record), ...legacy]) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
    if (records.length === limit) break;
  }
  return records;
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
  const fragment = integrationFragmentSchema.parse({
    schemaVersion: 1,
    limit,
    record: integrationRecordSchema.parse(input)
  });
  await readLegacyRecords(stateDirectory);
  await readFragments(stateDirectory, context);
  const serialized = `${JSON.stringify(fragment, null, 2)}\n`;
  const storage = await openRecordsDirectory(stateDirectory, true, context);
  if (!storage) throw new Error("Integration record directory was not created");
  const { directory, identity } = storage;
  const unique = randomUUID();
  const temporary = join(directory, `.${process.pid}-${unique}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  let destination: string | undefined;
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    if (context.platform !== "win32") await handle.chmod(0o600);
    await handle.close();
    processSequence += 1;
    destination = join(
      directory,
      `${Date.now()}-${process.pid}-${String(processSequence).padStart(12, "0")}-${unique}.json`
    );
    await assertSameDirectory(directory, identity);
    await rename(temporary, destination);
    published = true;
    const publishedMetadata = await lstat(destination);
    if (publishedMetadata.isSymbolicLink() || !publishedMetadata.isFile()) {
      throw new Error("Integration record fragment must be a regular file");
    }
    if (
      context.platform !== "win32"
      && (publishedMetadata.mode & 0o777) !== 0o600
    ) {
      throw new Error("Integration record fragment must have private permissions");
    }
    await cleanupOldFragments(stateDirectory, context);
  } catch (error) {
    if (published && destination) {
      try {
        await unlink(destination);
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) {
          throw new IntegrationJournalCommitUncertainError(error, cleanupError);
        }
      }
    }
    throw error;
  } finally {
    try {
      await handle.close();
    } catch {
      // The handle was already closed after a successful flush.
    }
    if (!published) {
      try {
        await unlink(temporary);
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
