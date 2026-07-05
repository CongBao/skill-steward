import type { PortfolioReport } from "@skill-steward/engine";
import { type IntegrationFileTransactionHandle } from "./integration-file-domain.js";
import {
  invalidReadiness,
  type IntegrationReadinessRecoveryArtifact,
  type IntegrationReadinessTrigger
} from "./integration-readiness-domain.js";

declare const integrationReadinessTransactionHandleBrand: unique symbol;

export interface IntegrationReadinessTransactionHandle {
  readonly [integrationReadinessTransactionHandleBrand]: true;
}

export interface IntegrationReadinessTransactionReceipt {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly status: "published" | "committed" | "restored" | "finalized";
  readonly reportFingerprint: string;
  readonly backupFingerprint: string;
  readonly previousPublished: boolean;
}

export interface IntegrationReadinessTransactionState {
  schemaVersion: 1;
  transactionId: string;
  stateDirectory: string;
  report: PortfolioReport;
  trigger: IntegrationReadinessTrigger;
  recoveryArtifact: IntegrationReadinessRecoveryArtifact;
  backup: {
    path: string;
    fingerprint: string;
    transaction: IntegrationFileTransactionHandle;
  };
  latest: IntegrationFileTransactionHandle;
  previous?: IntegrationFileTransactionHandle;
}

interface IntegrationReadinessTransactionAuthority {
  proof: IntegrationReadinessTransactionState;
  status: "published" | "committed" | "restored" | "finalized";
  commitReceipt?: object;
  finalResult?: unknown;
}

const transactions = new WeakMap<
  IntegrationReadinessTransactionHandle,
  IntegrationReadinessTransactionAuthority
>();

function requireAuthority(handle: unknown): IntegrationReadinessTransactionAuthority {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    throw invalidReadiness("An authentic integration readiness transaction handle is required");
  }
  const authority = transactions.get(handle as IntegrationReadinessTransactionHandle);
  if (!authority) {
    throw invalidReadiness("Integration readiness transaction handle is forged or expired");
  }
  return authority;
}

export function issueIntegrationReadinessTransactionHandle(
  state: IntegrationReadinessTransactionState
): IntegrationReadinessTransactionHandle {
  const handle = Object.freeze(Object.create(null)) as IntegrationReadinessTransactionHandle;
  transactions.set(handle, { proof: state, status: "published" });
  return handle;
}

export function resolveIntegrationReadinessTransactionHandle(
  handle: unknown
): IntegrationReadinessTransactionState {
  const authority = requireAuthority(handle);
  if (authority.status !== "published" && authority.status !== "committed") {
    throw invalidReadiness(`Integration readiness transaction is already ${authority.status}`);
  }
  return authority.proof;
}

export function resolvePublishedIntegrationReadinessTransactionHandle(
  handle: unknown
): IntegrationReadinessTransactionState {
  const authority = requireAuthority(handle);
  if (authority.status !== "published") {
    throw invalidReadiness(`Integration readiness transaction is already ${authority.status}`);
  }
  return authority.proof;
}

export function inspectIntegrationReadinessTransaction(
  handle: unknown
): Readonly<IntegrationReadinessTransactionAuthority> {
  return requireAuthority(handle);
}

export function assertIntegrationReadinessCommitPair(
  handle: unknown,
  receipt: object
): void {
  const authority = requireAuthority(handle);
  if (authority.status === "restored") {
    throw invalidReadiness("Integration readiness transaction is already restored");
  }
  if (authority.commitReceipt !== undefined && authority.commitReceipt !== receipt) {
    throw invalidReadiness("Integration readiness transaction is paired with another commit receipt");
  }
}

export function commitIntegrationReadinessTransaction(
  handle: unknown,
  receipt: object
): Readonly<IntegrationReadinessTransactionAuthority> {
  const authority = requireAuthority(handle);
  assertIntegrationReadinessCommitPair(handle, receipt);
  if (authority.status === "published") {
    authority.commitReceipt = receipt;
    authority.status = "committed";
  }
  return authority;
}

export function finalizeIntegrationReadinessTransaction(
  handle: unknown,
  result: unknown
): void {
  const authority = requireAuthority(handle);
  if (authority.status !== "committed") {
    throw invalidReadiness(`Integration readiness transaction is already ${authority.status}`);
  }
  authority.finalResult = result;
  authority.status = "finalized";
}

export function completeIntegrationReadinessTransaction(
  handle: unknown,
  status: "restored"
): void {
  const authority = requireAuthority(handle);
  if (authority.status !== "published") {
    throw invalidReadiness(`Integration readiness transaction is already ${authority.status}`);
  }
  authority.status = status;
}

export function integrationReadinessTransactionReceipt(
  handle: unknown
): IntegrationReadinessTransactionReceipt {
  const authority = requireAuthority(handle);
  const state = authority.proof;
  return Object.freeze({
    schemaVersion: 1 as const,
    transactionId: state.transactionId,
    status: authority.status,
    reportFingerprint: state.report.portfolioFingerprint,
    backupFingerprint: state.backup.fingerprint,
    previousPublished: state.previous !== undefined
  });
}
