import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const INTEGRATIONS_FILE = "integrations.json";
const MAX_RECORDS = 100;

export const integrationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  harness: z.enum(["codex", "claude-code"]),
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

export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readIntegrationRecords(
  stateDirectory: string
): Promise<IntegrationRecord[]> {
  try {
    const source = await readFile(join(stateDirectory, INTEGRATIONS_FILE), "utf8");
    return integrationFileSchema.parse(JSON.parse(source)).records;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
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
  const record = integrationRecordSchema.parse(input);
  const current = await readIntegrationRecords(stateDirectory);
  const records = [record, ...current.filter(({ id }) => id !== record.id)].slice(0, limit);
  const payload = integrationFileSchema.parse({ schemaVersion: 1, records });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, INTEGRATIONS_FILE);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

export async function latestIntegrationRecord(
  stateDirectory: string,
  harness: IntegrationRecord["harness"]
): Promise<IntegrationRecord | null> {
  return (await readIntegrationRecords(stateDirectory)).find(
    (record) => record.harness === harness
  ) ?? null;
}
