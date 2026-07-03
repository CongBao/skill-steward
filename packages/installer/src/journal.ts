import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const JOURNAL_FILE = "installations.jsonl";

export interface InstallationRecord {
  id: string;
  status: "installed" | "rolled-back";
  action: "create" | "replace";
  destination: string;
  installedFingerprint: string;
  previousFingerprint: string | null;
  backupDirectory: string | null;
  createdAt: string;
  rolledBackAt?: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function appendInstallationRecord(
  stateDirectory: string,
  record: InstallationRecord
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(stateDirectory, JOURNAL_FILE),
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function parseRecord(value: unknown): InstallationRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("status" in value) ||
    (value.status !== "installed" && value.status !== "rolled-back") ||
    !("destination" in value) ||
    typeof value.destination !== "string" ||
    !("installedFingerprint" in value) ||
    typeof value.installedFingerprint !== "string"
  ) {
    throw new Error("Installation journal contains an invalid record");
  }
  return value as unknown as InstallationRecord;
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
