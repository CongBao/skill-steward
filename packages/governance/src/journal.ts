import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  governanceAliasSchema,
  governancePlanIdSchema,
  type QuarantinedSkill
} from "./domain.js";

const JOURNAL_FILE = "governance.jsonl";
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const governanceTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  id: governancePlanIdSchema,
  sourceTransactionId: governancePlanIdSchema.optional(),
  action: z.enum(["quarantine", "restore"]),
  status: z.enum(["quarantined", "restored", "failed"]),
  skillId: z.string().min(1).max(256),
  skillName: z.string().min(1).optional(),
  originalPath: z.string().min(1),
  vaultPath: z.string().min(1),
  fingerprint: fingerprintSchema,
  visibleAliases: z.array(governanceAliasSchema),
  createdAt: z.string().datetime(),
  failureBoundary: z.enum(["copy", "verify", "move", "vault", "journal", "restore"]).optional()
}).strict();

export type GovernanceTransaction = z.infer<typeof governanceTransactionSchema>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function appendGovernanceTransaction(
  stateDirectory: string,
  input: GovernanceTransaction
): Promise<void> {
  const transaction = governanceTransactionSchema.parse(input);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, JOURNAL_FILE);
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await appendFile(path, `${JSON.stringify(transaction)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function readGovernanceTransactions(
  stateDirectory: string
): Promise<GovernanceTransaction[]> {
  let source: string;
  try {
    source = await readFile(join(stateDirectory, JOURNAL_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return source
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => governanceTransactionSchema.parse(JSON.parse(line)))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
}

export function quarantinedSkillFromTransaction(
  transaction: GovernanceTransaction
): QuarantinedSkill {
  const parsed = governanceTransactionSchema.parse(transaction);
  if (parsed.action !== "quarantine" || parsed.status !== "quarantined") {
    throw new Error("Transaction is not a restorable quarantine");
  }
  return {
    transactionId: parsed.id,
    skillId: parsed.skillId,
    ...(parsed.skillName ? { skillName: parsed.skillName } : {}),
    originalPath: parsed.originalPath,
    vaultPath: parsed.vaultPath,
    fingerprint: parsed.fingerprint,
    visibleAliases: parsed.visibleAliases
  };
}
