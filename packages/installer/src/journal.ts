import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { installationProvenanceSchema } from "./domain.js";

const JOURNAL_FILE = "installations.jsonl";

export const installationRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["installed", "rolled-back"]),
  action: z.enum(["create", "replace"]),
  destination: z.string().min(1),
  installedFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  previousFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  backupDirectory: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  rolledBackAt: z.string().datetime().optional(),
  provenance: installationProvenanceSchema.optional()
}).strict();

export type InstallationRecord = z.infer<typeof installationRecordSchema>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function appendInstallationRecord(
  stateDirectory: string,
  record: InstallationRecord
): Promise<void> {
  const parsed = installationRecordSchema.parse(record);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(stateDirectory, JOURNAL_FILE),
    `${JSON.stringify(parsed)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function parseRecord(value: unknown): InstallationRecord {
  const parsed = installationRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Installation journal contains an invalid record");
  }
  return parsed.data;
}

export async function readInstallationHistory(
  stateDirectory: string
): Promise<InstallationRecord[]> {
  let source: string;
  try {
    source = await readFile(join(stateDirectory, JOURNAL_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const byId = new Map<string, InstallationRecord>();
  for (const line of source.split("\n").filter(Boolean)) {
    const record = parseRecord(JSON.parse(line));
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}
