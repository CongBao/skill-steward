import { randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  skillRecordSchema,
  type SkillRecord,
  type SkillRoot
} from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import {
  GovernanceError,
  governancePlanIdSchema,
  governancePlanSchema,
  quarantinedSkillSchema,
  type GovernanceAlias,
  type GovernancePlan,
  type QuarantinedSkill
} from "./domain.js";

const PLAN_TTL_MS = 10 * 60_000;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${sep}`);
}

function assertSafeName(path: string): void {
  const name = basename(path);
  if (
    name.length === 0
    || Buffer.byteLength(name, "utf8") > 255
    || name === "."
    || name === ".."
    || name.startsWith(".skill-steward-")
    || name.includes("\0")
  ) {
    throw new GovernanceError("SOURCE_UNSAFE", "Skill directory name is unsafe");
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new GovernanceError("DESTINATION_CONFLICT", `Governance destination already exists: ${path}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertSafeTree(root: string, current = root): Promise<void> {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink() || (current === root && !metadata.isDirectory())) {
    throw new GovernanceError("SOURCE_UNSAFE", "Governance source must be a real directory");
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(current)) {
    const path = join(current, entry);
    const child = await lstat(path);
    if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
      throw new GovernanceError("SOURCE_UNSAFE", `Source contains an unsafe entry: ${entry}`);
    }
    if (child.isDirectory()) await assertSafeTree(root, path);
  }
}

async function physicalDirectory(path: string, code: "SOURCE_UNSAFE" | "UNSAFE_DESTINATION"): Promise<string> {
  try {
    const physical = await realpath(resolve(path));
    const metadata = await stat(physical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return physical;
  } catch (error) {
    if (error instanceof GovernanceError) throw error;
    throw new GovernanceError(code, `Directory is unavailable or unsafe: ${path}`);
  }
}

async function aliasesFor(sourcePath: string, roots: SkillRoot[]): Promise<GovernanceAlias[]> {
  const aliases: GovernanceAlias[] = [];
  for (const root of roots) {
    let physicalRoot: string;
    try {
      physicalRoot = await physicalDirectory(root.path, "SOURCE_UNSAFE");
    } catch {
      continue;
    }
    if (!isWithin(physicalRoot, sourcePath)) continue;
    for (const harness of root.visibleTo) {
      aliases.push({ harness, scope: root.scope, rootPath: physicalRoot });
    }
  }
  return aliases.sort((left, right) =>
    left.harness.localeCompare(right.harness)
    || left.scope.localeCompare(right.scope)
    || left.rootPath.localeCompare(right.rootPath)
  );
}

async function assertAdjacentRename(path: string): Promise<void> {
  const [source, parent] = await Promise.all([stat(path), stat(dirname(path))]);
  if (!source.isDirectory() || !parent.isDirectory() || source.dev !== parent.dev) {
    throw new GovernanceError(
      "UNSUPPORTED_FILESYSTEM",
      "Active Skill cannot be atomically renamed beside its current path"
    );
  }
}

async function assertManagedQuarantineContainer(stateDirectory: string): Promise<void> {
  const container = join(stateDirectory, "quarantine");
  try {
    const metadata = await lstat(container);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(container) !== container) {
      throw new GovernanceError(
        "UNSAFE_DESTINATION",
        "Managed quarantine directory must be a physical directory"
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function planId(input: string): string {
  const parsed = governancePlanIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new GovernanceError("PLAN_INVALID", "Governance plan ID is unsafe");
  }
  return parsed.data;
}

export interface PlanQuarantineInput {
  skill: SkillRecord;
  activeRoots: SkillRoot[];
  stateDirectory: string;
  now?: Date;
  id?: () => string;
}

export async function planQuarantine(input: PlanQuarantineInput): Promise<GovernancePlan> {
  const skill = skillRecordSchema.parse(input.skill);
  const activePath = resolve(skill.path);
  const metadata = await lstat(activePath).catch((error) => {
    throw new GovernanceError("SOURCE_UNSAFE", `Active Skill is unavailable: ${String(error)}`);
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new GovernanceError("SOURCE_UNSAFE", "Active Skill must be a non-symlink directory");
  }
  const physicalSource = await realpath(activePath);
  if (physicalSource !== activePath) {
    throw new GovernanceError("SOURCE_UNSAFE", "Active Skill path must already be physical");
  }
  assertSafeName(physicalSource);
  await assertSafeTree(physicalSource);
  const visibleAliases = await aliasesFor(physicalSource, input.activeRoots);
  if (visibleAliases.length === 0) {
    throw new GovernanceError(
      "SOURCE_OUTSIDE_ACTIVE_ROOT",
      "Active Skill is outside every discovered active root"
    );
  }
  if (await fingerprintDirectory(physicalSource) !== skill.fingerprint) {
    throw new GovernanceError("SOURCE_DRIFT", "Active Skill changed after the portfolio scan");
  }
  await assertAdjacentRename(physicalSource);

  const physicalState = await physicalDirectory(input.stateDirectory, "UNSAFE_DESTINATION");
  await assertManagedQuarantineContainer(physicalState);
  if (
    physicalSource === physicalState
    || isWithin(physicalSource, physicalState)
    || isWithin(physicalState, physicalSource)
  ) {
    throw new GovernanceError("UNSAFE_DESTINATION", "Quarantine state and active Skill overlap");
  }
  const id = planId(input.id?.() ?? randomUUID());
  const transactionDirectory = join(physicalState, "quarantine", id);
  const vaultPath = join(transactionDirectory, basename(physicalSource));
  const stagingPath = join(transactionDirectory, `.${basename(physicalSource)}.staging`);
  const rollbackPath = join(
    dirname(physicalSource),
    `.${basename(physicalSource)}.skill-steward-quarantine-${id}.rollback`
  );
  await Promise.all([
    assertAbsent(transactionDirectory),
    assertAbsent(rollbackPath)
  ]);

  const now = input.now ?? new Date();
  return governancePlanSchema.parse({
    schemaVersion: 1,
    id,
    kind: "quarantine",
    skillId: skill.id,
    activePath: physicalSource,
    vaultPath,
    stagingPath,
    rollbackPath,
    sourceFingerprint: skill.fingerprint,
    expectedDestinationFingerprint: null,
    visibleAliases,
    operations: [
      { operation: "copy-to-staging", from: physicalSource, to: stagingPath },
      { operation: "verify-staging", path: stagingPath, fingerprint: skill.fingerprint },
      { operation: "move-active-to-rollback", from: physicalSource, to: rollbackPath },
      { operation: "commit-vault", from: stagingPath, to: vaultPath },
      { operation: "append-journal", transactionId: id },
      { operation: "cleanup-rollback", path: rollbackPath }
    ],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString()
  });
}

export interface PlanRestoreInput {
  quarantined: QuarantinedSkill;
  activeRoots: SkillRoot[];
  stateDirectory: string;
  now?: Date;
  id?: () => string;
}

export async function planRestore(input: PlanRestoreInput): Promise<GovernancePlan> {
  const quarantined = quarantinedSkillSchema.parse(input.quarantined);
  const physicalState = await physicalDirectory(input.stateDirectory, "UNSAFE_DESTINATION");
  await assertManagedQuarantineContainer(physicalState);
  const expectedTransactionRoot = join(physicalState, "quarantine", quarantined.transactionId);
  const vaultPath = await realpath(resolve(quarantined.vaultPath)).catch(() => {
    throw new GovernanceError("VAULT_DRIFT", "Quarantine vault is unavailable");
  });
  if (!isWithin(expectedTransactionRoot, vaultPath)) {
    throw new GovernanceError("UNSAFE_DESTINATION", "Quarantine vault escapes managed state");
  }
  await assertSafeTree(vaultPath);
  if (await fingerprintDirectory(vaultPath) !== quarantined.fingerprint) {
    throw new GovernanceError("VAULT_DRIFT", "Quarantined Skill changed after commit");
  }

  const activePath = resolve(quarantined.originalPath);
  assertSafeName(activePath);
  await assertAbsent(activePath);
  const activeParent = await physicalDirectory(dirname(activePath), "UNSAFE_DESTINATION");
  if (activeParent !== dirname(activePath)) {
    throw new GovernanceError("UNSAFE_DESTINATION", "Restore parent must already be physical");
  }
  const visibleNow = await aliasesFor(activePath, input.activeRoots);
  if (visibleNow.length === 0) {
    throw new GovernanceError(
      "SOURCE_OUTSIDE_ACTIVE_ROOT",
      "Restore destination is outside every discovered active root"
    );
  }
  const id = planId(input.id?.() ?? randomUUID());
  const stagingPath = join(
    activeParent,
    `.${basename(activePath)}.skill-steward-restore-${id}.tmp`
  );
  await assertAbsent(stagingPath);
  const now = input.now ?? new Date();
  return governancePlanSchema.parse({
    schemaVersion: 1,
    id,
    kind: "restore",
    sourceTransactionId: quarantined.transactionId,
    skillId: quarantined.skillId,
    activePath,
    vaultPath,
    stagingPath,
    sourceFingerprint: quarantined.fingerprint,
    expectedDestinationFingerprint: null,
    visibleAliases: quarantined.visibleAliases,
    operations: [
      { operation: "copy-to-staging", from: vaultPath, to: stagingPath },
      { operation: "verify-staging", path: stagingPath, fingerprint: quarantined.fingerprint },
      { operation: "restore-active", from: stagingPath, to: activePath },
      { operation: "append-journal", transactionId: id },
      { operation: "cleanup-vault", path: vaultPath }
    ],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString()
  });
}
