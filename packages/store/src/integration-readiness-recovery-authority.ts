import { resolve } from "node:path";
import type { IntegrationMutationLeaseContext } from "./integration-mutation-lease.js";
import type { IntegrationReadinessRecoveryBinding } from "./integration-readiness-recovery-binding.js";

declare const integrationReadinessRecoveryAuthorityBrand: unique symbol;

export interface IntegrationReadinessRecoveryAuthority {
  readonly [integrationReadinessRecoveryAuthorityBrand]: true;
}

export type IntegrationReadinessRecoveryOperation = "restore" | "finalize";

interface AuthorityState {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  transactionId: string;
  operation: IntegrationReadinessRecoveryOperation;
  execute: <T>(
    operation: (
      binding: IntegrationReadinessRecoveryBinding,
      assertCurrentLifecycleRecord: () => Promise<void>
    ) => Promise<T>
  ) => Promise<T>;
  consumed: boolean;
}

const authorities = new WeakMap<IntegrationReadinessRecoveryAuthority, AuthorityState>();

export function issueIntegrationReadinessRecoveryAuthority(
  input: Omit<AuthorityState, "consumed">
): IntegrationReadinessRecoveryAuthority {
  const authority = Object.freeze(Object.create(null)) as IntegrationReadinessRecoveryAuthority;
  authorities.set(authority, {
    ...input,
    stateDirectory: resolve(input.stateDirectory),
    consumed: false
  });
  return authority;
}

export async function useIntegrationReadinessRecoveryAuthority<T>(
  input: unknown,
  stateDirectory: string,
  operation: IntegrationReadinessRecoveryOperation,
  leaseContext: IntegrationMutationLeaseContext,
  execute: (
    binding: IntegrationReadinessRecoveryBinding,
    assertCurrentLifecycleRecord: () => Promise<void>
  ) => Promise<T>
): Promise<T> {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) {
    throw new Error("A Store-issued integration readiness recovery authority is required");
  }
  const state = authorities.get(input as IntegrationReadinessRecoveryAuthority);
  if (
    state === undefined
    || state.consumed
    || state.stateDirectory !== resolve(stateDirectory)
    || state.operation !== operation
    || state.leaseContext !== leaseContext
  ) {
    throw new Error("Integration readiness recovery authority is forged, stale, consumed, or mismatched");
  }
  state.consumed = true;
  return state.execute(execute);
}
