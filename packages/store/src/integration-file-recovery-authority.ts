import { resolve } from "node:path";
import type { IntegrationMutationLeaseContext } from "./integration-mutation-lease.js";
import type { IntegrationFileRecoveryArtifact } from "./integration-file-recovery-artifact.js";

declare const integrationFileRecoveryAuthorityBrand: unique symbol;

export interface IntegrationFileRecoveryAuthority {
  readonly [integrationFileRecoveryAuthorityBrand]: true;
}

export type IntegrationFileRecoveryOperation = "restore" | "finalize";

interface AuthorityState {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  transactionId: string;
  operation: IntegrationFileRecoveryOperation;
  execute: <T>(
    operation: (
      artifact: IntegrationFileRecoveryArtifact,
      assertCurrentLifecycleRecord: () => Promise<void>
    ) => Promise<T>
  ) => Promise<T>;
  consumed: boolean;
}

const authorities = new WeakMap<IntegrationFileRecoveryAuthority, AuthorityState>();

export function issueIntegrationFileRecoveryAuthority(input: Omit<AuthorityState, "consumed">) {
  const authority = Object.freeze(Object.create(null)) as IntegrationFileRecoveryAuthority;
  authorities.set(authority, {
    ...input,
    stateDirectory: resolve(input.stateDirectory),
    consumed: false
  });
  return authority;
}

export async function useIntegrationFileRecoveryAuthority<T>(
  input: unknown,
  stateDirectory: string,
  operation: IntegrationFileRecoveryOperation,
  leaseContext: IntegrationMutationLeaseContext,
  execute: (
    artifact: IntegrationFileRecoveryArtifact,
    assertCurrentLifecycleRecord: () => Promise<void>
  ) => Promise<T>
): Promise<T> {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) {
    throw new Error("A Store-issued integration file recovery authority is required");
  }
  const state = authorities.get(input as IntegrationFileRecoveryAuthority);
  if (
    state === undefined
    || state.consumed
    || state.stateDirectory !== resolve(stateDirectory)
    || state.operation !== operation
    || state.leaseContext !== leaseContext
  ) {
    throw new Error("Integration file recovery authority is forged, stale, consumed, or mismatched");
  }
  state.consumed = true;
  return state.execute(execute);
}
