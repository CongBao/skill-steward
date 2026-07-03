import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evidencePolicySchema,
  type EvidencePolicy
} from "@skill-steward/evidence";
import { z } from "zod";

const POLICY_FILE = "evidence-policy.json";
const DEFAULT_PLAN_TTL_MS = 10 * 60_000;

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = Object.freeze({
  schemaVersion: 1,
  mode: "minimal",
  retentionDays: 30,
  maxEvents: 5_000
});

const policyPlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  before: evidencePolicySchema,
  beforeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  after: evidencePolicySchema,
  afterFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export type EvidencePolicyPlan = z.infer<typeof policyPlanSchema>;

export class EvidencePolicyStoreError extends Error {
  constructor(
    public readonly code:
      | "POLICY_DRIFT"
      | "POLICY_PLAN_EXPIRED"
      | "POLICY_PLAN_INVALID"
      | "POLICY_NO_CHANGE",
    message: string
  ) {
    super(message);
    this.name = "EvidencePolicyStoreError";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fingerprint(policy: EvidencePolicy): string {
  const parsed = evidencePolicySchema.parse(policy);
  return `sha256:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
}

async function atomicWritePolicy(
  stateDirectory: string,
  policy: EvidencePolicy
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, POLICY_FILE);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidencePolicySchema.parse(policy), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

export async function readEvidencePolicy(
  stateDirectory: string
): Promise<EvidencePolicy> {
  try {
    const source = await readFile(join(stateDirectory, POLICY_FILE), "utf8");
    return evidencePolicySchema.parse(JSON.parse(source));
  } catch (error) {
    if (isMissing(error)) return { ...DEFAULT_EVIDENCE_POLICY };
    throw error;
  }
}

export async function planEvidencePolicyChange(
  stateDirectory: string,
  change: Omit<EvidencePolicy, "schemaVersion">,
  options: {
    now?: Date;
    ttlMs?: number;
    id?: () => string;
  } = {}
): Promise<EvidencePolicyPlan> {
  const before = await readEvidencePolicy(stateDirectory);
  const after = evidencePolicySchema.parse({ schemaVersion: 1, ...change });
  const beforeFingerprint = fingerprint(before);
  const afterFingerprint = fingerprint(after);
  if (beforeFingerprint === afterFingerprint) {
    throw new EvidencePolicyStoreError("POLICY_NO_CHANGE", "Evidence policy is unchanged");
  }
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new EvidencePolicyStoreError("POLICY_PLAN_INVALID", "Policy plan TTL must be positive");
  }
  return policyPlanSchema.parse({
    schemaVersion: 1,
    id: options.id?.() ?? randomUUID(),
    before,
    beforeFingerprint,
    after,
    afterFingerprint,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  });
}

export async function applyEvidencePolicyPlan(
  stateDirectory: string,
  input: EvidencePolicyPlan,
  options: { now?: Date } = {}
): Promise<EvidencePolicy> {
  const plan = policyPlanSchema.parse(input);
  const now = options.now ?? new Date();
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new EvidencePolicyStoreError("POLICY_PLAN_EXPIRED", "Evidence policy plan expired");
  }
  if (fingerprint(plan.after) !== plan.afterFingerprint) {
    throw new EvidencePolicyStoreError("POLICY_PLAN_INVALID", "Evidence policy plan was modified");
  }
  const current = await readEvidencePolicy(stateDirectory);
  if (fingerprint(current) !== plan.beforeFingerprint) {
    throw new EvidencePolicyStoreError("POLICY_DRIFT", "Evidence policy changed after planning");
  }
  await atomicWritePolicy(stateDirectory, plan.after);
  return plan.after;
}
