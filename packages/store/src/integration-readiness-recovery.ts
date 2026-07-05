import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";
import { z } from "zod";
import {
  fingerprintIntegrationFileBytes,
  withIntegrationFileMutationClaim,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions
} from "./integration-file-transaction.js";
import {
  assertIntegrationFileMutationBoundary,
  bindIntegrationDirectoryChain,
  collapseIntegrationHardLinkPairClaimed,
  moveExactIntegrationFileClaimed,
  readExactIntegrationFile,
  removeExactIntegrationFileClaimed,
  requireIntegrationExpectedState,
  sameIntegrationExpectedState,
  syncIntegrationParent,
  writeOwnedIntegrationSibling,
  type ExactIntegrationFile,
  type ExactIntegrationSnapshot
} from "./integration-file-proof.js";
import { assertIntegrationMutationLeaseOwned } from "./integration-mutation-lease.js";
import { isIntegrationMutationUncertainty } from "./integration-uncertainty.js";
import { resolveIntegrationReadinessTransactionHandle } from "./integration-readiness-authority.js";
import {
  IntegrationReadinessError,
  type IntegrationReadinessRecoveryArtifact,
  type IntegrationReadinessRecoveryDesiredState,
  type IntegrationReadinessRecoveryFileState
} from "./integration-readiness-domain.js";
import {
  integrationReadinessRecoveryBindingSchema,
  type IntegrationReadinessRecoveryBinding
} from "./integration-readiness-recovery-binding.js";

export type { IntegrationReadinessRecoveryArtifact } from "./integration-readiness-domain.js";

export const LATEST_REPORT = "latest-report.json";
export const PREVIOUS_REPORT = "previous-report.json";
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_REPORT_BYTES = 4 * Math.ceil(MAX_REPORT_BYTES / 3);
export const MAX_BACKUP_BYTES = 4 * MAX_BASE64_REPORT_BYTES + 64 * 1024;

export function integrationReadinessPublicationTransactionId(
  transactionId: string,
  role: "latest" | "previous" | "backup"
): string {
  const key = createHash("sha256")
    .update(`${transactionId}:${role}:publication`)
    .digest("hex")
    .slice(0, 24);
  return `readiness-publish-${key}`;
}
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
function isCanonicalBase64Syntax(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = code >= 65 && code <= 90
      || code >= 97 && code <= 122
      || code >= 48 && code <= 57
      || code === 43
      || code === 47;
    if (!allowed) return false;
  }
  return true;
}
const base64Schema = z.string().max(MAX_BASE64_REPORT_BYTES).superRefine((value, context) => {
  if (value.length > MAX_BASE64_REPORT_BYTES) return;
  if (!isCanonicalBase64Syntax(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Backup bytes must use canonical base64 syntax" });
  }
});
const identitySchema = z.object({
  device: z.string().max(64).regex(/^[0-9]+$/),
  inode: z.string().max(64).regex(/^[1-9][0-9]*$/)
}).strict();
const absentSchema = z.object({ state: z.literal("absent") }).strict();
const fileSchema = z.object({
  state: z.literal("file"),
  bytesBase64: base64Schema,
  fingerprint: fingerprintSchema,
  mode: z.number().int().min(0).max(0o777)
}).strict().superRefine((value, context) => {
  if (
    value.bytesBase64.length > MAX_BASE64_REPORT_BYTES
    || !isCanonicalBase64Syntax(value.bytesBase64)
  ) return;
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== value.bytesBase64
    ||
    bytes.length > MAX_REPORT_BYTES
    || fingerprintIntegrationFileBytes(bytes) !== value.fingerprint
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Backup report bytes are invalid" });
  }
});
const stateSchema = z.union([absentSchema, fileSchema]);

export const integrationReadinessBackupSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().min(1).max(256),
  reportFingerprint: fingerprintSchema,
  trigger: z.object({
    planId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    harness: z.enum(["codex", "claude-code", "github-copilot"]),
    createdAt: z.string().max(64).datetime()
  }).strict(),
  latest: stateSchema,
  previous: stateSchema,
  intended: z.object({
    latest: stateSchema,
    previous: stateSchema
  }).strict()
}).strict();

export type IntegrationReadinessBackup = z.infer<typeof integrationReadinessBackupSchema>;

const observedSchema = z.union([
  absentSchema,
  z.object({
    state: z.literal("file"),
    bytesBase64: base64Schema,
    fingerprint: fingerprintSchema,
    mode: z.number().int().min(0).max(0o777),
    identity: identitySchema
  }).strict().superRefine((value, context) => {
    if (
      value.bytesBase64.length > MAX_BASE64_REPORT_BYTES
      || !isCanonicalBase64Syntax(value.bytesBase64)
    ) return;
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (
      bytes.toString("base64") !== value.bytesBase64
      ||
      bytes.length > MAX_REPORT_BYTES
      || fingerprintIntegrationFileBytes(bytes) !== value.fingerprint
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Observed recovery report bytes are invalid"
      });
    }
  })
]);

export const integrationReadinessRecoveryArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().min(1).max(256),
  stateDirectory: z.string().min(1).max(4_096).refine(
    (path) => isAbsolute(path) && normalize(path) === path,
    "Recovery state directory must be absolute and normalized"
  ),
  stateDirectoryIdentity: identitySchema,
  reportFingerprint: fingerprintSchema,
  trigger: integrationReadinessBackupSchema.shape.trigger,
  backup: z.object({ fingerprint: fingerprintSchema, identity: identitySchema }).strict(),
  latest: z.object({ before: stateSchema, observed: observedSchema }).strict(),
  previous: z.object({ before: stateSchema, observed: observedSchema }).strict()
}).strict();

function recoveryError(
  code: "INTEGRATION_READINESS_INVALID" | "INTEGRATION_READINESS_UNCERTAIN"
    | "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
  message: string,
  causes: unknown[]
): IntegrationReadinessError {
  return new IntegrationReadinessError(code, message, {
    cause: causes.length === 1 ? causes[0] : new AggregateError(causes, message)
  });
}

function immutableJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) immutableJson(child);
    Object.freeze(value);
  }
  return value;
}

function identity(metadata: { dev: bigint; ino: bigint }) {
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function physicalIdentity(value: { device: string; inode: string }) {
  return { device: BigInt(value.device), inode: BigInt(value.inode) };
}

function observed(
  snapshot: Awaited<ReturnType<typeof readExactIntegrationFile>>
): IntegrationReadinessRecoveryFileState {
  return snapshot.state === "absent" ? { state: "absent" } : {
    state: "file",
    bytesBase64: snapshot.bytes.toString("base64"),
    fingerprint: snapshot.fingerprint,
    mode: snapshot.mode,
    identity: identity(snapshot.metadata)
  };
}

function snapshotMatchesDesired(
  snapshot: Awaited<ReturnType<typeof readExactIntegrationFile>>,
  desired: IntegrationReadinessRecoveryDesiredState
): boolean {
  return snapshot.state === desired.state && (
    snapshot.state === "absent" || desired.state === "absent" || (
      snapshot.fingerprint === desired.fingerprint
      && snapshot.mode === desired.mode
      && snapshot.bytes.equals(Buffer.from(desired.bytesBase64, "base64"))
    )
  );
}

function observedMatchesDesired(
  current: IntegrationReadinessRecoveryFileState,
  desired: IntegrationReadinessRecoveryDesiredState
): boolean {
  return current.state === desired.state && (
    current.state === "absent" || desired.state === "absent" || (
      current.fingerprint === desired.fingerprint
      && current.mode === desired.mode
      && current.bytesBase64 === desired.bytesBase64
    )
  );
}

export function integrationReadinessBackupPath(
  stateDirectory: string,
  transactionId: string
): string {
  const key = createHash("sha256").update(transactionId).digest("hex");
  return join(stateDirectory, `.integration-readiness.${key}.backup.json`);
}

function integrationReadinessBackupCleanupPathFor(
  stateDirectory: string,
  transactionId: string
): string {
  return `${integrationReadinessBackupPath(stateDirectory, transactionId)}.recovery-${createHash("sha256")
    .update(`${transactionId}:backup`)
    .digest("hex")
    .slice(0, 24)}.claim`;
}

function integrationReadinessBackupCleanupPath(
  artifact: IntegrationReadinessRecoveryArtifact
): string {
  return integrationReadinessBackupCleanupPathFor(
    artifact.stateDirectory,
    artifact.transactionId
  );
}

function integrationReadinessBackupPublicationPaths(
  stateDirectory: string,
  transactionId: string
): { temporary: string; cleanupClaim: string } {
  const backupPath = integrationReadinessBackupPath(stateDirectory, transactionId);
  const temporary = `${backupPath}.skill-steward.${integrationReadinessPublicationTransactionId(
    transactionId,
    "backup"
  )}.tmp`;
  return { temporary, cleanupClaim: `${temporary}.cleanup.claim` };
}

export async function reconcileIntegrationReadinessBackupPublicationClaimed(
  backup: IntegrationReadinessBackup,
  backupBytes: Uint8Array,
  options: IntegrationFileMutationOptions
): Promise<boolean> {
  const stateDirectory = resolve(options.stateDirectory);
  const targetPath = integrationReadinessBackupPath(stateDirectory, backup.transactionId);
  const paths = integrationReadinessBackupPublicationPaths(stateDirectory, backup.transactionId);
  const proofs = await bindIntegrationDirectoryChain(stateDirectory, targetPath);
  const expectedContent: IntegrationFileContentState = {
    state: "file",
    bytes: Buffer.from(backupBytes),
    fingerprint: fingerprintIntegrationFileBytes(backupBytes),
    mode: 0o600
  };
  await collapseIntegrationHardLinkPairClaimed(
    paths.temporary,
    paths.cleanupClaim,
    proofs,
    options,
    "Readiness backup publication residue",
    {
      fingerprint: expectedContent.fingerprint,
      bytes: expectedContent.bytes,
      mode: expectedContent.mode,
      maxBytes: MAX_BACKUP_BYTES
    }
  );
  let [target, temporary, cleanupClaim] = await Promise.all([
    readExactIntegrationFile(targetPath, MAX_BACKUP_BYTES, proofs, "Readiness backup target"),
    readExactIntegrationFile(paths.temporary, MAX_BACKUP_BYTES, proofs, "Readiness backup temporary"),
    readExactIntegrationFile(
      paths.cleanupClaim,
      MAX_BACKUP_BYTES,
      proofs,
      "Readiness backup temporary cleanup claim"
    )
  ]);
  if (target.state === "file") {
    if (!sameIntegrationExpectedState(target, expectedContent)) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Readiness backup target differs from intended exact bytes",
        []
      );
    }
    return true;
  }
  if (temporary.state === "absent" && cleanupClaim.state === "absent") return false;
  if (temporary.state === "file" && cleanupClaim.state === "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup temporary and cleanup claim both exist",
      []
    );
  }
  const activePath = temporary.state === "file" ? paths.temporary : paths.cleanupClaim;
  const active = temporary.state === "file" ? temporary : cleanupClaim;
  if (active.state !== "file" || !sameIntegrationExpectedState(active, expectedContent)) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup publication residue differs from intended bytes",
      []
    );
  }
  target = await moveExactIntegrationFileClaimed({
    sourcePath: activePath,
    destinationPath: targetPath,
    source: active,
    destinationBefore: { state: "absent" },
    destinationAfter: expectedContent,
    maxBytes: MAX_BACKUP_BYTES,
    proofs,
    options,
    label: "Readiness backup residue publication"
  });
  temporary = { state: "absent" };
  cleanupClaim = { state: "absent" };
  return target.state === "file";
}

export async function cleanupIntegrationReadinessBackupClaimed(
  artifact: IntegrationReadinessRecoveryArtifact,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const latestPath = join(artifact.stateDirectory, LATEST_REPORT);
  const proofs = await bindIntegrationDirectoryChain(artifact.stateDirectory, latestPath);
  const backupPath = integrationReadinessBackupPath(
    artifact.stateDirectory,
    artifact.transactionId
  );
  const cleanupPath = integrationReadinessBackupCleanupPath(artifact);
  await collapseIntegrationHardLinkPairClaimed(
    backupPath,
    cleanupPath,
    proofs,
    options,
    "Readiness backup cleanup",
    {
      fingerprint: artifact.backup.fingerprint,
      mode: 0o600,
      maxBytes: MAX_BACKUP_BYTES,
      identity: physicalIdentity(artifact.backup.identity)
    }
  );
  let [backup, cleanup] = await Promise.all([
    readExactIntegrationFile(backupPath, MAX_BACKUP_BYTES, proofs, "Readiness backup cleanup"),
    readExactIntegrationFile(cleanupPath, MAX_BACKUP_BYTES, proofs, "Readiness backup cleanup claim")
  ]);
  if (backup.state === "absent" && cleanup.state === "absent") return;
  if (backup.state === "file" && cleanup.state === "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup and cleanup claim both exist",
      []
    );
  }
  const active = backup.state === "file" ? backup : cleanup;
  if (
    active.state !== "file"
    || active.fingerprint !== artifact.backup.fingerprint
    || active.mode !== 0o600
    || active.metadata.dev.toString() !== artifact.backup.identity.device
    || active.metadata.ino.toString() !== artifact.backup.identity.inode
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup cleanup authority changed",
      []
    );
  }
  if (backup.state === "file") {
    cleanup = await moveExactIntegrationFileClaimed({
      sourcePath: backupPath,
      destinationPath: cleanupPath,
      source: backup,
      destinationBefore: { state: "absent" },
      destinationAfter: {
        state: "file",
        bytes: backup.bytes,
        fingerprint: backup.fingerprint,
        mode: backup.mode
      },
      maxBytes: MAX_BACKUP_BYTES,
      proofs,
      options,
      label: "Readiness backup cleanup claim"
    });
    backup = { state: "absent" };
  }
  if (cleanup.state !== "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness backup cleanup claim is unavailable",
      []
    );
  }
  await removeExactIntegrationFileClaimed({
    sourcePath: cleanupPath,
    claimPath: cleanupPath,
    source: cleanup,
    maxBytes: MAX_BACKUP_BYTES,
    proofs,
    options,
    label: "Readiness backup cleanup"
  });
}

export async function captureIntegrationReadinessRecoveryArtifact(
  backup: IntegrationReadinessBackup,
  backupBytes: Uint8Array,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessRecoveryArtifact> {
  const stateDirectory = resolve(options.stateDirectory);
  const latestPath = join(stateDirectory, LATEST_REPORT);
  const proofs = await bindIntegrationDirectoryChain(stateDirectory, latestPath);
  await assertIntegrationFileMutationBoundary(options, proofs);
  const [backupSnapshot, latestSnapshot, previousSnapshot] = await Promise.all([
    readExactIntegrationFile(
      integrationReadinessBackupPath(stateDirectory, backup.transactionId),
      MAX_BACKUP_BYTES,
      proofs,
      "Readiness recovery backup"
    ),
    readExactIntegrationFile(latestPath, MAX_REPORT_BYTES, proofs, "Readiness recovery latest"),
    readExactIntegrationFile(
      join(stateDirectory, PREVIOUS_REPORT),
      MAX_REPORT_BYTES,
      proofs,
      "Readiness recovery previous"
    )
  ]);
  await assertIntegrationFileMutationBoundary(options, proofs);
  if (
    backupSnapshot.state !== "file"
    || backupSnapshot.fingerprint !== fingerprintIntegrationFileBytes(backupBytes)
    || !backupSnapshot.bytes.equals(Buffer.from(backupBytes))
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness recovery backup cannot be proven exactly",
      []
    );
  }
  if (
    !(snapshotMatchesDesired(latestSnapshot, backup.latest)
      || snapshotMatchesDesired(latestSnapshot, backup.intended.latest))
    || !(snapshotMatchesDesired(previousSnapshot, backup.previous)
      || snapshotMatchesDesired(previousSnapshot, backup.intended.previous))
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness targets are neither exact pre-state nor intended published state",
      []
    );
  }
  return immutableJson(integrationReadinessRecoveryArtifactSchema.parse({
    schemaVersion: 1,
    transactionId: backup.transactionId,
    stateDirectory,
    stateDirectoryIdentity: identity({
      dev: proofs[0]!.identity.device,
      ino: proofs[0]!.identity.inode
    }),
    reportFingerprint: backup.reportFingerprint,
    trigger: backup.trigger,
    backup: { fingerprint: backupSnapshot.fingerprint, identity: identity(backupSnapshot.metadata) },
    latest: { before: backup.latest, observed: observed(latestSnapshot) },
    previous: { before: backup.previous, observed: observed(previousSnapshot) }
  }) as IntegrationReadinessRecoveryArtifact);
}

export function integrationReadinessRecoveryArtifact(handle: unknown): IntegrationReadinessRecoveryArtifact {
  return immutableJson(structuredClone(
    resolveIntegrationReadinessTransactionHandle(handle).recoveryArtifact
  ));
}

async function loadBoundReadinessRecovery(
  input: IntegrationReadinessRecoveryBinding,
  options: IntegrationFileMutationOptions
): Promise<{
  artifact: IntegrationReadinessRecoveryArtifact;
  backup: IntegrationReadinessBackup;
}> {
  const binding = integrationReadinessRecoveryBindingSchema.parse(input);
  if (resolve(options.stateDirectory) !== binding.stateDirectory) {
    throw recoveryError(
      "INTEGRATION_READINESS_INVALID",
      "Readiness recovery authority belongs to another state",
      []
    );
  }
  const latestPath = join(binding.stateDirectory, LATEST_REPORT);
  const proofs = await bindIntegrationDirectoryChain(binding.stateDirectory, latestPath);
  await assertIntegrationFileMutationBoundary(options, proofs);
  if (
    proofs[0]!.identity.device.toString() !== binding.stateDirectoryIdentity.device
    || proofs[0]!.identity.inode.toString() !== binding.stateDirectoryIdentity.inode
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness recovery state identity changed",
      []
    );
  }
  const backupPath = integrationReadinessBackupPath(
    binding.stateDirectory,
    binding.readinessTransactionId
  );
  const cleanupPath = integrationReadinessBackupCleanupPathFor(
    binding.stateDirectory,
    binding.readinessTransactionId
  );
  await collapseIntegrationHardLinkPairClaimed(
    backupPath,
    cleanupPath,
    proofs,
    options,
    "Readiness bound recovery backup",
    {
      fingerprint: binding.backup.fingerprint,
      mode: 0o600,
      maxBytes: MAX_BACKUP_BYTES,
      identity: physicalIdentity(binding.backup.identity)
    }
  );
  let [snapshot, cleanup] = await Promise.all([
    readExactIntegrationFile(
      backupPath,
      MAX_BACKUP_BYTES,
      proofs,
      "Readiness bound recovery backup"
    ),
    readExactIntegrationFile(
      cleanupPath,
      MAX_BACKUP_BYTES,
      proofs,
      "Readiness bound recovery backup cleanup claim"
    )
  ]);
  await assertIntegrationFileMutationBoundary(options, proofs);
  if (snapshot.state === "file" && cleanup.state === "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness bound recovery backup and cleanup claim conflict",
      []
    );
  }
  if (snapshot.state === "absent" && cleanup.state === "file") {
    if (
      cleanup.fingerprint !== binding.backup.fingerprint
      || cleanup.mode !== 0o600
      || cleanup.metadata.dev.toString() !== binding.backup.identity.device
      || cleanup.metadata.ino.toString() !== binding.backup.identity.inode
    ) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Readiness bound recovery cleanup claim changed",
        []
      );
    }
    snapshot = await moveExactIntegrationFileClaimed({
      sourcePath: cleanupPath,
      destinationPath: backupPath,
      source: cleanup,
      destinationBefore: { state: "absent" },
      destinationAfter: {
        state: "file",
        bytes: cleanup.bytes,
        fingerprint: cleanup.fingerprint,
        mode: cleanup.mode
      },
      maxBytes: MAX_BACKUP_BYTES,
      proofs,
      options,
      label: "Readiness bound recovery backup cleanup retry"
    });
    cleanup = { state: "absent" };
  }
  await assertIntegrationFileMutationBoundary(options, proofs);
  if (
    snapshot.state !== "file"
    || snapshot.fingerprint !== binding.backup.fingerprint
    || snapshot.mode !== 0o600
    || snapshot.metadata.dev.toString() !== binding.backup.identity.device
    || snapshot.metadata.ino.toString() !== binding.backup.identity.inode
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness bound recovery backup changed",
      []
    );
  }
  let backup: IntegrationReadinessBackup;
  try {
    backup = integrationReadinessBackupSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)
    ));
  } catch (error) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness bound recovery backup is invalid",
      [error]
    );
  }
  if (
    backup.transactionId !== binding.readinessTransactionId
    || backup.reportFingerprint !== binding.reportFingerprint
    || JSON.stringify(backup.trigger) !== JSON.stringify(binding.trigger)
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness recovery binding does not match its fixed backup",
      []
    );
  }
  const artifact = await captureIntegrationReadinessRecoveryArtifact(
    backup,
    snapshot.bytes,
    options
  );
  if (
    artifact.transactionId !== binding.readinessTransactionId
    || artifact.stateDirectory !== binding.stateDirectory
    || JSON.stringify(artifact.stateDirectoryIdentity)
      !== JSON.stringify(binding.stateDirectoryIdentity)
    || JSON.stringify(artifact.backup) !== JSON.stringify(binding.backup)
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness recovery binding changed during reconstruction",
      []
    );
  }
  for (const [target, desired, persisted] of [
    [artifact.latest, backup.latest, binding.latest.observed],
    [artifact.previous, backup.previous, binding.previous.observed]
  ] as const) {
    if (
      observedMatchesDesired(target.observed, desired)
      && JSON.stringify(target.observed.state === "absent"
        ? { state: "absent" }
        : {
            state: "file",
            fingerprint: target.observed.fingerprint,
            mode: target.observed.mode,
            identity: target.observed.identity
          }) !== JSON.stringify(persisted)
    ) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Readiness prepublication identity changed",
        []
      );
    }
  }
  return { artifact, backup };
}

function reconstructIntendedLatestReport(
  backup: IntegrationReadinessBackup
): PortfolioReport {
  if (backup.intended.latest.state !== "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Committed readiness backup has no intended latest report",
      []
    );
  }
  let report: PortfolioReport;
  try {
    report = portfolioReportSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(backup.intended.latest.bytesBase64, "base64")
      )
    ));
  } catch (error) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Committed readiness intended latest report is invalid",
      [error]
    );
  }
  if (report.portfolioFingerprint !== backup.reportFingerprint) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Committed readiness report fingerprint does not match its central backup",
      []
    );
  }
  return report;
}

export async function restoreIntegrationReadinessFromBindingClaimed(
  binding: IntegrationReadinessRecoveryBinding,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const { artifact } = await loadBoundReadinessRecovery(binding, options);
  await restoreIntegrationReadinessFromArtifactClaimed(artifact, options);
}

export async function finalizeIntegrationReadinessFromBindingClaimed(
  binding: IntegrationReadinessRecoveryBinding,
  options: IntegrationFileMutationOptions,
  appendHistory: (report: PortfolioReport) => Promise<void>,
  assertCurrentLifecycleRecord: () => Promise<void>
): Promise<void> {
  await assertCurrentLifecycleRecord();
  const { artifact, backup } = await loadBoundReadinessRecovery(binding, options);
  for (const [path, desired, label] of [
    [join(binding.stateDirectory, LATEST_REPORT), backup.intended.latest, "latest"],
    [join(binding.stateDirectory, PREVIOUS_REPORT), backup.intended.previous, "previous"]
  ] as const) {
    const proofs = await bindIntegrationDirectoryChain(binding.stateDirectory, path);
    await requireIntegrationExpectedState(
      path,
      expected(desired),
      MAX_REPORT_BYTES,
      proofs,
      `Committed readiness ${label}`
    );
  }
  const report = reconstructIntendedLatestReport(backup);
  await assertCurrentLifecycleRecord();
  await appendHistory(report);
  await assertCurrentLifecycleRecord();
  await cleanupIntegrationReadinessBackupClaimed(artifact, options);
}

async function deriveClaimed(
  transactionId: string,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessRecoveryArtifact> {
  const id = integrationReadinessBackupSchema.shape.transactionId.safeParse(transactionId);
  if (!id.success) throw recoveryError("INTEGRATION_READINESS_INVALID", "Invalid recovery ID", [id.error]);
  const stateDirectory = resolve(options.stateDirectory);
  const proofs = await bindIntegrationDirectoryChain(stateDirectory, join(stateDirectory, LATEST_REPORT));
  let snapshot = await readExactIntegrationFile(
    integrationReadinessBackupPath(stateDirectory, id.data),
    MAX_BACKUP_BYTES,
    proofs,
    "Readiness recovery backup derivation"
  );
  if (snapshot.state !== "file") {
    const publicationPaths = integrationReadinessBackupPublicationPaths(stateDirectory, id.data);
    const [temporary, cleanupClaim] = await Promise.all([
      readExactIntegrationFile(
        publicationPaths.temporary,
        MAX_BACKUP_BYTES,
        proofs,
        "Readiness backup derivation temporary"
      ),
      readExactIntegrationFile(
        publicationPaths.cleanupClaim,
        MAX_BACKUP_BYTES,
        proofs,
        "Readiness backup derivation cleanup claim"
      )
    ]);
    if (temporary.state === "file" && cleanupClaim.state === "file") {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Recovery backup publication residues conflict",
        []
      );
    }
    const active = temporary.state === "file" ? temporary : cleanupClaim;
    if (active.state !== "file") {
      throw recoveryError("INTEGRATION_READINESS_RECOVERY_INCOMPLETE", "Recovery backup is absent", []);
    }
    let residueRecord: IntegrationReadinessBackup;
    try {
      residueRecord = integrationReadinessBackupSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(active.bytes)
      ));
    } catch (error) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Recovery backup publication residue is invalid",
        [error]
      );
    }
    if (residueRecord.transactionId !== id.data) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Recovery backup publication residue has another transaction ID",
        []
      );
    }
    await reconcileIntegrationReadinessBackupPublicationClaimed(
      residueRecord,
      active.bytes,
      options
    );
    snapshot = await readExactIntegrationFile(
      integrationReadinessBackupPath(stateDirectory, id.data),
      MAX_BACKUP_BYTES,
      proofs,
      "Derived readiness recovery backup"
    );
    if (snapshot.state !== "file") {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        "Recovery backup reconciliation did not publish",
        []
      );
    }
  }
  let record: IntegrationReadinessBackup;
  try {
    record = integrationReadinessBackupSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)
    ));
  } catch (error) {
    throw recoveryError("INTEGRATION_READINESS_RECOVERY_INCOMPLETE", "Recovery backup is invalid", [error]);
  }
  if (record.transactionId !== id.data) {
    throw recoveryError("INTEGRATION_READINESS_RECOVERY_INCOMPLETE", "Recovery ID mismatch", []);
  }
  return immutableJson(await captureIntegrationReadinessRecoveryArtifact(record, snapshot.bytes, options));
}

export async function deriveIntegrationReadinessRecoveryArtifact(
  transactionId: string,
  options: IntegrationFileMutationOptions
): Promise<IntegrationReadinessRecoveryArtifact> {
  try {
    return await withIntegrationFileMutationClaim(
      options.leaseContext,
      () => deriveClaimed(transactionId, options)
    );
  } catch (error) {
    if (error instanceof IntegrationReadinessError) throw error;
    throw recoveryError(
      isIntegrationMutationUncertainty(error)
        ? "INTEGRATION_READINESS_UNCERTAIN"
        : "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness recovery artifact could not be derived exactly",
      [error]
    );
  }
}

function expected(state: IntegrationReadinessRecoveryDesiredState): IntegrationFileExpectedState {
  return state.state === "absent" ? { state: "absent" } : {
    state: "file",
    bytes: Buffer.from(state.bytesBase64, "base64"),
    fingerprint: state.fingerprint,
    mode: state.mode
  };
}

export async function verifyIntegrationReadinessRecoveryTarget(
  targetPath: string,
  target: IntegrationReadinessRecoveryArtifact["latest"],
  artifact: IntegrationReadinessRecoveryArtifact
): Promise<void> {
  const proofs = await bindIntegrationDirectoryChain(artifact.stateDirectory, targetPath);
  const current = await requireIntegrationExpectedState(
    targetPath,
    expected(target.observed),
    MAX_REPORT_BYTES,
    proofs,
    "Readiness finalized target"
  );
  if (target.observed.state === "file" && (
    current.state !== "file"
    || current.metadata.dev.toString() !== target.observed.identity.device
    || current.metadata.ino.toString() !== target.observed.identity.inode
  )) throw new Error("Readiness finalized target identity changed");
}

async function verifyCompletedTargetWithoutAuthority(
  targetPath: string,
  target: IntegrationReadinessRecoveryArtifact["latest"],
  artifact: IntegrationReadinessRecoveryArtifact,
  role: "latest" | "previous"
): Promise<void> {
  const proofs = await bindIntegrationDirectoryChain(artifact.stateDirectory, targetPath);
  const key = createHash("sha256")
    .update(`${artifact.transactionId}:${role}`)
    .digest("hex")
    .slice(0, 24);
  const recoveryTemporary = `${targetPath}.skill-steward.readiness-${key}.tmp`;
  const paths = [
    recoveryTemporary,
    `${recoveryTemporary}.cleanup.claim`,
    `${targetPath}.skill-steward.readiness-${key}.discard`
  ];
  const publicationTemporary = `${targetPath}.skill-steward.${integrationReadinessPublicationTransactionId(
    artifact.transactionId,
    role
  )}.tmp`;
  paths.push(publicationTemporary, `${publicationTemporary}.cleanup.claim`);
  const [current, ...residues] = await Promise.all([
    readExactIntegrationFile(targetPath, MAX_REPORT_BYTES, proofs, "Completed readiness target"),
    ...paths.map((path) => readExactIntegrationFile(
      path,
      MAX_REPORT_BYTES,
      proofs,
      "Completed readiness residue"
    ))
  ]);
  if (!snapshotMatchesDesired(current!, target.before) || residues.some((item) => item.state !== "absent")) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} completion cannot be proven without central authority`,
      []
    );
  }
}

async function restoreTarget(
  targetPath: string,
  target: IntegrationReadinessRecoveryArtifact["latest"],
  artifact: IntegrationReadinessRecoveryArtifact,
  options: IntegrationFileMutationOptions,
  role: "latest" | "previous",
  intendedPublication?: IntegrationReadinessRecoveryDesiredState,
  allowTransition = true
): Promise<void> {
  const proofs = await bindIntegrationDirectoryChain(artifact.stateDirectory, targetPath);
  const key = createHash("sha256")
    .update(`${artifact.transactionId}:${role}`)
    .digest("hex")
    .slice(0, 24);
  const temporaryPath = `${targetPath}.skill-steward.readiness-${key}.tmp`;
  const temporaryCleanupClaimPath = `${temporaryPath}.cleanup.claim`;
  const discardPath = `${targetPath}.skill-steward.readiness-${key}.discard`;
  const publicationTemporaryPath = `${targetPath}.skill-steward.${integrationReadinessPublicationTransactionId(
    artifact.transactionId,
    role
  )}.tmp`;
  const publicationCleanupClaimPath = `${publicationTemporaryPath}.cleanup.claim`;
  const desired = expected(target.before);
  const observedState = expected(target.observed);

  if (intendedPublication?.state === "file") {
    const intended = expected(intendedPublication) as IntegrationFileContentState;
    await collapseIntegrationHardLinkPairClaimed(
      targetPath,
      publicationTemporaryPath,
      proofs,
      options,
      `Readiness ${role} original publication`,
      {
        fingerprint: intended.fingerprint,
        bytes: intended.bytes,
        mode: intended.mode,
        maxBytes: MAX_REPORT_BYTES,
        ...(target.observed.state === "file"
          && target.observed.fingerprint === intended.fingerprint
          ? { identity: physicalIdentity(target.observed.identity) }
          : {})
      }
    );
  }
  if (target.observed.state === "file") {
    const observedAuthority = observedState as IntegrationFileContentState;
    await collapseIntegrationHardLinkPairClaimed(
      discardPath,
      targetPath,
      proofs,
      options,
      `Readiness ${role} target claim`,
      {
        fingerprint: observedAuthority.fingerprint,
        bytes: observedAuthority.bytes,
        mode: observedAuthority.mode,
        maxBytes: MAX_REPORT_BYTES,
        identity: physicalIdentity(target.observed.identity)
      }
    );
  }
  if (target.before.state === "file") {
    const desiredAuthority = desired as IntegrationFileContentState;
    const authority = {
      fingerprint: desiredAuthority.fingerprint,
      bytes: desiredAuthority.bytes,
      mode: desiredAuthority.mode,
      maxBytes: MAX_REPORT_BYTES
    };
    await collapseIntegrationHardLinkPairClaimed(
      targetPath,
      temporaryPath,
      proofs,
      options,
      `Readiness ${role} recovery publication`,
      authority
    );
    await collapseIntegrationHardLinkPairClaimed(
      temporaryPath,
      temporaryCleanupClaimPath,
      proofs,
      options,
      `Readiness ${role} recovery temporary`,
      authority
    );
  }
  if (intendedPublication?.state === "file") {
    const intended = expected(intendedPublication) as IntegrationFileContentState;
    await collapseIntegrationHardLinkPairClaimed(
      publicationTemporaryPath,
      publicationCleanupClaimPath,
      proofs,
      options,
      `Readiness ${role} publication temporary`,
      {
        fingerprint: intended.fingerprint,
        bytes: intended.bytes,
        mode: intended.mode,
        maxBytes: MAX_REPORT_BYTES
      }
    );
  }

  const read = (path: string, label: string) => readExactIntegrationFile(
    path,
    MAX_REPORT_BYTES,
    proofs,
    label
  );
  const cleanupResidue = async (
    path: string,
    residue: ExactIntegrationSnapshot,
    expectedState: IntegrationFileExpectedState,
    label: string,
    expectedIdentity?: { device: string; inode: string }
  ): Promise<void> => {
    if (residue.state === "absent") return;
    if (!sameIntegrationExpectedState(residue, expectedState)) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        `${label} no longer matches its deterministic recovery state`,
        []
      );
    }
    if (expectedIdentity && (
      residue.metadata.dev.toString() !== expectedIdentity.device
      || residue.metadata.ino.toString() !== expectedIdentity.inode
    )) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        `${label} identity changed`,
        []
      );
    }
    await removeExactIntegrationFileClaimed({
      sourcePath: path,
      claimPath: path,
      source: residue,
      maxBytes: MAX_REPORT_BYTES,
      proofs,
      options,
      label
    });
  };
  const move = async (
    sourcePath: string,
    destinationPath: string,
    source: ExactIntegrationFile,
    destinationBefore: IntegrationFileExpectedState,
    destinationAfter: IntegrationFileContentState,
    label: string
  ): Promise<ExactIntegrationFile> => {
    return moveExactIntegrationFileClaimed({
      sourcePath,
      destinationPath,
      source,
      destinationBefore,
      destinationAfter,
      maxBytes: MAX_REPORT_BYTES,
      proofs,
      options,
      label
    });
  };

  let [
    current,
    temporary,
    temporaryCleanupClaim,
    discard,
    publicationTemporary,
    publicationCleanupClaim
  ] = await Promise.all([
    read(targetPath, `Readiness ${role} recovery target`),
    read(temporaryPath, `Readiness ${role} recovery temporary`),
    read(temporaryCleanupClaimPath, `Readiness ${role} recovery temporary cleanup claim`),
    read(discardPath, `Readiness ${role} recovery discard`),
    read(publicationTemporaryPath, `Readiness ${role} publication temporary`),
    read(publicationCleanupClaimPath, `Readiness ${role} publication cleanup claim`)
  ]);
  if (temporary.state === "file" && temporaryCleanupClaim.state === "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} recovery temporary and cleanup claim both exist`,
      []
    );
  }
  if (target.before.state === "file") {
    await cleanupResidue(
      temporaryCleanupClaimPath,
      temporaryCleanupClaim,
      desired,
      `Readiness ${role} recovery temporary cleanup claim`
    );
    temporaryCleanupClaim = { state: "absent" };
  } else if (temporaryCleanupClaim.state === "file") {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} unexpected recovery cleanup claim exists`,
      []
    );
  }
  if (
    publicationTemporary.state === "file"
    && publicationCleanupClaim.state === "file"
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} publication temporary and cleanup claim both exist`,
      []
    );
  }
  if (!intendedPublication && (
    publicationTemporary.state === "file"
    || publicationCleanupClaim.state === "file"
  )) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} publication residue has no remaining central authority`,
      []
    );
  }
  if (intendedPublication) {
    const intendedState = expected(intendedPublication);
    await cleanupResidue(
      publicationTemporaryPath,
      publicationTemporary,
      intendedState,
      `Readiness ${role} publication temporary`
    );
    publicationTemporary = { state: "absent" };
    await cleanupResidue(
      publicationCleanupClaimPath,
      publicationCleanupClaim,
      intendedState,
      `Readiness ${role} publication cleanup claim`
    );
    publicationCleanupClaim = { state: "absent" };
  }
  if (discard.state === "file" && (
    target.observed.state !== "file"
    || !sameIntegrationExpectedState(discard, observedState)
    || discard.metadata.dev.toString() !== target.observed.identity.device
    || discard.metadata.ino.toString() !== target.observed.identity.inode
  )) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} discard changed`,
      []
    );
  }

  if (snapshotMatchesDesired(current, target.before)) {
    await cleanupResidue(temporaryPath, temporary, desired, `Readiness ${role} temporary`);
    await cleanupResidue(
      discardPath,
      discard,
      observedState,
      `Readiness ${role} discard`,
      target.observed.state === "file" ? target.observed.identity : undefined
    );
    return;
  }
  if (!allowTransition) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} cannot mutate after central recovery authority was removed`,
      []
    );
  }
  if (!snapshotMatchesDesired(current, target.observed)) {
    if (!(current.state === "absent" && discard.state === "file")) {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        `Readiness ${role} target is outside exact recovery states`,
        []
      );
    }
  } else if (target.observed.state === "file" && (
    current.state !== "file"
    || current.metadata.dev.toString() !== target.observed.identity.device
    || current.metadata.ino.toString() !== target.observed.identity.inode
  )) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} observed identity changed`,
      []
    );
  }

  if (target.before.state === "file" && temporary.state === "absent") {
    temporary = (await writeOwnedIntegrationSibling(
      temporaryPath,
      desired as IntegrationFileContentState,
      proofs,
      options,
      MAX_REPORT_BYTES,
      `Readiness ${role} recovery temporary`,
      target.before.mode,
      temporaryCleanupClaimPath
    )).state;
    await syncIntegrationParent(proofs, options);
  } else if (
    target.before.state === "file"
    && !snapshotMatchesDesired(temporary, target.before)
  ) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} recovery temporary changed`,
      []
    );
  }

  if (target.observed.state === "file" && current.state === "file") {
    if (discard.state !== "absent") {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        `Readiness ${role} discard was occupied before claim`,
        []
      );
    }
    discard = await move(
      targetPath,
      discardPath,
      current,
      { state: "absent" },
      observedState as IntegrationFileContentState,
      `Readiness ${role} claim`
    );
    current = { state: "absent" };
  }
  if (target.before.state === "file" && current.state === "absent") {
    if (temporary.state !== "file") {
      throw recoveryError(
        "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
        `Readiness ${role} recovery temporary is unavailable`,
        []
      );
    }
    current = await move(
      temporaryPath,
      targetPath,
      temporary,
      { state: "absent" },
      desired as IntegrationFileContentState,
      `Readiness ${role} publication`
    );
    temporary = { state: "absent" };
  }
  if (!snapshotMatchesDesired(current, target.before)) {
    throw recoveryError(
      "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      `Readiness ${role} pre-state was not restored`,
      []
    );
  }
  await cleanupResidue(temporaryPath, temporary, desired, `Readiness ${role} temporary`);
  await cleanupResidue(
    discardPath,
    discard,
    observedState,
    `Readiness ${role} discard`,
    target.observed.state === "file" ? target.observed.identity : undefined
  );
}

export async function restoreIntegrationReadinessFromArtifactClaimed(
  input: unknown,
  options: IntegrationFileMutationOptions
): Promise<void> {
  let artifact: IntegrationReadinessRecoveryArtifact;
  try {
    artifact = integrationReadinessRecoveryArtifactSchema.parse(input) as IntegrationReadinessRecoveryArtifact;
  } catch (error) {
    throw recoveryError("INTEGRATION_READINESS_INVALID", "Readiness recovery artifact is invalid", [error]);
  }
  if (resolve(options.stateDirectory) !== artifact.stateDirectory) {
    throw recoveryError("INTEGRATION_READINESS_INVALID", "Recovery artifact belongs to another state", []);
  }
  try {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, artifact.stateDirectory);
    const latestPath = join(artifact.stateDirectory, LATEST_REPORT);
    const proofs = await bindIntegrationDirectoryChain(artifact.stateDirectory, latestPath);
    if (
      proofs[0]!.identity.device.toString() !== artifact.stateDirectoryIdentity.device
      || proofs[0]!.identity.inode.toString() !== artifact.stateDirectoryIdentity.inode
    ) throw new Error("Recovery state directory identity changed");
    const backupPath = integrationReadinessBackupPath(artifact.stateDirectory, artifact.transactionId);
    const backupCleanupPath = integrationReadinessBackupCleanupPath(artifact);
    await collapseIntegrationHardLinkPairClaimed(
      backupPath,
      backupCleanupPath,
      proofs,
      options,
      "Readiness restart recovery backup",
      {
        fingerprint: artifact.backup.fingerprint,
        mode: 0o600,
        maxBytes: MAX_BACKUP_BYTES,
        identity: physicalIdentity(artifact.backup.identity)
      }
    );
    let [backup, backupCleanup] = await Promise.all([
      readExactIntegrationFile(
        backupPath,
        MAX_BACKUP_BYTES,
        proofs,
        "Readiness restart recovery backup"
      ),
      readExactIntegrationFile(
        backupCleanupPath,
        MAX_BACKUP_BYTES,
        proofs,
        "Readiness restart recovery backup claim"
      )
    ]);
    if (backup.state === "absent" && backupCleanup.state === "absent") {
      const publicationPaths = integrationReadinessBackupPublicationPaths(
        artifact.stateDirectory,
        artifact.transactionId
      );
      await collapseIntegrationHardLinkPairClaimed(
        publicationPaths.temporary,
        publicationPaths.cleanupClaim,
        proofs,
        options,
        "Restart recovery backup publication residue",
        {
          fingerprint: artifact.backup.fingerprint,
          mode: 0o600,
          maxBytes: MAX_BACKUP_BYTES,
          identity: physicalIdentity(artifact.backup.identity)
        }
      );
      const [publicationTemporary, publicationCleanupClaim] = await Promise.all([
        readExactIntegrationFile(
          publicationPaths.temporary,
          MAX_BACKUP_BYTES,
          proofs,
          "Restart recovery backup publication temporary"
        ),
        readExactIntegrationFile(
          publicationPaths.cleanupClaim,
          MAX_BACKUP_BYTES,
          proofs,
          "Restart recovery backup publication cleanup claim"
        )
      ]);
      const activePublication = publicationTemporary.state === "file"
        ? publicationTemporary
        : publicationCleanupClaim;
      if (
        activePublication.state === "file"
        && publicationTemporary.state !== publicationCleanupClaim.state
        && activePublication.fingerprint === artifact.backup.fingerprint
        && activePublication.metadata.dev.toString() === artifact.backup.identity.device
        && activePublication.metadata.ino.toString() === artifact.backup.identity.inode
      ) {
        const publicationRecord = integrationReadinessBackupSchema.parse(JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(activePublication.bytes)
        ));
        await reconcileIntegrationReadinessBackupPublicationClaimed(
          publicationRecord,
          activePublication.bytes,
          options
        );
        backup = await readExactIntegrationFile(
          backupPath,
          MAX_BACKUP_BYTES,
          proofs,
          "Reconciled restart recovery backup"
        );
      }
      const [remainingPublicationTemporary, remainingPublicationCleanupClaim] = await Promise.all([
        readExactIntegrationFile(
          publicationPaths.temporary,
          MAX_BACKUP_BYTES,
          proofs,
          "Remaining restart backup publication temporary"
        ),
        readExactIntegrationFile(
          publicationPaths.cleanupClaim,
          MAX_BACKUP_BYTES,
          proofs,
          "Remaining restart backup publication cleanup claim"
        )
      ]);
      if (
        remainingPublicationTemporary.state !== "absent"
        || remainingPublicationCleanupClaim.state !== "absent"
      ) {
        throw recoveryError(
          "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
          "Readiness backup publication residue could not be reconciled exactly",
          []
        );
      }
    }
    if (backup.state === "absent" && backupCleanup.state === "absent") {
      await verifyCompletedTargetWithoutAuthority(
        latestPath,
        artifact.latest,
        artifact,
        "latest"
      );
      await verifyCompletedTargetWithoutAuthority(
        join(artifact.stateDirectory, PREVIOUS_REPORT),
        artifact.previous,
        artifact,
        "previous"
      );
      return;
    }
    if (backup.state === "file" && backupCleanup.state === "file") {
      throw new Error("Recovery backup and cleanup claim both exist");
    }
    const activeBackup = backup.state === "file" ? backup : backupCleanup;
    if (
      activeBackup.state !== "file"
      || activeBackup.fingerprint !== artifact.backup.fingerprint
      || activeBackup.mode !== 0o600
      || activeBackup.metadata.dev.toString() !== artifact.backup.identity.device
      || activeBackup.metadata.ino.toString() !== artifact.backup.identity.inode
    ) throw new Error("Recovery backup identity changed");
    const record = integrationReadinessBackupSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(activeBackup.bytes)
    ));
    if (
      record.transactionId !== artifact.transactionId
      || record.reportFingerprint !== artifact.reportFingerprint
      || JSON.stringify(record.trigger) !== JSON.stringify(artifact.trigger)
      || JSON.stringify(record.latest) !== JSON.stringify(artifact.latest.before)
      || JSON.stringify(record.previous) !== JSON.stringify(artifact.previous.before)
      || !(observedMatchesDesired(artifact.latest.observed, record.latest)
        || observedMatchesDesired(artifact.latest.observed, record.intended.latest))
      || !(observedMatchesDesired(artifact.previous.observed, record.previous)
        || observedMatchesDesired(artifact.previous.observed, record.intended.previous))
    ) throw new Error("Recovery artifact does not match its fixed backup");
    await restoreTarget(
      latestPath,
      artifact.latest,
      artifact,
      options,
      "latest",
      record.intended.latest
    );
    await restoreTarget(
      join(artifact.stateDirectory, PREVIOUS_REPORT),
      artifact.previous,
      artifact,
      options,
      "previous",
      record.intended.previous
    );
    await cleanupIntegrationReadinessBackupClaimed(artifact, options);
  } catch (error) {
    if (error instanceof IntegrationReadinessError) throw error;
    throw recoveryError(
      isIntegrationMutationUncertainty(error)
        ? "INTEGRATION_READINESS_UNCERTAIN"
        : "INTEGRATION_READINESS_RECOVERY_INCOMPLETE",
      "Readiness restart recovery could not be completed exactly",
      [error]
    );
  }
}

export async function restoreIntegrationReadinessFromArtifact(
  artifact: unknown,
  options: IntegrationFileMutationOptions
): Promise<void> {
  return withIntegrationFileMutationClaim(
    options.leaseContext,
    () => restoreIntegrationReadinessFromArtifactClaimed(artifact, options)
  );
}
