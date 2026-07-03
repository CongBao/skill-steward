import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import {
  evidenceDatasetSchema,
  evidenceEventSchema,
  evidencePolicySchema,
  type EvidenceDataset,
  type EvidenceEvent,
  type EvidencePolicy
} from "@skill-steward/evidence";
import { z } from "zod";

const EVENTS_FILE = "evidence-events.jsonl";
const MAX_EVENT_BYTES = 1_024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_PLAN_TTL_MS = 10 * 60_000;

const eraseKindSchema = z.enum(["preflights", "events", "salt"]);
const erasePathSchema = z.object({
  kind: eraseKindSchema,
  path: z.string().min(1),
  exists: z.boolean(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()
}).strict();
const erasePlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  paths: z.array(erasePathSchema).length(3)
}).strict();

export type EvidenceErasePlan = z.infer<typeof erasePlanSchema>;

export class EvidenceEventStoreError extends Error {
  constructor(
    public readonly code:
      | "EVIDENCE_EVENT_TOO_LARGE"
      | "EVIDENCE_JOURNAL_FULL"
      | "EVIDENCE_JOURNAL_INVALID"
      | "EVIDENCE_EXPORT_EXISTS"
      | "EVIDENCE_ERASE_DRIFT"
      | "EVIDENCE_ERASE_EXPIRED"
      | "EVIDENCE_ERASE_PLAN_INVALID",
    message: string
  ) {
    super(message);
    this.name = "EvidenceEventStoreError";
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
}

export async function appendEvidenceEvent(
  stateDirectory: string,
  input: EvidenceEvent
): Promise<void> {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new EvidenceEventStoreError(
      "EVIDENCE_EVENT_TOO_LARGE",
      `Evidence events cannot exceed ${MAX_EVENT_BYTES} bytes`
    );
  }
  const event = evidenceEventSchema.parse(input);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, EVENTS_FILE);
  if (await fileSize(path) >= MAX_JOURNAL_BYTES) {
    throw new EvidenceEventStoreError(
      "EVIDENCE_JOURNAL_FULL",
      `Evidence journal reached ${MAX_JOURNAL_BYTES} bytes`
    );
  }
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readEvidenceEvents(
  stateDirectory: string
): Promise<EvidenceEvent[]> {
  let source: string;
  try {
    source = await readFile(join(stateDirectory, EVENTS_FILE), "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  try {
    return source
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => evidenceEventSchema.parse(JSON.parse(line)));
  } catch (error) {
    throw new EvidenceEventStoreError(
      "EVIDENCE_JOURNAL_INVALID",
      `Evidence journal contains an invalid event: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

export async function compactEvidenceEvents(
  stateDirectory: string,
  input: EvidencePolicy,
  now = new Date()
): Promise<{ before: number; kept: number; removed: number }> {
  const policy = evidencePolicySchema.parse(input);
  const events = await readEvidenceEvents(stateDirectory);
  if (events.length === 0 && await fileSize(join(stateDirectory, EVENTS_FILE)) === 0) {
    return { before: 0, kept: 0, removed: 0 };
  }
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1_000;
  const retained = events
    .filter(({ createdAt }) => Date.parse(createdAt) >= cutoff)
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
    )
    .slice(-policy.maxEvents);

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, EVENTS_FILE);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const payload = retained.length > 0
    ? `${retained.map((event) => JSON.stringify(event)).join("\n")}\n`
    : "";
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return {
    before: events.length,
    kept: retained.length,
    removed: events.length - retained.length
  };
}

export async function writeEvidenceExport(
  outputPath: string,
  input: EvidenceDataset,
  options: { replace?: boolean } = {}
): Promise<void> {
  const dataset = evidenceDatasetSchema.parse(input);
  try {
    await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, {
      encoding: "utf8",
      flag: options.replace ? "w" : "wx",
      mode: 0o600
    });
    await chmod(outputPath, 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new EvidenceEventStoreError(
        "EVIDENCE_EXPORT_EXISTS",
        "Evidence export destination already exists"
      );
    }
    throw error;
  }
}

function eraseTargets(stateDirectory: string): Array<{
  kind: z.infer<typeof eraseKindSchema>;
  path: string;
}> {
  return [
    { kind: "preflights", path: join(stateDirectory, "preflights.json") },
    { kind: "events", path: join(stateDirectory, EVENTS_FILE) },
    { kind: "salt", path: join(stateDirectory, "evidence-salt") }
  ];
}

async function fingerprintFile(path: string): Promise<string | null> {
  try {
    return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function planEvidenceErase(
  stateDirectory: string,
  options: { now?: Date; ttlMs?: number; id?: () => string } = {}
): Promise<EvidenceErasePlan> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new EvidenceEventStoreError(
      "EVIDENCE_ERASE_PLAN_INVALID",
      "Evidence erase plan TTL must be positive"
    );
  }
  const paths = await Promise.all(eraseTargets(stateDirectory).map(async (target) => {
    const fingerprint = await fingerprintFile(target.path);
    return { ...target, exists: fingerprint !== null, fingerprint };
  }));
  return erasePlanSchema.parse({
    schemaVersion: 1,
    id: options.id?.() ?? randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    paths
  });
}

export async function applyEvidenceErasePlan(
  stateDirectory: string,
  input: EvidenceErasePlan,
  options: { now?: Date } = {}
): Promise<void> {
  const plan = erasePlanSchema.parse(input);
  const now = options.now ?? new Date();
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new EvidenceEventStoreError("EVIDENCE_ERASE_EXPIRED", "Evidence erase plan expired");
  }
  const targets = new Map(eraseTargets(stateDirectory).map((target) => [target.kind, target.path]));
  for (const planned of plan.paths) {
    if (targets.get(planned.kind) !== planned.path) {
      throw new EvidenceEventStoreError(
        "EVIDENCE_ERASE_PLAN_INVALID",
        "Evidence erase plan contains an unexpected path"
      );
    }
    const currentFingerprint = await fingerprintFile(planned.path);
    if (currentFingerprint !== planned.fingerprint) {
      throw new EvidenceEventStoreError(
        "EVIDENCE_ERASE_DRIFT",
        `Evidence file changed after planning: ${planned.kind}`
      );
    }
  }
  for (const planned of plan.paths) {
    if (planned.exists) await unlink(planned.path);
  }
}
