import { resolve } from "node:path";
import type { IntegrationRecord } from "./integration-store.js";

declare const integrationRecordCommitReceiptBrand: unique symbol;

/**
 * Opaque same-process evidence that one exact integration record completed its
 * durable publication and post-publication verification.
 */
export interface IntegrationRecordCommitReceipt {
  readonly [integrationRecordCommitReceiptBrand]: true;
}

export interface IntegrationRecordCommitState {
  stateDirectory: string;
  record: IntegrationRecord;
  readinessOwner?: object;
}

const commits = new WeakMap<IntegrationRecordCommitReceipt, IntegrationRecordCommitState>();

export function issueIntegrationRecordCommitReceipt(
  stateDirectory: string,
  record: IntegrationRecord
): IntegrationRecordCommitReceipt {
  const receipt = Object.freeze(Object.create(null)) as IntegrationRecordCommitReceipt;
  commits.set(receipt, {
    stateDirectory: resolve(stateDirectory),
    record: structuredClone(record)
  });
  return receipt;
}

/** Internal authority lookup. This function is intentionally not exported by the package root. */
export function resolveIntegrationRecordCommitReceipt(
  receipt: unknown
): IntegrationRecordCommitState | undefined {
  if ((typeof receipt !== "object" && typeof receipt !== "function") || receipt === null) {
    return undefined;
  }
  return commits.get(receipt as IntegrationRecordCommitReceipt);
}

/** Claims one exact receipt for one exact same-process readiness authority. */
export function claimIntegrationRecordCommitReceipt(
  receipt: unknown,
  owner: object
): IntegrationRecordCommitState | undefined {
  const state = resolveIntegrationRecordCommitReceipt(receipt);
  if (!state) return undefined;
  if (state.readinessOwner !== undefined && state.readinessOwner !== owner) return undefined;
  state.readinessOwner = owner;
  return state;
}
