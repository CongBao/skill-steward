import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { IntegrationMutationLeaseContext } from "./integration-mutation-lease.js";
import type { IntegrationFileRecoveryArtifact } from "./integration-file-recovery-artifact.js";

export const DEFAULT_INTEGRATION_FILE_MAX_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;

export type IntegrationFileTransactionErrorCode =
  | "INTEGRATION_CONFIGURATION_INVALID"
  | "INTEGRATION_CONFIGURATION_DRIFT"
  | "INTEGRATION_CONFIGURATION_FAILED"
  | "INTEGRATION_CONFIGURATION_UNCERTAIN"
  | "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
  | "INTEGRATION_CONFIGURATION_CLEANUP_PENDING";

export class IntegrationFileTransactionError extends Error {
  readonly recoveryArtifact?: IntegrationFileRecoveryArtifact;

  constructor(
    public readonly code: IntegrationFileTransactionErrorCode,
    message: string,
    options?: ErrorOptions & { recoveryArtifact?: IntegrationFileRecoveryArtifact }
  ) {
    super(message, options);
    this.name = "IntegrationFileTransactionError";
    if (options?.recoveryArtifact) {
      Object.defineProperty(this, "recoveryArtifact", {
        value: options.recoveryArtifact,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }
  }
}

export interface IntegrationFileAbsentState {
  state: "absent";
}

export interface IntegrationFileContentState {
  state: "file";
  bytes: Uint8Array;
  fingerprint: string;
  mode: number;
}

export type IntegrationFileExpectedState =
  | IntegrationFileAbsentState
  | IntegrationFileContentState;

export interface IntegrationFileTransactionInput {
  targetPath: string;
  allowedBoundaryPath: string;
  expectedBefore: IntegrationFileExpectedState;
  after: IntegrationFileContentState;
  maxBytes?: number;
  recovery?: {
    transactionId: string;
    beforePublish(artifact: IntegrationFileRecoveryArtifact): Promise<void>;
  };
}

export interface IntegrationFileMutationOptions {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
}

export interface IntegrationPhysicalIdentity {
  device: bigint;
  inode: bigint;
}

export interface IntegrationOwnedFileProof {
  path: string;
  identity: IntegrationPhysicalIdentity;
  fingerprint: string;
  bytes: number;
  mode: number;
}

export interface IntegrationDirectoryProof {
  path: string;
  physicalPath: string;
  identity: IntegrationPhysicalIdentity;
}

declare const integrationFileTransactionHandleBrand: unique symbol;

export interface IntegrationFileTransactionHandle {
  readonly [integrationFileTransactionHandleBrand]: true;
}

export interface IntegrationFileTransactionReceipt {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly status: "published" | "restored" | "finalized";
  readonly beforeFingerprint: string | null;
  readonly afterFingerprint: string;
  readonly backupFingerprint: string | null;
}

/** Internal authority state. Never export this type from the package root. */
export interface IntegrationFileTransactionProof {
  schemaVersion: 1;
  transactionId: string;
  outcome: "published";
  stateDirectory: string;
  targetPath: string;
  allowedBoundaryPath: string;
  before: IntegrationFileExpectedState;
  after: IntegrationFileContentState;
  targetIdentity: IntegrationPhysicalIdentity;
  parent: {
    path: string;
    physicalPath: string;
    identity: IntegrationPhysicalIdentity;
  };
  backup?: IntegrationOwnedFileProof;
  maxBytes: number;
  /** Same-process proof. Persist only the sanitized artifact fields above. */
  readonly directoryProofs: readonly IntegrationDirectoryProof[];
}

const mutationTails = new WeakMap<IntegrationMutationLeaseContext, Promise<void>>();

export async function withIntegrationFileMutationClaim<T>(
  leaseContext: IntegrationMutationLeaseContext,
  operation: () => Promise<T>
): Promise<T> {
  const predecessor = mutationTails.get(leaseContext) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = predecessor.then(() => gate);
  mutationTails.set(leaseContext, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(leaseContext) === tail) mutationTails.delete(leaseContext);
  }
}

export function fingerprintIntegrationFileBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function invalidFileTransaction(
  message: string,
  cause?: unknown
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}

export function driftedFileTransaction(
  message: string,
  cause?: unknown
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_DRIFT",
    message,
    cause === undefined ? undefined : { cause }
  );
}

export function failedFileTransaction(
  message: string,
  cause?: unknown
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_FAILED",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function aggregateCause(message: string, causes: unknown[]): ErrorOptions {
  return {
    cause: causes.length === 1
      ? causes[0]
      : new AggregateError(causes, message)
  };
}

export function uncertainFileTransaction(
  message: string,
  causes: unknown[]
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_UNCERTAIN",
    message,
    aggregateCause(message, causes)
  );
}

export function incompleteFileRecovery(
  message: string,
  causes: unknown[]
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE",
    message,
    aggregateCause(message, causes)
  );
}

export function pendingFileCleanup(
  message: string,
  causes: unknown[],
  recoveryArtifact?: IntegrationFileRecoveryArtifact
): IntegrationFileTransactionError {
  return new IntegrationFileTransactionError(
    "INTEGRATION_CONFIGURATION_CLEANUP_PENDING",
    message,
    {
      ...aggregateCause(message, causes),
      ...(recoveryArtifact ? { recoveryArtifact } : {})
    }
  );
}

export function normalizeIntegrationPath(path: string, label: string): string {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || path.includes("\0")
    || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) {
    throw invalidFileTransaction(`${label} must be a bounded absolute path`);
  }
  const normalized = resolve(path);
  if (normalized !== path) throw invalidFileTransaction(`${label} must be normalized`);
  return normalized;
}

export function normalizeIntegrationMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_INTEGRATION_FILE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 24 * 1024 * 1024) {
    throw invalidFileTransaction("Integration file byte limit is invalid");
  }
  return maxBytes;
}

function normalizeMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw invalidFileTransaction("Integration file mode must contain only permission bits");
  }
  return mode;
}

export function normalizeIntegrationExpectedState(
  value: IntegrationFileExpectedState,
  maxBytes: number,
  label: string
): IntegrationFileExpectedState {
  if (value?.state === "absent") return Object.freeze({ state: "absent" });
  if (value?.state !== "file" || !(value.bytes instanceof Uint8Array)) {
    throw invalidFileTransaction(`${label} must be absent or an exact file`);
  }
  if (value.bytes.byteLength > maxBytes) {
    throw invalidFileTransaction(`${label} exceeds the byte limit`);
  }
  const bytes = Uint8Array.from(value.bytes);
  const fingerprint = fingerprintIntegrationFileBytes(bytes);
  if (!fingerprintPattern.test(value.fingerprint) || fingerprint !== value.fingerprint) {
    throw invalidFileTransaction(`${label} fingerprint does not match its bytes`);
  }
  return Object.freeze({
    state: "file" as const,
    bytes,
    fingerprint,
    mode: normalizeMode(value.mode)
  });
}

export function cloneIntegrationFileState(
  state: IntegrationFileExpectedState
): IntegrationFileExpectedState {
  return state.state === "absent"
    ? { state: "absent" }
    : { ...state, bytes: Uint8Array.from(state.bytes) };
}
