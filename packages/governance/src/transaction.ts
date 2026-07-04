import { randomUUID } from "node:crypto";
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
import { mutableRootAuthorizes, type SkillRoot } from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import {
  assertMutableSkillOwnership,
  GovernanceError,
  governancePlanSchema,
  type GovernancePlan,
  type GovernanceSkillOwnership
} from "./domain.js";
import {
  appendGovernanceTransaction,
  assertGovernanceJournalSafe,
  assertGovernanceStateCapability,
  captureGovernanceStateCapability,
  governanceTransactionSchema,
  readGovernanceTransactions,
  type GovernanceStateCapability,
  type GovernanceTransaction
} from "./journal.js";

type Boundary = "copy" | "verify" | "move" | "vault" | "journal";

const usedPlans = new Set<string>();

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

function sameDirectoryIdentity(
  left: DirectoryIdentity | undefined,
  right: DirectoryIdentity
): boolean {
  return left !== undefined
    && left.dev !== 0n
    && left.ino !== 0n
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  const metadata = await lstat(path, { bigint: true }).catch(() => undefined);
  if (
    metadata === undefined
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.dev === 0n
    || metadata.ino === 0n
  ) {
    return undefined;
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertOwnedDirectory(
  path: string,
  identity: DirectoryIdentity,
  code: "SOURCE_DRIFT" | "VAULT_DRIFT",
  fingerprint?: string
): Promise<void> {
  if (!sameDirectoryIdentity(await directoryIdentity(path), identity)) {
    throw new GovernanceError(code, "Governance source identity changed after review");
  }
  if (
    fingerprint !== undefined
    && await fingerprintDirectory(path).catch(() => null) !== fingerprint
  ) {
    throw new GovernanceError(code, "Governance source content changed after review");
  }
  if (!sameDirectoryIdentity(await directoryIdentity(path), identity)) {
    throw new GovernanceError(code, "Governance source identity changed during verification");
  }
}

async function removeExactOwnedDirectory(
  path: string,
  identity: DirectoryIdentity,
  fingerprint?: string
): Promise<boolean> {
  if (!sameDirectoryIdentity(await directoryIdentity(path), identity)) return false;
  if (
    fingerprint !== undefined
    && await fingerprintDirectory(path).catch(() => null) !== fingerprint
  ) return false;
  const cleanupPath = `${path}.skill-steward-cleanup-${randomUUID()}`;
  try {
    await rename(path, cleanupPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    !sameDirectoryIdentity(await directoryIdentity(cleanupPath), identity)
    || (fingerprint !== undefined
      && await fingerprintDirectory(cleanupPath).catch(() => null) !== fingerprint)
  ) {
    if (!await exists(path)) {
      await rename(cleanupPath, path).catch(() => undefined);
    }
    return false;
  }
  await rm(cleanupPath, { recursive: true, force: false });
  return true;
}

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

export type GovernanceActiveRoot = SkillRoot & { excludedPaths?: string[] };

export interface ValidateGovernancePlanOptions {
  kind: "quarantine" | "restore";
  stateDirectory: string;
  activeRoots: GovernanceActiveRoot[];
  now?: Date;
  /** @internal Reuses the state identity captured by the applying transaction. */
  expectedState?: GovernanceStateCapability;
}

function planOwnership(plan: GovernancePlan): GovernanceSkillOwnership {
  return plan.schemaVersion === 2
    ? plan.skillOwnership
    : { ownership: "direct" };
}

function transactionOwnership(
  transaction: GovernanceTransaction
): GovernanceSkillOwnership {
  return transaction.schemaVersion === 2
    ? transaction.skillOwnership
    : { ownership: "direct" };
}

async function authoritativeCandidate(
  path: string,
  kind: "quarantine" | "restore"
): Promise<string | undefined> {
  const target = resolve(path);
  if (kind === "quarantine") {
    const physical = await realpath(target).catch(() => undefined);
    return physical === target ? physical : undefined;
  }
  const parent = dirname(target);
  const physicalParent = await realpath(parent).catch(() => undefined);
  if (physicalParent !== parent) return undefined;
  return join(physicalParent, basename(target)) === target ? target : undefined;
}

async function rootAuthorizes(
  root: GovernanceActiveRoot,
  candidate: string
): Promise<boolean> {
  const configuredRoot = resolve(root.path);
  const physicalRoot = await realpath(configuredRoot).catch(() => undefined);
  if (physicalRoot !== configuredRoot) return false;
  const excludedPathGroups = await Promise.all((root.excludedPaths ?? []).map(async (path) => {
    const configured = resolve(path);
    const physical = await realpath(configured).catch(() => undefined);
    return physical === undefined || physical === configured
      ? [configured]
      : [configured, physical];
  }));
  return mutableRootAuthorizes(
    { ...root, path: physicalRoot, excludedPaths: excludedPathGroups.flat() },
    candidate
  );
}

async function assertActiveRootAuthority(
  path: string,
  kind: "quarantine" | "restore",
  roots: GovernanceActiveRoot[]
): Promise<void> {
  const candidate = await authoritativeCandidate(path, kind);
  if (candidate !== undefined) {
    for (const root of roots) {
      if (await rootAuthorizes(root, candidate)) return;
    }
  }
  throw new GovernanceError(
    "SOURCE_OUTSIDE_ACTIVE_ROOT",
    "Governance target is outside the current mutable Skill roots"
  );
}

function parseGovernancePlan(input: unknown): GovernancePlan {
  const parsed = governancePlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new GovernanceError("PLAN_INVALID", "Governance plan schema is invalid");
  }
  return parsed.data;
}

async function captureTransactionState(
  stateDirectory: string
): Promise<GovernanceStateCapability> {
  try {
    const state = await captureGovernanceStateCapability(stateDirectory, true);
    if (state !== undefined) return state;
  } catch {
    // Map the journal's storage-specific error to the transaction API contract.
  }
  throw new GovernanceError("UNSAFE_DESTINATION", "Governance state is unavailable or unsafe");
}

async function assertTransactionState(
  stateDirectory: string,
  expected: GovernanceStateCapability
): Promise<void> {
  try {
    await assertGovernanceStateCapability(stateDirectory, expected);
  } catch {
    throw new GovernanceError("UNSAFE_DESTINATION", "Governance state identity changed");
  }
}

async function transactionStateMatches(
  stateDirectory: string,
  expected: GovernanceStateCapability
): Promise<boolean> {
  try {
    await assertGovernanceStateCapability(stateDirectory, expected);
    return true;
  } catch {
    return false;
  }
}

export async function validateGovernancePlanForApply(
  input: unknown,
  options: ValidateGovernancePlanOptions
): Promise<GovernancePlan> {
  const plan = parseGovernancePlan(input);
  if (plan.kind !== options.kind) {
    throw new GovernanceError("PLAN_INVALID", `Expected a ${options.kind} plan`);
  }
  if (plan.kind === "quarantine" && plan.schemaVersion === 1) {
    throw new GovernanceError(
      "PLAN_REVIEW_REQUIRED",
      "Legacy quarantine plans must be previewed again before apply"
    );
  }
  assertMutableSkillOwnership(planOwnership(plan));
  const now = options.now ?? new Date();
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new GovernanceError("PLAN_EXPIRED", "Governance plan expired");
  }
  const state = options.expectedState ?? await captureTransactionState(options.stateDirectory);
  await assertTransactionState(options.stateDirectory, state);
  const physicalState = state.path;
  await assertGovernanceJournalSafe(options.stateDirectory, { expectedState: state });

  if (plan.kind === "quarantine") {
    if (!plan.rollbackPath) {
      throw new GovernanceError("PLAN_INVALID", "Expected a quarantine plan");
    }
    const transactionDirectory = join(physicalState, "quarantine", plan.id);
    const expectedVault = join(transactionDirectory, basename(plan.activePath));
    const expectedStaging = join(
      transactionDirectory,
      `.${basename(plan.activePath)}.staging`
    );
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
  } else {
    if (!plan.sourceTransactionId || plan.rollbackPath) {
      throw new GovernanceError("PLAN_INVALID", "Expected a restore plan");
    }
    const transactionDirectory = join(
      physicalState,
      "quarantine",
      plan.sourceTransactionId
    );
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
  }

  await assertActiveRootAuthority(plan.activePath, plan.kind, options.activeRoots);
  return plan;
}

async function validatePlan(
  input: GovernancePlan,
  stateDirectory: string,
  activeRoots: GovernanceActiveRoot[],
  now: Date
): Promise<{
  plan: GovernancePlan;
  key: string;
  transactionDirectory: string;
  sourceIdentity: DirectoryIdentity;
  stateCapability: GovernanceStateCapability;
}> {
  const stateCapability = await captureTransactionState(stateDirectory);
  const plan = await validateGovernancePlanForApply(input, {
    kind: "quarantine",
    stateDirectory,
    activeRoots,
    now,
    expectedState: stateCapability
  });
  if (!plan.rollbackPath) throw new GovernanceError("PLAN_INVALID", "Expected a quarantine plan");
  await assertTransactionState(stateDirectory, stateCapability);
  const physicalState = stateCapability.path;
  const transactionDirectory = join(physicalState, "quarantine", plan.id);
  const key = `${physicalState}\0${plan.id}`;
  if (usedPlans.has(key)) {
    throw new GovernanceError("PLAN_ALREADY_USED", "Governance plan was already used");
  }
  usedPlans.add(key);
  const activeMetadata = await lstat(plan.activePath).catch(() => null);
  const sourceIdentity = await directoryIdentity(plan.activePath);
  if (
    !activeMetadata
    || sourceIdentity === undefined
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
    !sameDirectoryIdentity(await directoryIdentity(plan.activePath), sourceIdentity)
  ) {
    throw new GovernanceError("SOURCE_DRIFT", "Active Skill identity changed after planning");
  }
  if (
    await exists(transactionDirectory)
    || await exists(plan.rollbackPath)
  ) {
    throw new GovernanceError("DESTINATION_CONFLICT", "Governance destination changed after planning");
  }
  await assertTransactionState(stateDirectory, stateCapability);
  return { plan, key, transactionDirectory, sourceIdentity, stateCapability };
}

export interface ApplyQuarantineOptions {
  stateDirectory: string;
  activeRoots: GovernanceActiveRoot[];
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
  postCommitWarnings?: GovernancePostCommitWarning[];
}

export interface GovernancePostCommitWarning {
  code: "GOVERNANCE_REFRESH_FAILED" | "GOVERNANCE_EVIDENCE_FAILED";
  message: string;
}

async function ensurePrivateTransactionDirectory(
  transactionDirectory: string,
  stateDirectory: string,
  stateCapability: GovernanceStateCapability
): Promise<void> {
  await assertTransactionState(stateDirectory, stateCapability);
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
  await assertTransactionState(stateDirectory, stateCapability);
  await mkdir(transactionDirectory, { recursive: false, mode: 0o700 });
  await chmod(transactionDirectory, 0o700);
  await assertTransactionState(stateDirectory, stateCapability);
}

export async function applyQuarantinePlan(
  input: GovernancePlan,
  options: ApplyQuarantineOptions
): Promise<GovernanceApplyResult> {
  const now = options.now ?? (() => new Date());
  const { plan, transactionDirectory, sourceIdentity, stateCapability } = await validatePlan(
    input,
    options.stateDirectory,
    options.activeRoots,
    now()
  );
  let boundary: Boundary = "copy";
  let rollbackMoved = false;
  let vaultCommitted = false;
  let journalCommitted = false;
  let stagingIdentity: DirectoryIdentity | undefined;
  let durableTransaction: GovernanceTransaction | undefined;

  const committedTransaction = () => governanceTransactionSchema.parse({
    schemaVersion: 2,
    id: plan.id,
    action: "quarantine",
    status: "quarantined",
    skillId: plan.skillId,
    ...(plan.skillName ? { skillName: plan.skillName } : {}),
    skillOwnership: planOwnership(plan),
    originalPath: plan.activePath,
    vaultPath: plan.vaultPath,
    fingerprint: plan.sourceFingerprint,
    visibleAliases: plan.visibleAliases,
    createdAt: now().toISOString()
  });

  try {
    await ensurePrivateTransactionDirectory(
      transactionDirectory,
      options.stateDirectory,
      stateCapability
    );
    await copyPrivateTree(plan.activePath, plan.stagingPath);
    stagingIdentity = await directoryIdentity(plan.stagingPath);
    if (stagingIdentity === undefined) {
      throw new GovernanceError("SOURCE_DRIFT", "Quarantine staging identity is unavailable");
    }
    await assertTransactionState(options.stateDirectory, stateCapability);
    await options.afterCopy?.();
    await assertTransactionState(options.stateDirectory, stateCapability);

    boundary = "verify";
    if (await fingerprintDirectory(plan.stagingPath) !== plan.sourceFingerprint) {
      throw new GovernanceError(
        "COPY_VERIFICATION_FAILED",
        "Quarantine staging fingerprint differs from the active Skill"
      );
    }
    await options.afterVerify?.();
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.stagingPath,
      stagingIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );

    boundary = "move";
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.activePath,
      sourceIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );
    await rename(plan.activePath, plan.rollbackPath!);
    rollbackMoved = true;
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.rollbackPath!,
      sourceIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );
    await options.afterMove?.();
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.rollbackPath!,
      sourceIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );

    boundary = "vault";
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.stagingPath,
      stagingIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );
    await rename(plan.stagingPath, plan.vaultPath);
    vaultCommitted = true;
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.vaultPath,
      stagingIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );
    await options.afterVault?.();
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.vaultPath,
      stagingIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );

    boundary = "journal";
    const transaction = committedTransaction();
    durableTransaction = transaction;
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertGovernanceJournalSafe(options.stateDirectory, { expectedState: stateCapability });
    const receipt = await (options.appendRecord ?? appendGovernanceTransaction)(
      options.stateDirectory,
      transaction,
      {
        expectedState: stateCapability,
        onDurable: () => { journalCommitted = true; }
      }
    );
    if (receipt?.durable) journalCommitted = true;
    if (!journalCommitted) {
      throw new GovernanceError(
        "JOURNAL_UNSAFE",
        "Governance journal append returned without durable proof"
      );
    }
    if (receipt === undefined || receipt.warnings.length > 0) {
      return { transaction, rescanRequired: true, cleanupPending: true };
    }
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.vaultPath,
      stagingIdentity,
      "SOURCE_DRIFT",
      plan.sourceFingerprint
    );

    let cleanupPending = false;
    try {
      await assertTransactionState(options.stateDirectory, stateCapability);
      if (!await removeExactOwnedDirectory(
        plan.rollbackPath!,
        sourceIdentity,
        plan.sourceFingerprint
      )) {
        cleanupPending = true;
      }
    } catch {
      cleanupPending = true;
    }
    await assertTransactionState(options.stateDirectory, stateCapability);
    return { transaction, rescanRequired: true, cleanupPending };
  } catch (error) {
    if (journalCommitted) {
      return {
        transaction: durableTransaction ?? committedTransaction(),
        rescanRequired: true,
        cleanupPending: true
      };
    }
    try {
      if (rollbackMoved) {
        const rollbackIdentity = await directoryIdentity(plan.rollbackPath!);
        if (!await exists(plan.activePath)) {
          await assertOwnedDirectory(
            plan.rollbackPath!,
            sourceIdentity,
            "SOURCE_DRIFT",
            plan.sourceFingerprint
          );
          await rename(plan.rollbackPath!, plan.activePath);
          await assertOwnedDirectory(
            plan.activePath,
            sourceIdentity,
            "SOURCE_DRIFT",
            plan.sourceFingerprint
          );
        } else if (sameDirectoryIdentity(rollbackIdentity, sourceIdentity)) {
          // Preserve both the replacement at active and the reviewed source at rollback.
        }
        rollbackMoved = false;
      }
      if (await transactionStateMatches(options.stateDirectory, stateCapability)) {
        if (vaultCommitted && stagingIdentity !== undefined) {
          await removeExactOwnedDirectory(
            plan.vaultPath,
            stagingIdentity,
            plan.sourceFingerprint
          );
          vaultCommitted = false;
        }
        if (stagingIdentity !== undefined) {
          await removeExactOwnedDirectory(
            plan.stagingPath,
            stagingIdentity,
            plan.sourceFingerprint
          );
        }
        await rmdir(transactionDirectory).catch((cleanupError) => {
          if (!isMissing(cleanupError) && !(cleanupError instanceof Error
            && "code" in cleanupError && cleanupError.code === "ENOTEMPTY")) throw cleanupError;
        });
      }
    } catch (recoveryError) {
      throw new GovernanceError(
        "TRANSACTION_RECOVERY_FAILED",
        `Quarantine failed and recovery requires attention: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      );
    }
    const failed = governanceTransactionSchema.parse({
      schemaVersion: 2,
      id: plan.id,
      action: "quarantine",
      status: "failed",
      skillId: plan.skillId,
      ...(plan.skillName ? { skillName: plan.skillName } : {}),
      skillOwnership: planOwnership(plan),
      originalPath: plan.activePath,
      vaultPath: plan.vaultPath,
      fingerprint: plan.sourceFingerprint,
      visibleAliases: plan.visibleAliases,
      createdAt: now().toISOString(),
      failureBoundary: boundary
    });
    if (!(error instanceof GovernanceError
      && (error.code === "SOURCE_DRIFT" || error.code === "UNSAFE_DESTINATION"))
      && await transactionStateMatches(options.stateDirectory, stateCapability)) {
      try {
        await appendGovernanceTransaction(
          options.stateDirectory,
          failed,
          { expectedState: stateCapability }
        );
      } catch {
        // The original failure remains primary; filesystem recovery already completed.
      }
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
  activeRoots: GovernanceActiveRoot[],
  now: Date
): Promise<{
  plan: GovernancePlan;
  transactionDirectory: string;
  vaultIdentity: DirectoryIdentity;
  stateCapability: GovernanceStateCapability;
}> {
  const stateCapability = await captureTransactionState(stateDirectory);
  const plan = await validateGovernancePlanForApply(input, {
    kind: "restore",
    stateDirectory,
    activeRoots,
    now,
    expectedState: stateCapability
  });
  if (!plan.sourceTransactionId || plan.rollbackPath) {
    throw new GovernanceError("PLAN_INVALID", "Expected a restore plan");
  }
  await assertTransactionState(stateDirectory, stateCapability);
  const physicalState = stateCapability.path;
  const transactionDirectory = join(physicalState, "quarantine", plan.sourceTransactionId);
  const transactions = await readGovernanceTransactions(
    stateDirectory,
    { expectedState: stateCapability }
  );
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
    || !isDeepStrictEqual(transactionOwnership(sourceTransaction), planOwnership(plan))
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
  const vaultIdentity = await directoryIdentity(plan.vaultPath);
  if (
    vaultIdentity === undefined
    ||
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
  if (!sameDirectoryIdentity(await directoryIdentity(plan.vaultPath), vaultIdentity)) {
    throw new GovernanceError("VAULT_DRIFT", "Quarantine vault identity changed after planning");
  }
  if (await exists(plan.stagingPath)) {
    throw new GovernanceError("DESTINATION_CONFLICT", "Restore staging destination is occupied");
  }
  await assertTransactionState(stateDirectory, stateCapability);
  return { plan, transactionDirectory, vaultIdentity, stateCapability };
}

export interface ApplyRestoreOptions {
  stateDirectory: string;
  activeRoots: GovernanceActiveRoot[];
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
  const { plan, transactionDirectory, vaultIdentity, stateCapability } = await validateRestorePlan(
    input,
    options.stateDirectory,
    options.activeRoots,
    now()
  );
  let boundary: "copy" | "verify" | "restore" | "journal" = "copy";
  let activeRestored = false;
  let journalCommitted = false;
  let stagingIdentity: DirectoryIdentity | undefined;
  let durableTransaction: GovernanceTransaction | undefined;

  const committedTransaction = () => governanceTransactionSchema.parse({
    schemaVersion: 2,
    id: plan.id,
    sourceTransactionId: plan.sourceTransactionId,
    action: "restore",
    status: "restored",
    skillId: plan.skillId,
    ...(plan.skillName ? { skillName: plan.skillName } : {}),
    skillOwnership: planOwnership(plan),
    originalPath: plan.activePath,
    vaultPath: plan.vaultPath,
    fingerprint: plan.sourceFingerprint,
    visibleAliases: plan.visibleAliases,
    createdAt: now().toISOString()
  });

  try {
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.vaultPath,
      vaultIdentity,
      "VAULT_DRIFT",
      plan.sourceFingerprint
    );
    await copyPrivateTree(plan.vaultPath, plan.stagingPath);
    stagingIdentity = await directoryIdentity(plan.stagingPath);
    if (stagingIdentity === undefined) {
      throw new GovernanceError("VAULT_DRIFT", "Restore staging identity is unavailable");
    }
    await assertTransactionState(options.stateDirectory, stateCapability);
    await options.afterCopy?.();
    await assertTransactionState(options.stateDirectory, stateCapability);

    boundary = "verify";
    if (await fingerprintDirectory(plan.stagingPath) !== plan.sourceFingerprint) {
      throw new GovernanceError(
        "COPY_VERIFICATION_FAILED",
        "Restore staging fingerprint differs from the quarantine vault"
      );
    }
    await options.afterVerify?.();
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.stagingPath,
      stagingIdentity,
      "VAULT_DRIFT",
      plan.sourceFingerprint
    );

    boundary = "restore";
    await assertTransactionState(options.stateDirectory, stateCapability);
    if (await exists(plan.activePath)) {
      throw new GovernanceError("DESTINATION_CONFLICT", "Original Skill destination is occupied");
    }
    await assertOwnedDirectory(
      plan.stagingPath,
      stagingIdentity,
      "VAULT_DRIFT",
      plan.sourceFingerprint
    );
    await rename(plan.stagingPath, plan.activePath);
    activeRestored = true;
    await assertOwnedDirectory(
      plan.activePath,
      stagingIdentity,
      "VAULT_DRIFT",
      plan.sourceFingerprint
    );
    await options.afterRestore?.();
    await assertTransactionState(options.stateDirectory, stateCapability);
    await assertOwnedDirectory(
      plan.activePath,
      stagingIdentity,
      "VAULT_DRIFT",
      plan.sourceFingerprint
    );

    boundary = "journal";
    const transaction = committedTransaction();
    durableTransaction = transaction;
    await assertGovernanceJournalSafe(options.stateDirectory, { expectedState: stateCapability });
    const receipt = await (options.appendRecord ?? appendGovernanceTransaction)(
      options.stateDirectory,
      transaction,
      {
        expectedState: stateCapability,
        onDurable: () => { journalCommitted = true; }
      }
    );
    if (receipt?.durable) journalCommitted = true;
    if (!journalCommitted) {
      throw new GovernanceError(
        "JOURNAL_UNSAFE",
        "Governance journal append returned without durable proof"
      );
    }

    let cleanupPending = receipt === undefined || receipt.warnings.length > 0;
    try {
      if (!cleanupPending) {
        const stateStillOwned = await transactionStateMatches(
          options.stateDirectory,
          stateCapability
        );
        const activeStillOwned = stateStillOwned
          && sameDirectoryIdentity(await directoryIdentity(plan.activePath), stagingIdentity)
          && await fingerprintDirectory(plan.activePath).catch(() => null)
            === plan.sourceFingerprint;
        const vaultStillOwned = stateStillOwned
          && sameDirectoryIdentity(await directoryIdentity(plan.vaultPath), vaultIdentity)
          && await fingerprintDirectory(plan.vaultPath).catch(() => null)
            === plan.sourceFingerprint;
        if (!activeStillOwned || !vaultStillOwned) {
          cleanupPending = true;
        } else if (options.cleanupVault) {
          await options.cleanupVault(plan.vaultPath);
        } else {
          if (await removeExactOwnedDirectory(
            plan.vaultPath,
            vaultIdentity,
            plan.sourceFingerprint
          )) {
            await rmdir(transactionDirectory);
          } else {
            cleanupPending = true;
          }
        }
      }
    } catch {
      cleanupPending = true;
    }
    return { transaction, rescanRequired: true, cleanupPending };
  } catch (error) {
    if (journalCommitted) {
      return {
        transaction: durableTransaction ?? committedTransaction(),
        rescanRequired: true,
        cleanupPending: true
      };
    }
    try {
      if (activeRestored) {
        const stateStillOwned = await transactionStateMatches(
          options.stateDirectory,
          stateCapability
        );
        const vaultStillOwned = stateStillOwned
          && sameDirectoryIdentity(await directoryIdentity(plan.vaultPath), vaultIdentity)
          && await fingerprintDirectory(plan.vaultPath).catch(() => null)
            === plan.sourceFingerprint;
        if (stagingIdentity !== undefined) {
          const activeIdentity = await directoryIdentity(plan.activePath);
          if (sameDirectoryIdentity(activeIdentity, stagingIdentity)) {
            const activeFingerprint = await fingerprintDirectory(plan.activePath)
              .catch(() => null);
            if (activeFingerprint !== plan.sourceFingerprint) {
              throw new Error(
                "Restored active content changed concurrently; retaining both copies"
              );
            }
            if (vaultStillOwned) {
              await removeExactOwnedDirectory(
                plan.activePath,
                stagingIdentity,
                plan.sourceFingerprint
              );
            }
          }
        }
        activeRestored = false;
      }
      if (stagingIdentity !== undefined) {
        await removeExactOwnedDirectory(
          plan.stagingPath,
          stagingIdentity,
          plan.sourceFingerprint
        );
      }
    } catch (recoveryError) {
      throw new GovernanceError(
        "TRANSACTION_RECOVERY_FAILED",
        `Restore failed and recovery requires attention: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      );
    }
    const failed = governanceTransactionSchema.parse({
      schemaVersion: 2,
      id: plan.id,
      sourceTransactionId: plan.sourceTransactionId,
      action: "restore",
      status: "failed",
      skillId: plan.skillId,
      ...(plan.skillName ? { skillName: plan.skillName } : {}),
      skillOwnership: planOwnership(plan),
      originalPath: plan.activePath,
      vaultPath: plan.vaultPath,
      fingerprint: plan.sourceFingerprint,
      visibleAliases: plan.visibleAliases,
      createdAt: now().toISOString(),
      failureBoundary: boundary
    });
    if (!(error instanceof GovernanceError
      && (error.code === "VAULT_DRIFT" || error.code === "UNSAFE_DESTINATION"))
      && await transactionStateMatches(options.stateDirectory, stateCapability)) {
      try {
        await appendGovernanceTransaction(
          options.stateDirectory,
          failed,
          { expectedState: stateCapability }
        );
      } catch {
        // The original error remains primary; at least one verified copy is preserved.
      }
    }
    throw error;
  }
}
