import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";
import { z } from "zod";
import {
  finalizeIntegrationFileTransactionClaimed,
  fingerprintIntegrationFileBytes,
  inspectIntegrationFileStateClaimed,
  publishIntegrationFileTransactionClaimed,
  restoreIntegrationFileTransactionClaimed,
  type IntegrationFileContentState,
  type IntegrationFileExpectedState,
  type IntegrationFileMutationOptions,
  type IntegrationFileTransactionHandle
} from "./integration-file-transaction.js";
import {
  assertIntegrationFileMutationBoundary,
  bindIntegrationDirectoryChain,
  collapseIntegrationHardLinkPairClaimed,
  integrationPhysicalIdentity,
  readExactIntegrationFile,
  readExactIntegrationRemovalAuthority,
  removeExactIntegrationFileClaimed,
  syncIntegrationParent
} from "./integration-file-proof.js";
import { assertIntegrationMutationLeaseOwned } from "./integration-mutation-lease.js";
import { MAX_REPORT_BYTES } from "./integration-readiness-recovery.js";
import { isIntegrationMutationUncertainty } from "./integration-uncertainty.js";

const HISTORY_DIRECTORY = "history";
const INDEX_FILE = "index.json";
const HISTORY_LIMIT = 50;
const MAX_HISTORY_INDEX_BYTES = 64 * 1024;
const MAX_HISTORY_DIRECTORY_ENTRIES = 256;
const CANONICAL_REPORT_NAME = /^([a-f0-9]{64})\.json$/;
const HISTORY_GC_CLAIM_NAME = /^\.history-gc\.([a-f0-9]{64})\.claim$/;
const INDEX_BACKUP_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.backup$/;
const INDEX_FINALIZE_CLAIM_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.finalize\.backup\.cleanup\.claim$/;
const INDEX_PUBLICATION_CLAIM_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.publication\.backup\.cleanup\.claim$/;
const INDEX_TEMPORARY_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.tmp$/;
const INDEX_TEMPORARY_CLAIM_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.publication\.temporary\.cleanup\.claim$/;
const INDEX_LEGACY_BACKUP_CLAIM_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.backup\.cleanup-[a-f0-9-]{36}\.claim$/;
const INDEX_LEGACY_TEMPORARY_CLAIM_NAME = /^index\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.tmp\.cleanup-[a-f0-9-]{36}\.claim$/;
const REPORT_TRANSACTION_RESIDUE_NAME = /^([a-f0-9]{64})\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.(tmp|backup|publication\.temporary\.cleanup\.claim|publication\.backup\.cleanup\.claim|finalize\.backup\.cleanup\.claim|restore\.backup\.cleanup\.claim|restore\.discard|restore\.discard\.cleanup\.claim|restore\.tmp|restore\.tmp\.cleanup\.claim)$/;
const REPORT_LEGACY_TRANSACTION_CLAIM_NAME = /^([a-f0-9]{64})\.json\.skill-steward\.([A-Za-z0-9][A-Za-z0-9-]{0,127})\.(tmp|backup)\.cleanup-[a-f0-9-]{36}\.claim$/;
const REPORT_TRANSACTION_RESIDUE_PREFIX = /^[a-f0-9]{64}\.json\.skill-steward\./;

type ReportTransactionResidueRole =
  | "publication-temporary"
  | "backup"
  | "restore-discard"
  | "restore-temporary";

function reportTransactionResidueRole(suffix: string): ReportTransactionResidueRole {
  if (suffix === "tmp" || suffix.includes("publication.temporary")) {
    return "publication-temporary";
  }
  if (suffix === "restore.discard" || suffix.includes("restore.discard.cleanup")) {
    return "restore-discard";
  }
  if (suffix === "restore.tmp" || suffix.includes("restore.tmp.cleanup")) {
    return "restore-temporary";
  }
  return "backup";
}

function reportTransactionSourceSuffix(role: ReportTransactionResidueRole): string {
  if (role === "publication-temporary") return "tmp";
  if (role === "restore-discard") return "restore.discard";
  if (role === "restore-temporary") return "restore.tmp";
  return "backup";
}

function reportTransactionClaimSuffix(role: ReportTransactionResidueRole): string {
  if (role === "publication-temporary") return "publication.temporary.cleanup.claim";
  if (role === "restore-discard") return "restore.discard.cleanup.claim";
  if (role === "restore-temporary") return "restore.tmp.cleanup.claim";
  return "finalize.backup.cleanup.claim";
}

const historyIndexItemSchema = z.object({
  portfolioFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  generatedAt: z.string().max(64).datetime(),
  fileName: z.string().regex(/^[a-f0-9]{64}\.json$/)
}).strict();
const historyIndexSchema = z.array(historyIndexItemSchema).max(HISTORY_LIMIT);
type HistoryIndex = z.infer<typeof historyIndexSchema>;

function serialize(value: unknown, maxBytes: number, label: string): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  return bytes;
}

function content(bytes: Uint8Array): IntegrationFileContentState {
  return {
    state: "file",
    bytes,
    fingerprint: fingerprintIntegrationFileBytes(bytes),
    mode: 0o600
  };
}

function decodeIndex(state: IntegrationFileExpectedState): HistoryIndex {
  if (state.state === "absent") return [];
  const source = new TextDecoder("utf-8", { fatal: true }).decode(state.bytes);
  const parsed = historyIndexSchema.parse(JSON.parse(source));
  const fingerprints = new Set<string>();
  const fileNames = new Set<string>();
  for (const item of parsed) {
    const canonicalFileName = `${item.portfolioFingerprint.slice("sha256:".length)}.json`;
    if (item.fileName !== canonicalFileName) {
      throw new Error("Integration history index file name is not canonical");
    }
    if (
      fingerprints.has(item.portfolioFingerprint)
      || fileNames.has(item.fileName)
    ) {
      throw new Error("Integration history index entries must be unique");
    }
    fingerprints.add(item.portfolioFingerprint);
    fileNames.add(item.fileName);
  }
  return parsed;
}

function decodeHistoryReport(
  bytes: Uint8Array,
  hash: string,
  indexed?: HistoryIndex[number]
): PortfolioReport {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const report = portfolioReportSchema.parse(JSON.parse(source));
  if (
    report.portfolioFingerprint !== `sha256:${hash}`
    || indexed !== undefined && (
      indexed.fileName !== `${hash}.json`
      || indexed.generatedAt !== report.generatedAt
    )
  ) throw new Error("Integration history report does not match canonical index metadata");
  return report;
}

function decodeHistoryReportResidue(
  state: IntegrationFileExpectedState,
  hash: string
): PortfolioReport | undefined {
  if (state.state === "absent") return undefined;
  if (state.mode !== 0o600) {
    throw new Error("Integration history report residue must use private file mode");
  }
  return decodeHistoryReport(state.bytes, hash);
}

async function listHistoryEntriesBounded(
  stateDirectory: string,
  historyDirectory: string,
  options: IntegrationFileMutationOptions
): Promise<string[]> {
  const proofs = await bindIntegrationDirectoryChain(
    stateDirectory,
    join(historyDirectory, INDEX_FILE)
  );
  await assertIntegrationFileMutationBoundary(options, proofs);
  const directory = await opendir(historyDirectory);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length > MAX_HISTORY_DIRECTORY_ENTRIES) {
        throw new Error("Integration history directory entry limit exceeded");
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ERR_DIR_CLOSED")) {
        throw error;
      }
    });
  }
  await assertIntegrationFileMutationBoundary(options, proofs);
  return entries;
}

async function reconcileHistoryGarbage(
  stateDirectory: string,
  historyDirectory: string,
  retained: HistoryIndex,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const entries = await listHistoryEntriesBounded(stateDirectory, historyDirectory, options);
  const retainedHashes = new Set(retained.map((item) =>
    item.portfolioFingerprint.slice("sha256:".length)));
  const candidates = new Set<string>();
  const indexResidues = new Map<string, {
    transactionId: string;
    role: "backup" | "temporary";
    sourceName: string;
    claims: string[];
  }>();
  const reportResidues = new Map<string, {
    hash: string;
    transactionId: string;
    role: ReportTransactionResidueRole;
    sourceName: string;
    claims: string[];
  }>();
  for (const name of entries) {
    if (name === INDEX_FILE) continue;
    const indexBackup = INDEX_BACKUP_NAME.exec(name);
    const indexFinalizeClaim = INDEX_FINALIZE_CLAIM_NAME.exec(name);
    const indexPublicationClaim = INDEX_PUBLICATION_CLAIM_NAME.exec(name);
    const indexTemporary = INDEX_TEMPORARY_NAME.exec(name);
    const indexTemporaryClaim = INDEX_TEMPORARY_CLAIM_NAME.exec(name);
    const legacyBackupClaim = INDEX_LEGACY_BACKUP_CLAIM_NAME.exec(name);
    const legacyTemporaryClaim = INDEX_LEGACY_TEMPORARY_CLAIM_NAME.exec(name);
    const matched = indexBackup
      ?? indexFinalizeClaim
      ?? indexPublicationClaim
      ?? indexTemporary
      ?? indexTemporaryClaim
      ?? legacyBackupClaim
      ?? legacyTemporaryClaim;
    if (matched) {
      const transactionId = matched[1]!;
      const role = indexTemporary || indexTemporaryClaim || legacyTemporaryClaim
        ? "temporary"
        : "backup";
      const key = `${transactionId}:${role}`;
      const residue = indexResidues.get(key) ?? {
        transactionId,
        role,
        sourceName: role === "backup"
          ? `${INDEX_FILE}.skill-steward.${transactionId}.backup`
          : `${INDEX_FILE}.skill-steward.${transactionId}.tmp`,
        claims: []
      };
      if (!indexBackup && !indexTemporary) residue.claims.push(name);
      indexResidues.set(key, residue);
      continue;
    }
    if (name.startsWith(`${INDEX_FILE}.skill-steward.`)) {
      throw new Error("Integration history contains an unknown index transaction residue");
    }
    const reportResidue = REPORT_TRANSACTION_RESIDUE_NAME.exec(name);
    const legacyReportClaim = REPORT_LEGACY_TRANSACTION_CLAIM_NAME.exec(name);
    const matchedReportResidue = reportResidue ?? legacyReportClaim;
    if (matchedReportResidue) {
      const hash = matchedReportResidue[1]!;
      const transactionId = matchedReportResidue[2]!;
      const suffix = matchedReportResidue[3]!;
      const role = reportTransactionResidueRole(suffix);
      const key = `${hash}:${transactionId}:${role}`;
      const residue = reportResidues.get(key) ?? {
        hash,
        transactionId,
        role,
        sourceName: `${hash}.json.skill-steward.${transactionId}.${reportTransactionSourceSuffix(role)}`,
        claims: []
      };
      const source = reportResidue !== null
        && (suffix === "tmp"
          || suffix === "backup"
          || suffix === "restore.discard"
          || suffix === "restore.tmp");
      if (!source) residue.claims.push(name);
      reportResidues.set(key, residue);
      continue;
    }
    if (REPORT_TRANSACTION_RESIDUE_PREFIX.test(name)) {
      throw new Error("Integration history contains an unknown report transaction residue");
    }
    const reportMatch = CANONICAL_REPORT_NAME.exec(name);
    const claimMatch = HISTORY_GC_CLAIM_NAME.exec(name);
    if (reportMatch || claimMatch) {
      const hash = (reportMatch ?? claimMatch)![1]!;
      if (!retainedHashes.has(hash)) candidates.add(hash);
      continue;
    }
    if (name.endsWith(".json")) {
      throw new Error("Integration history contains an unknown JSON artifact");
    }
  }
  const proofs = await bindIntegrationDirectoryChain(
    stateDirectory,
    join(historyDirectory, INDEX_FILE)
  );
  for (const [, residue] of [...indexResidues].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (residue.claims.length > 1) {
      throw new Error("Integration history index cleanup claims conflict");
    }
    const backupPath = join(
      historyDirectory,
      residue.sourceName
    );
    const claimPath = residue.claims.length === 1
      ? join(historyDirectory, residue.claims[0]!)
      : join(
          historyDirectory,
          residue.role === "backup"
            ? `${INDEX_FILE}.skill-steward.${residue.transactionId}.finalize.backup.cleanup.claim`
            : `${INDEX_FILE}.skill-steward.${residue.transactionId}.publication.temporary.cleanup.claim`
        );
    const authority = await readExactIntegrationRemovalAuthority(
      backupPath,
      claimPath,
      MAX_HISTORY_INDEX_BYTES,
      proofs,
      "Integration history index residue"
    );
    if (authority.state === "absent") continue;
    decodeIndex(authority);
    await removeExactIntegrationFileClaimed({
      sourcePath: backupPath,
      claimPath,
      source: authority,
      maxBytes: MAX_HISTORY_INDEX_BYTES,
      proofs,
      options,
      label: "Integration history index residue"
    });
  }
  for (const [, residue] of [...reportResidues].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (residue.claims.length > 1) {
      throw new Error("Integration history report cleanup claims conflict");
    }
    const canonicalPath = join(historyDirectory, `${residue.hash}.json`);
    const sourcePath = join(historyDirectory, residue.sourceName);
    if (
      residue.claims.length === 0
      && (residue.role === "restore-discard" || residue.role === "restore-temporary")
    ) {
      const pairAuthority = await readExactIntegrationRemovalAuthority(
        canonicalPath,
        sourcePath,
        MAX_REPORT_BYTES,
        proofs,
        "Integration history report recovery pair"
      );
      if (pairAuthority.state === "file") {
        decodeHistoryReportResidue(pairAuthority, residue.hash);
        const collapsed = await collapseIntegrationHardLinkPairClaimed(
          canonicalPath,
          sourcePath,
          proofs,
          options,
          "Integration history report recovery pair",
          {
            fingerprint: pairAuthority.fingerprint,
            bytes: pairAuthority.bytes,
            mode: pairAuthority.mode,
            maxBytes: MAX_REPORT_BYTES,
            identity: integrationPhysicalIdentity(pairAuthority.metadata)
          }
        );
        if (collapsed) continue;
      }
    }
    const claimPath = residue.claims.length === 1
      ? join(historyDirectory, residue.claims[0]!)
      : join(
          historyDirectory,
          `${residue.hash}.json.skill-steward.${residue.transactionId}.${reportTransactionClaimSuffix(residue.role)}`
        );
    const authority = await readExactIntegrationRemovalAuthority(
      sourcePath,
      claimPath,
      MAX_REPORT_BYTES,
      proofs,
      "Integration history report transaction residue"
    );
    if (authority.state === "absent") continue;
    decodeHistoryReportResidue(authority, residue.hash);
    await removeExactIntegrationFileClaimed({
      sourcePath,
      claimPath,
      source: authority,
      maxBytes: MAX_REPORT_BYTES,
      proofs,
      options,
      label: "Integration history report transaction residue"
    });
  }
  for (const hash of [...candidates].sort()) {
    const sourcePath = join(historyDirectory, `${hash}.json`);
    const claimPath = join(historyDirectory, `.history-gc.${hash}.claim`);
    const authority = await readExactIntegrationRemovalAuthority(
      sourcePath,
      claimPath,
      MAX_REPORT_BYTES,
      proofs,
      "Integration history GC"
    );
    if (authority.state !== "file") continue;
    decodeHistoryReport(authority.bytes, hash);
    await removeExactIntegrationFileClaimed({
      sourcePath,
      claimPath,
      source: authority,
      maxBytes: MAX_REPORT_BYTES,
      proofs,
      options,
      label: "Integration history GC"
    });
  }
  await syncIntegrationParent(proofs, options);
}

async function ensureHistoryDirectory(
  stateDirectory: string,
  options: IntegrationFileMutationOptions
): Promise<string> {
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  const stateProofs = await bindIntegrationDirectoryChain(
    stateDirectory,
    join(stateDirectory, ".history-boundary")
  );
  await assertIntegrationFileMutationBoundary(options, stateProofs);
  const historyDirectory = join(stateDirectory, HISTORY_DIRECTORY);
  let created = false;
  try {
    await mkdir(historyDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertIntegrationFileMutationBoundary(options, stateProofs);
  const metadata = await lstat(historyDirectory, { bigint: true });
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || Number(metadata.mode & 0o777n) !== 0o700
  ) throw new Error("Integration history must be a private physical directory");
  const physical = await realpath(historyDirectory);
  if (dirname(physical) !== stateProofs[0]!.physicalPath) {
    throw new Error("Integration history escaped the state directory");
  }
  await bindIntegrationDirectoryChain(
    stateDirectory,
    join(historyDirectory, INDEX_FILE)
  );
  if (created) await syncIntegrationParent(stateProofs, options);
  return historyDirectory;
}

/** Integration-only history append. Ordinary manifest history remains unchanged. */
export async function appendIntegrationReportHistoryClaimed(
  stateDirectoryInput: string,
  input: PortfolioReport,
  options: IntegrationFileMutationOptions
): Promise<void> {
  const stateDirectory = resolve(stateDirectoryInput);
  if (resolve(options.stateDirectory) !== stateDirectory) {
    throw new Error("Integration history belongs to another state directory");
  }
  const report = portfolioReportSchema.parse(input);
  const historyDirectory = await ensureHistoryDirectory(stateDirectory, options);
  const indexPath = join(historyDirectory, INDEX_FILE);
  const fileName = `${report.portfolioFingerprint.slice("sha256:".length)}.json`;
  const reportPath = join(historyDirectory, fileName);
  const indexBefore = await inspectIntegrationFileStateClaimed(
    indexPath,
    stateDirectory,
    options,
    MAX_HISTORY_INDEX_BYTES
  );
  const current = decodeIndex(indexBefore);
  await reconcileHistoryGarbage(stateDirectory, historyDirectory, current, options);
  const reportBefore = await inspectIntegrationFileStateClaimed(
    reportPath,
    stateDirectory,
    options,
    MAX_REPORT_BYTES
  );
  const indexedEntry = current.find(
    (item) => item.portfolioFingerprint === report.portfolioFingerprint
  );
  const indexed = indexedEntry !== undefined;
  let indexedReportMatches = false;
  if (indexedEntry !== undefined && reportBefore.state === "file") {
    const existing = decodeHistoryReport(
      reportBefore.bytes,
      report.portfolioFingerprint.slice("sha256:".length)
    );
    if (existing.generatedAt === indexedEntry.generatedAt) return;
    const incomingBytes = serialize(report, MAX_REPORT_BYTES, "Incoming integration history report");
    if (!Buffer.from(reportBefore.bytes).equals(Buffer.from(incomingBytes))) {
      throw new Error("Integration history report does not match pending index metadata");
    }
    indexedReportMatches = true;
  }
  const reportBytes = serialize(
    report,
    MAX_REPORT_BYTES,
    "Integration history report"
  );
  const reportAfter = content(reportBytes);
  const reportIsExact = indexedReportMatches || reportBefore.state === "file" && (
    reportBefore.fingerprint === reportAfter.fingerprint
    && Buffer.from(reportBefore.bytes).equals(Buffer.from(reportAfter.bytes))
  );
  if (reportBefore.state === "file" && !reportIsExact) {
    throw new Error("Integration history report path contains different bytes");
  }
  let reportTransaction: IntegrationFileTransactionHandle | undefined;
  if (!reportIsExact) {
    reportTransaction = await publishIntegrationFileTransactionClaimed({
      targetPath: reportPath,
      allowedBoundaryPath: stateDirectory,
      expectedBefore: reportBefore,
      after: reportAfter,
      maxBytes: MAX_REPORT_BYTES
    }, options);
  }
  const indexEntryNeedsUpdate = indexedEntry !== undefined
    && indexedEntry.generatedAt !== report.generatedAt;
  if (indexed && !indexEntryNeedsUpdate) {
    if (reportTransaction) {
      await finalizeIntegrationFileTransactionClaimed(reportTransaction, options);
    }
    const repaired = await inspectIntegrationFileStateClaimed(
      reportPath,
      stateDirectory,
      options,
      MAX_REPORT_BYTES
    );
    if (repaired.state !== "file") {
      throw new Error("Indexed integration history repair is not visible");
    }
    decodeHistoryReport(
      repaired.bytes,
      report.portfolioFingerprint.slice("sha256:".length),
      indexedEntry
    );
    await reconcileHistoryGarbage(stateDirectory, historyDirectory, current, options);
    return;
  }

  const next = historyIndexSchema.parse(indexedEntry === undefined
    ? [{
        portfolioFingerprint: report.portfolioFingerprint,
        generatedAt: report.generatedAt,
        fileName
      }, ...current].slice(0, HISTORY_LIMIT)
    : current.map((item) => item.portfolioFingerprint === report.portfolioFingerprint
      ? {
          portfolioFingerprint: report.portfolioFingerprint,
          generatedAt: report.generatedAt,
          fileName
        }
      : item));
  const indexAfter = content(serialize(
    next,
    MAX_HISTORY_INDEX_BYTES,
    "Integration history index"
  ));
  let indexTransaction: IntegrationFileTransactionHandle;
  try {
    indexTransaction = await publishIntegrationFileTransactionClaimed({
      targetPath: indexPath,
      allowedBoundaryPath: stateDirectory,
      expectedBefore: indexBefore,
      after: indexAfter,
      maxBytes: MAX_HISTORY_INDEX_BYTES
    }, options);
  } catch (error) {
    if (!reportTransaction) throw error;
    if (isIntegrationMutationUncertainty(error)) throw error;
    try {
      await restoreIntegrationFileTransactionClaimed(reportTransaction, options);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Integration history index failed and report compensation is incomplete"
      );
    }
    throw error;
  }

  const cleanupErrors: unknown[] = [];
  if (reportTransaction) {
    try {
      await finalizeIntegrationFileTransactionClaimed(reportTransaction, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await finalizeIntegrationFileTransactionClaimed(indexTransaction, options);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, "Integration history cleanup is incomplete");
  }
  const committedReport = await inspectIntegrationFileStateClaimed(
    reportPath,
    stateDirectory,
    options,
    MAX_REPORT_BYTES
  );
  if (committedReport.state !== "file") {
    throw new Error("Committed integration history report is not visible");
  }
  decodeHistoryReport(
    committedReport.bytes,
    report.portfolioFingerprint.slice("sha256:".length),
    next.find((item) => item.portfolioFingerprint === report.portfolioFingerprint)
  );
  await reconcileHistoryGarbage(stateDirectory, historyDirectory, next, options);
}
