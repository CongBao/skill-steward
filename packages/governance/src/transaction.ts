import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fingerprintDirectory } from "@skill-steward/installer";
import {
  GovernanceError,
  governancePlanSchema,
  type GovernancePlan
} from "./domain.js";
import {
  appendGovernanceTransaction,
  governanceTransactionSchema,
  readGovernanceTransactions,
  type GovernanceTransaction
} from "./journal.js";

type Boundary = "copy" | "verify" | "move" | "vault" | "journal";

const usedPlans = new Set<string>();

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function copyPrivateTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) {
      throw new GovernanceError("SOURCE_UNSAFE", "Quarantine source contains a symbolic link");
    }
    if (metadata.isDirectory()) {
      await copyPrivateTree(from, to);
      continue;
    }
    if (!metadata.isFile()) {
      throw new GovernanceError("SOURCE_UNSAFE", "Quarantine source contains a special file");
    }
    await copyFile(from, to);
    await chmod(to, metadata.mode & 0o777);
  }
}

function expectedOperations(plan: GovernancePlan) {
  if (!plan.rollbackPath) return [];
  return [
    { operation: "copy-to-staging", from: plan.activePath, to: plan.stagingPath },
    { operation: "verify-staging", path: plan.stagingPath, fingerprint: plan.sourceFingerprint },
    { operation: "move-active-to-rollback", from: plan.activePath, to: plan.rollbackPath },
    { operation: "commit-vault", from: plan.stagingPath, to: plan.vaultPath },
    { operation: "append-journal", transactionId: plan.id },
    { operation: "cleanup-rollback", path: plan.rollbackPath }
  ];
}

async function validatePlan(
  input: GovernancePlan,
  stateDirectory: string,
  now: Date
): Promise<{ plan: GovernancePlan; key: string; transactionDirectory: string }> {
  const plan = governancePlanSchema.parse(input);
  if (plan.kind !== "quarantine" || !plan.rollbackPath) {
    throw new GovernanceError("PLAN_INVALID", "Expected a quarantine plan");
  }
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new GovernanceError("PLAN_EXPIRED", "Governance plan expired");
  }
  const physicalState = await realpath(resolve(stateDirectory));
  const transactionDirectory = join(physicalState, "quarantine", plan.id);
  const expectedVault = join(transactionDirectory, basename(plan.activePath));
  const expectedStaging = join(transactionDirectory, `.${basename(plan.activePath)}.staging`);
  const expectedRollback = join(
    dirname(plan.activePath),
    `.${basename(plan.activePath)}.skill-steward-quarantine-${plan.id}.rollback`
  );
  if (
    plan.vaultPath !== expectedVault
    || plan.stagingPath !== expectedStaging
    || plan.rollbackPath !== expectedRollback
    || plan.expectedDestinationFingerprint !== null
    || !isDeepStrictEqual(plan.operations, expectedOperations(plan))
  ) {
    throw new GovernanceError("PLAN_INVALID", "Governance plan paths or operations changed");
  }
  const key = `${physicalState}\0${plan.id}`;
  if (usedPlans.has(key)) {
    throw new GovernanceError("PLAN_ALREADY_USED", "Governance plan was already used");
  }
  usedPlans.add(key);
  const activeMetadata = await lstat(plan.activePath).catch(() => null);
  if (
    !activeMetadata
    || activeMetadata.isSymbolicLink()
    || !activeMetadata.isDirectory()
    || await realpath(plan.activePath).catch(() => null) !== plan.activePath
  ) {
    throw new GovernanceError("SOURCE_DRIFT", "Active Skill path changed after planning");
  }
  if (
    await fingerprintDirectory(plan.activePath).catch(() => null)
    !== plan.sourceFingerprint
  ) {
    throw new GovernanceError("SOURCE_DRIFT", "Active Skill changed after planning");
  }
  if (
    await exists(transactionDirectory)
    || await exists(plan.rollbackPath)
  ) {
    throw new GovernanceError("DESTINATION_CONFLICT", "Governance destination changed after planning");
  }
  return { plan, key, transactionDirectory };
}

export interface ApplyQuarantineOptions {
  stateDirectory: string;
  now?: () => Date;
  afterCopy?: () => void | Promise<void>;
  afterVerify?: () => void | Promise<void>;
  afterMove?: () => void | Promise<void>;
  afterVault?: () => void | Promise<void>;
  appendRecord?: typeof appendGovernanceTransaction;
}

export interface GovernanceApplyResult {
  transaction: GovernanceTransaction;
  rescanRequired: true;
  cleanupPending: boolean;
}

async function ensurePrivateTransactionDirectory(transactionDirectory: string): Promise<void> {
  const quarantineDirectory = dirname(transactionDirectory);
  try {
    await mkdir(quarantineDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const metadata = await lstat(quarantineDirectory);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || await realpath(quarantineDirectory) !== quarantineDirectory
  ) {
    throw new GovernanceError("UNSAFE_DESTINATION", "Quarantine container is unsafe");
  }
  await chmod(quarantineDirectory, 0o700);
  await mkdir(transactionDirectory, { recursive: false, mode: 0o700 });
  await chmod(transactionDirectory, 0o700);
}

export async function applyQuarantinePlan(
  input: GovernancePlan,
  options: ApplyQuarantineOptions
): Promise<GovernanceApplyResult> {
  const now = options.now ?? (() => new Date());
  const { plan, transactionDirectory } = await validatePlan(input, options.stateDirectory, now());
  let boundary: Boundary = "copy";
  let rollbackMoved = false;
  let vaultCommitted = false;
  let journalCommitted = false;

  const committedTransaction = () => governanceTransactionSchema.parse({
    schemaVersion: 1,
    id: plan.id,
    action: "quarantine",
    status: "quarantined",
    skillId: plan.skillId,
    ...(plan.skillName ? { skillName: plan.skillName } : {}),
    originalPath: plan.activePath,
    vaultPath: plan.vaultPath,
    fingerprint: plan.sourceFingerprint,
    visibleAliases: plan.visibleAliases,
    createdAt: now().toISOString()
  });

  try {
    await ensurePrivateTransactionDirectory(transactionDirectory);
    await copyPrivateTree(plan.activePath, plan.stagingPath);
    await options.afterCopy?.();

    boundary = "verify";
    if (await fingerprintDirectory(plan.stagingPath) !== plan.sourceFingerprint) {
      throw new GovernanceError(
        "COPY_VERIFICATION_FAILED",
        "Quarantine staging fingerprint differs from the active Skill"
      );
    }
    await options.afterVerify?.();

    boundary = "move";
    await rename(plan.activePath, plan.rollbackPath!);
    rollbackMoved = true;
    await options.afterMove?.();

    boundary = "vault";
    await rename(plan.stagingPath, plan.vaultPath);
    vaultCommitted = true;
    await options.afterVault?.();

    boundary = "journal";
    const transaction = committedTransaction();
    await (options.appendRecord ?? appendGovernanceTransaction)(
      options.stateDirectory,
      transaction
    );
    journalCommitted = true;

    let cleanupPending = false;
    try {
      await rm(plan.rollbackPath!, { recursive: true, force: false });
    } catch {
      cleanupPending = true;
    }
    return { transaction, rescanRequired: true, cleanupPending };
  } catch (error) {
    if (journalCommitted) throw error;
    try {
      if (rollbackMoved) {
        await rename(plan.rollbackPath!, plan.activePath);
        rollbackMoved = false;
      }
      if (vaultCommitted) {
        await rm(plan.vaultPath, { recursive: true, force: true });
        vaultCommitted = false;
      }
      await rm(plan.stagingPath, { recursive: true, force: true });
      await rm(transactionDirectory, { recursive: true, force: true });
    } catch (recoveryError) {
      throw new GovernanceError(
        "TRANSACTION_RECOVERY_FAILED",
        `Quarantine failed and recovery requires attention: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      );
    }
    const failed = governanceTransactionSchema.parse({
      schemaVersion: 1,
      id: plan.id,
      action: "quarantine",
      status: "failed",
      skillId: plan.skillId,
      ...(plan.skillName ? { skillName: plan.skillName } : {}),
      originalPath: plan.activePath,
      vaultPath: plan.vaultPath,
      fingerprint: plan.sourceFingerprint,
      visibleAliases: plan.visibleAliases,
      createdAt: now().toISOString(),
      failureBoundary: boundary
    });
    try {
      await appendGovernanceTransaction(options.stateDirectory, failed);
    } catch {
      // The original failure remains primary; filesystem recovery already completed.
    }
    throw error;
  }
}

function expectedRestoreOperations(plan: GovernancePlan) {
  return [
    { operation: "copy-to-staging", from: plan.vaultPath, to: plan.stagingPath },
    { operation: "verify-staging", path: plan.stagingPath, fingerprint: plan.sourceFingerprint },
    { operation: "restore-active", from: plan.stagingPath, to: plan.activePath },
    { operation: "append-journal", transactionId: plan.id },
    { operation: "cleanup-vault", path: plan.vaultPath }
  ];
}

async function validateRestorePlan(
  input: GovernancePlan,
  stateDirectory: string,
  now: Date
): Promise<{ plan: GovernancePlan; transactionDirectory: string }> {
  const plan = governancePlanSchema.parse(input);
  if (plan.kind !== "restore" || !plan.sourceTransactionId || plan.rollbackPath) {
    throw new GovernanceError("PLAN_INVALID", "Expected a restore plan");
  }
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new GovernanceError("PLAN_EXPIRED", "Governance plan expired");
  }
  const physicalState = await realpath(resolve(stateDirectory));
  const transactionDirectory = join(physicalState, "quarantine", plan.sourceTransactionId);
  const expectedVault = join(transactionDirectory, basename(plan.activePath));
  const expectedStaging = join(
    dirname(plan.activePath),
    `.${basename(plan.activePath)}.skill-steward-restore-${plan.id}.tmp`
  );
  if (
    plan.vaultPath !== expectedVault
    || plan.stagingPath !== expectedStaging
    || plan.expectedDestinationFingerprint !== null
    || !isDeepStrictEqual(plan.operations, expectedRestoreOperations(plan))
  ) {
    throw new GovernanceError("PLAN_INVALID", "Restore plan paths or operations changed");
  }
  const transactions = await readGovernanceTransactions(stateDirectory);
  const sourceTransaction = transactions.find(
    (transaction) =>
      transaction.id === plan.sourceTransactionId
      && transaction.action === "quarantine"
      && transaction.status === "quarantined"
  );
  if (
    !sourceTransaction
    || sourceTransaction.skillId !== plan.skillId
    || sourceTransaction.originalPath !== plan.activePath
    || sourceTransaction.vaultPath !== plan.vaultPath
    || sourceTransaction.fingerprint !== plan.sourceFingerprint
    || !isDeepStrictEqual(sourceTransaction.visibleAliases, plan.visibleAliases)
  ) {
    throw new GovernanceError("PLAN_INVALID", "Restore plan does not match a committed quarantine");
  }
  const key = `${physicalState}\0${plan.id}`;
  if (usedPlans.has(key)) {
    throw new GovernanceError("PLAN_ALREADY_USED", "Governance plan was already used");
  }
  if (transactions.some((transaction) =>
    transaction.action === "restore"
    && transaction.status === "restored"
    && transaction.sourceTransactionId === plan.sourceTransactionId
  )) {
    throw new GovernanceError("PLAN_ALREADY_USED", "Quarantine was already restored");
  }
  usedPlans.add(key);
  if (await exists(plan.activePath)) {
    throw new GovernanceError("DESTINATION_CONFLICT", "Original Skill destination is occupied");
  }
  if (
    await lstat(plan.vaultPath).then((metadata) =>
      metadata.isSymbolicLink() || !metadata.isDirectory()
    ).catch(() => true)
    || await realpath(plan.vaultPath).catch(() => null) !== plan.vaultPath
    || await realpath(dirname(plan.activePath)).catch(() => null) !== dirname(plan.activePath)
  ) {
    throw new GovernanceError("VAULT_DRIFT", "Restore paths changed after planning");
  }
  if (
    await fingerprintDirectory(plan.vaultPath).catch(() => null)
    !== plan.sourceFingerprint
  ) {
    throw new GovernanceError("VAULT_DRIFT", "Quarantine vault changed after planning");
  }
  if (await exists(plan.stagingPath)) {
    throw new GovernanceError("DESTINATION_CONFLICT", "Restore staging destination is occupied");
  }
  return { plan, transactionDirectory };
}

export interface ApplyRestoreOptions {
  stateDirectory: string;
  now?: () => Date;
  afterCopy?: () => void | Promise<void>;
  afterVerify?: () => void | Promise<void>;
  afterRestore?: () => void | Promise<void>;
  appendRecord?: typeof appendGovernanceTransaction;
  cleanupVault?: (vaultPath: string) => void | Promise<void>;
}

export async function applyRestorePlan(
  input: GovernancePlan,
  options: ApplyRestoreOptions
): Promise<GovernanceApplyResult> {
  const now = options.now ?? (() => new Date());
  const { plan, transactionDirectory } = await validateRestorePlan(
    input,
    options.stateDirectory,
    now()
  );
  let boundary: "copy" | "verify" | "restore" | "journal" = "copy";
  let activeRestored = false;
  let journalCommitted = false;

  const committedTransaction = () => governanceTransactionSchema.parse({
    schemaVersion: 1,
    id: plan.id,
    sourceTransactionId: plan.sourceTransactionId,
    action: "restore",
    status: "restored",
    skillId: plan.skillId,
    ...(plan.skillName ? { skillName: plan.skillName } : {}),
    originalPath: plan.activePath,
    vaultPath: plan.vaultPath,
    fingerprint: plan.sourceFingerprint,
    visibleAliases: plan.visibleAliases,
    createdAt: now().toISOString()
  });

  try {
    await copyPrivateTree(plan.vaultPath, plan.stagingPath);
    await options.afterCopy?.();

    boundary = "verify";
    if (await fingerprintDirectory(plan.stagingPath) !== plan.sourceFingerprint) {
      throw new GovernanceError(
        "COPY_VERIFICATION_FAILED",
        "Restore staging fingerprint differs from the quarantine vault"
      );
    }
    await options.afterVerify?.();

    boundary = "restore";
    if (await exists(plan.activePath)) {
      throw new GovernanceError("DESTINATION_CONFLICT", "Original Skill destination is occupied");
    }
    await rename(plan.stagingPath, plan.activePath);
    activeRestored = true;
    await options.afterRestore?.();

    boundary = "journal";
    const transaction = committedTransaction();
    await (options.appendRecord ?? appendGovernanceTransaction)(
      options.stateDirectory,
      transaction
    );
    journalCommitted = true;

    let cleanupPending = false;
    try {
      if (options.cleanupVault) {
        await options.cleanupVault(plan.vaultPath);
      } else if (await fingerprintDirectory(plan.vaultPath) === plan.sourceFingerprint) {
        await rm(plan.vaultPath, { recursive: true, force: false });
        await rmdir(transactionDirectory);
      } else {
        cleanupPending = true;
      }
    } catch {
      cleanupPending = true;
    }
    return { transaction, rescanRequired: true, cleanupPending };
  } catch (error) {
    if (journalCommitted) throw error;
    try {
      if (activeRestored) {
        if (
          await fingerprintDirectory(plan.vaultPath).catch(() => null)
          !== plan.sourceFingerprint
        ) {
          throw new Error("Verified vault is unavailable; retaining restored active copy");
        }
        await rm(plan.activePath, { recursive: true, force: false });
        activeRestored = false;
      }
      await rm(plan.stagingPath, { recursive: true, force: true });
    } catch (recoveryError) {
      throw new GovernanceError(
        "TRANSACTION_RECOVERY_FAILED",
        `Restore failed and recovery requires attention: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      );
    }
    const failed = governanceTransactionSchema.parse({
      schemaVersion: 1,
      id: plan.id,
      sourceTransactionId: plan.sourceTransactionId,
      action: "restore",
      status: "failed",
      skillId: plan.skillId,
      ...(plan.skillName ? { skillName: plan.skillName } : {}),
      originalPath: plan.activePath,
      vaultPath: plan.vaultPath,
      fingerprint: plan.sourceFingerprint,
      visibleAliases: plan.visibleAliases,
      createdAt: now().toISOString(),
      failureBoundary: boundary
    });
    try {
      await appendGovernanceTransaction(options.stateDirectory, failed);
    } catch {
      // The original error remains primary; at least one verified copy is preserved.
    }
    throw error;
  }
}
