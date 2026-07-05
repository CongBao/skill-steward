import {
  invalidFileTransaction,
  type IntegrationFileTransactionHandle,
  type IntegrationFileTransactionProof,
  type IntegrationFileTransactionReceipt
} from "./integration-file-domain.js";

interface IntegrationFileTransactionAuthority {
  proof: IntegrationFileTransactionProof;
  status: "published" | "restored" | "finalized";
}

const transactions = new WeakMap<IntegrationFileTransactionHandle, IntegrationFileTransactionAuthority>();

function requireAuthority(handle: unknown): IntegrationFileTransactionAuthority {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    throw invalidFileTransaction("An authentic integration file transaction handle is required");
  }
  const authority = transactions.get(handle as IntegrationFileTransactionHandle);
  if (!authority) {
    throw invalidFileTransaction("Integration file transaction handle is forged or expired");
  }
  return authority;
}

export function issueIntegrationFileTransactionHandle(
  state: IntegrationFileTransactionProof
): IntegrationFileTransactionHandle {
  const handle = Object.freeze(Object.create(null)) as IntegrationFileTransactionHandle;
  transactions.set(handle, { proof: state, status: "published" });
  return handle;
}

export function resolveIntegrationFileTransactionHandle(
  handle: unknown
): IntegrationFileTransactionProof {
  const authority = requireAuthority(handle);
  if (authority.status !== "published") {
    throw invalidFileTransaction(`Integration file transaction is already ${authority.status}`);
  }
  return authority.proof;
}

export function resolveIntegrationFileTransactionHandleForVerification(
  handle: unknown
): IntegrationFileTransactionProof {
  const authority = requireAuthority(handle);
  if (authority.status === "restored") {
    throw invalidFileTransaction("Integration file transaction is already restored");
  }
  return authority.proof;
}

export function integrationFileTransactionStatus(
  handle: unknown
): IntegrationFileTransactionAuthority["status"] {
  return requireAuthority(handle).status;
}

export function completeIntegrationFileTransaction(
  handle: unknown,
  status: "restored" | "finalized"
): void {
  const authority = requireAuthority(handle);
  if (authority.status !== "published") {
    throw invalidFileTransaction(`Integration file transaction is already ${authority.status}`);
  }
  authority.status = status;
}

export function integrationFileTransactionReceipt(
  handle: unknown
): IntegrationFileTransactionReceipt {
  const authority = requireAuthority(handle);
  const state = authority.proof;
  return Object.freeze({
    schemaVersion: 1 as const,
    transactionId: state.transactionId,
    status: authority.status,
    beforeFingerprint: state.before.state === "file" ? state.before.fingerprint : null,
    afterFingerprint: state.after.fingerprint,
    backupFingerprint: state.backup?.fingerprint ?? null
  });
}
