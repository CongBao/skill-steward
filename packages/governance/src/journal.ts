import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import {
  GovernanceError,
  governanceAliasSchema,
  governancePlanIdSchema,
  governanceSkillOwnershipSchema,
  type QuarantinedSkill
} from "./domain.js";

const JOURNAL_FILE = "governance.jsonl";
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const governanceTransactionShape = {
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
};

export const governanceTransactionV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...governanceTransactionShape
}).strict();

export const governanceTransactionV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...governanceTransactionShape,
  skillOwnership: governanceSkillOwnershipSchema
}).strict();

export const governanceTransactionSchema = z.discriminatedUnion("schemaVersion", [
  governanceTransactionV1Schema,
  governanceTransactionV2Schema
]);

export type GovernanceTransaction = z.infer<typeof governanceTransactionSchema>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function journalUnsafe(): GovernanceError {
  return new GovernanceError("JOURNAL_UNSAFE", "Governance journal target is unsafe");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface GovernanceStateCapability extends FileIdentity {
  path: string;
}

export type GovernanceJournalDurableWarningCode =
  | "JOURNAL_DURABLE_CALLBACK_FAILED"
  | "JOURNAL_DURABLE_STATE_CHANGED"
  | "JOURNAL_DURABLE_CLOSE_FAILED";

export interface GovernanceJournalDurableWarning {
  code: GovernanceJournalDurableWarningCode;
  message: string;
}

export interface GovernanceJournalAppendReceipt {
  durable: true;
  warnings: GovernanceJournalDurableWarning[];
}

export interface GovernanceJournalAccessOptions {
  expectedState?: GovernanceStateCapability;
  onDurable?: () => void;
}

function identityOf(metadata: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev !== 0n
    && left.ino !== 0n
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function inspectPhysicalDirectory(
  configured: string
): Promise<GovernanceStateCapability> {
  const metadata = await lstat(configured, { bigint: true }).catch(() => {
    throw journalUnsafe();
  });
  const physical = await realpath(configured).catch(() => undefined);
  const physicalMetadata = physical === undefined
    ? undefined
    : await stat(physical, { bigint: true }).catch(() => undefined);
  let stateHandle: FileHandle | undefined;
  try {
    stateHandle = await open(
      configured,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw journalUnsafe();
  }
  let openedState: BigIntStats;
  let afterState: BigIntStats | undefined;
  try {
    [openedState, afterState] = await Promise.all([
      stateHandle.stat({ bigint: true }),
      lstat(configured, { bigint: true }).catch(() => undefined)
    ]);
  } finally {
    await stateHandle.close();
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || physical !== configured
    || !physicalMetadata?.isDirectory()
    || !sameIdentity(identityOf(metadata), identityOf(physicalMetadata))
    || !openedState.isDirectory()
    || afterState === undefined
    || !afterState.isDirectory()
    || !sameIdentity(identityOf(metadata), identityOf(openedState))
    || !sameIdentity(identityOf(afterState), identityOf(openedState))
  ) {
    throw journalUnsafe();
  }
  return { path: physical, ...identityOf(openedState) };
}

function sameStateCapability(
  left: GovernanceStateCapability,
  right: GovernanceStateCapability
): boolean {
  return left.path === right.path && sameIdentity(left, right);
}

export async function captureGovernanceStateCapability(
  stateDirectory: string,
  create = true
): Promise<GovernanceStateCapability | undefined> {
  const configured = resolve(stateDirectory);
  const initial = await lstat(configured).catch((error) =>
    isMissing(error) ? undefined : null
  );
  if (initial === null) throw journalUnsafe();
  if (initial !== undefined) return inspectPhysicalDirectory(configured);
  if (!create) return undefined;

  const { root } = parse(configured);
  if (root.length === 0) throw journalUnsafe();
  const components = configured
    .slice(root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let current = root;
  let currentCapability = await inspectPhysicalDirectory(current);
  for (const component of components) {
    const next = join(current, component);
    const beforeParent = await inspectPhysicalDirectory(current);
    const child = await lstat(next).catch((error) =>
      isMissing(error) ? undefined : null
    );
    if (child === null) throw journalUnsafe();
    if (child === undefined) {
      try {
        await mkdir(next, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw journalUnsafe();
      }
    }
    const nextCapability = await inspectPhysicalDirectory(next);
    const afterParent = await inspectPhysicalDirectory(current);
    if (!sameStateCapability(beforeParent, afterParent)) throw journalUnsafe();
    current = next;
    currentCapability = nextCapability;
  }
  return currentCapability;
}

export async function assertGovernanceStateCapability(
  stateDirectory: string,
  expected: GovernanceStateCapability
): Promise<GovernanceStateCapability> {
  const current = await inspectPhysicalDirectory(resolve(stateDirectory));
  if (!sameStateCapability(current, expected)) throw journalUnsafe();
  return current;
}

async function stateForAccess(
  stateDirectory: string,
  create: boolean,
  options: GovernanceJournalAccessOptions
): Promise<GovernanceStateCapability | undefined> {
  if (options.expectedState) {
    return assertGovernanceStateCapability(stateDirectory, options.expectedState);
  }
  return captureGovernanceStateCapability(stateDirectory, create);
}

function journalPath(stateDirectory: string): string {
  const path = join(stateDirectory, JOURNAL_FILE);
  if (dirname(path) !== stateDirectory) throw journalUnsafe();
  return path;
}

async function validateOpenedJournal(
  path: string,
  handle: FileHandle,
  before: BigIntStats
): Promise<void> {
  const [opened, after] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }).catch(() => undefined)
  ]);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1n
    || !opened.isFile()
    || opened.nlink !== 1n
    || after === undefined
    || after.isSymbolicLink()
    || !after.isFile()
    || after.nlink !== 1n
    || !sameIdentity(identityOf(before), identityOf(opened))
    || !sameIdentity(identityOf(after), identityOf(opened))
  ) {
    throw journalUnsafe();
  }
}

async function openExistingJournal(path: string, flags: number): Promise<FileHandle> {
  const before = await lstat(path, { bigint: true }).catch(() => undefined);
  if (
    before === undefined
    || before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1n
  ) {
    throw journalUnsafe();
  }
  let handle: FileHandle;
  try {
    handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw journalUnsafe();
  }
  try {
    await validateOpenedJournal(path, handle, before);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openJournalForAppend(path: string): Promise<FileHandle> {
  const existing = await lstat(path, { bigint: true }).catch((error) =>
    isMissing(error) ? undefined : null
  );
  if (existing === null) throw journalUnsafe();
  if (existing !== undefined) {
    return await openExistingJournal(path, constants.O_WRONLY | constants.O_APPEND);
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY
        | constants.O_APPEND
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (createError) {
    if (isAlreadyExists(createError)) {
      return openExistingJournal(path, constants.O_WRONLY | constants.O_APPEND);
    }
    throw journalUnsafe();
  }
  try {
    const created = await lstat(path, { bigint: true }).catch(() => undefined);
    if (created === undefined) throw journalUnsafe();
    await validateOpenedJournal(path, handle, created);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertGovernanceJournalSafe(
  stateDirectory: string,
  options: GovernanceJournalAccessOptions = {}
): Promise<void> {
  const state = await stateForAccess(stateDirectory, true, options);
  if (state === undefined) throw journalUnsafe();
  const path = journalPath(state.path);
  const existing = await lstat(path).catch((error) => isMissing(error) ? undefined : null);
  if (existing === undefined) {
    if (options.expectedState) {
      await assertGovernanceStateCapability(stateDirectory, options.expectedState);
    }
    return;
  }
  if (existing === null) throw journalUnsafe();
  const handle = await openExistingJournal(path, constants.O_RDONLY);
  await handle.close();
  if (options.expectedState) {
    await assertGovernanceStateCapability(stateDirectory, options.expectedState);
  }
}

export async function appendGovernanceTransaction(
  stateDirectory: string,
  input: GovernanceTransaction,
  options: GovernanceJournalAccessOptions = {}
): Promise<GovernanceJournalAppendReceipt> {
  const transaction = governanceTransactionSchema.parse(input);
  const state = await stateForAccess(stateDirectory, true, options);
  if (state === undefined) throw journalUnsafe();
  const path = journalPath(state.path);
  const handle = await openJournalForAppend(path);
  let receipt: GovernanceJournalAppendReceipt | undefined;
  let failure: unknown;
  try {
    if (options.expectedState) {
      await assertGovernanceStateCapability(stateDirectory, options.expectedState);
    }
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw journalUnsafe();
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(transaction)}\n`, "utf8");
    await handle.sync();
    receipt = { durable: true, warnings: [] };
    try {
      options.onDurable?.();
    } catch {
      receipt.warnings.push({
        code: "JOURNAL_DURABLE_CALLBACK_FAILED",
        message: "Governance journal committed, but its durable callback failed"
      });
    }
    if (options.expectedState) {
      try {
        await assertGovernanceStateCapability(stateDirectory, options.expectedState);
      } catch {
        receipt.warnings.push({
          code: "JOURNAL_DURABLE_STATE_CHANGED",
          message: "Governance journal committed before its state identity changed"
        });
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (receipt) {
      receipt.warnings.push({
        code: "JOURNAL_DURABLE_CLOSE_FAILED",
        message: "Governance journal committed, but its file handle did not close cleanly"
      });
    } else if (failure === undefined) {
      failure = error;
    }
  }
  if (receipt) return receipt;
  if (failure !== undefined) throw failure;
  throw journalUnsafe();
}

export async function readGovernanceTransactions(
  stateDirectory: string,
  options: GovernanceJournalAccessOptions = {}
): Promise<GovernanceTransaction[]> {
  const state = await stateForAccess(stateDirectory, false, options);
  if (state === undefined) return [];
  const path = journalPath(state.path);
  const existing = await lstat(path).catch((error) => isMissing(error) ? undefined : null);
  if (existing === undefined) {
    if (options.expectedState) {
      await assertGovernanceStateCapability(stateDirectory, options.expectedState);
    }
    return [];
  }
  if (existing === null) throw journalUnsafe();
  const handle = await openExistingJournal(path, constants.O_RDONLY);
  let source: string;
  try {
    source = await handle.readFile("utf8");
    if (options.expectedState) {
      await assertGovernanceStateCapability(stateDirectory, options.expectedState);
    }
  } finally {
    await handle.close();
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
  const common = {
    transactionId: parsed.id,
    skillId: parsed.skillId,
    ...(parsed.skillName ? { skillName: parsed.skillName } : {}),
    originalPath: parsed.originalPath,
    vaultPath: parsed.vaultPath,
    fingerprint: parsed.fingerprint,
    visibleAliases: parsed.visibleAliases
  };
  return parsed.schemaVersion === 2
    ? { schemaVersion: 2, ...common, skillOwnership: parsed.skillOwnership }
    : { schemaVersion: 1, ...common };
}
