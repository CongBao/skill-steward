import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink
} from "node:fs/promises";
import { join } from "node:path";
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

interface IntegrationFragment {
  fileName: string;
  modifiedAt: bigint;
  limit: number;
  record: IntegrationRecord;
}

let processSequence = 0;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

async function readFragments(stateDirectory: string): Promise<IntegrationFragment[]> {
  const directory = join(stateDirectory, INTEGRATION_RECORDS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const fragments = await Promise.all(entries.flatMap((entry) =>
    entry.isFile() && fragmentNamePattern.test(entry.name)
      ? [readFragment(directory, entry.name)]
      : []
  ));
  return fragments.sort((left, right) => {
    if (left.modifiedAt !== right.modifiedAt) {
      return left.modifiedAt > right.modifiedAt ? -1 : 1;
    }
    return right.fileName.localeCompare(left.fileName);
  });
}

async function readFragment(
  directory: string,
  fileName: string
): Promise<IntegrationFragment> {
  const path = join(directory, fileName);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Integration record fragment must be a regular file");
  }
  const fragment = integrationFragmentSchema.parse(
    JSON.parse(await readFile(path, "utf8"))
  );
  return {
    fileName,
    modifiedAt: metadata.mtimeNs,
    limit: fragment.limit,
    record: fragment.record
  };
}

async function cleanupOldFragments(stateDirectory: string): Promise<void> {
  let fragments: IntegrationFragment[];
  try {
    fragments = await readFragments(stateDirectory);
  } catch {
    return;
  }
  await Promise.allSettled(
    fragments.slice(MAX_RECORDS).map(({ fileName }) =>
      unlink(join(stateDirectory, INTEGRATION_RECORDS_DIRECTORY, fileName))
    )
  );
}

export async function readIntegrationRecords(
  stateDirectory: string
): Promise<IntegrationRecord[]> {
  const [fragments, legacy] = await Promise.all([
    readFragments(stateDirectory),
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

export async function appendIntegrationRecord(
  stateDirectory: string,
  input: IntegrationRecord,
  options: { limit?: number } = {}
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
  const serialized = `${JSON.stringify(fragment, null, 2)}\n`;
  const directory = join(stateDirectory, INTEGRATION_RECORDS_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unique = randomUUID();
  const temporary = join(directory, `.${process.pid}-${unique}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    processSequence += 1;
    const destination = join(
      directory,
      `${Date.now()}-${process.pid}-${String(processSequence).padStart(12, "0")}-${unique}.json`
    );
    await rename(temporary, destination);
    published = true;
    await cleanupOldFragments(stateDirectory);
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

export async function latestIntegrationRecord(
  stateDirectory: string,
  harness: IntegrationRecord["harness"]
): Promise<IntegrationRecord | null> {
  return (await readIntegrationRecords(stateDirectory)).find(
    (record) => record.harness === harness
  ) ?? null;
}
