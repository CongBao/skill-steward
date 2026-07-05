import { resolve } from "node:path";
import type { IntegrationMutationLeaseContext } from "./integration-mutation-lease.js";
import type { IntegrationRecoveryArtifactProof } from "./integration-recovery-domain.js";

declare const integrationRecoveryArtifactAuthorityBrand: unique symbol;

export interface IntegrationRecoveryArtifactAuthority {
  readonly [integrationRecoveryArtifactAuthorityBrand]: true;
}

interface RecoveryArtifactAuthorityState {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  transactionId: string;
  role: IntegrationRecoveryArtifactProof["role"];
  proof: IntegrationRecoveryArtifactProof;
  consumed: boolean;
}

const authorities = new WeakMap<
  IntegrationRecoveryArtifactAuthority,
  RecoveryArtifactAuthorityState
>();

export function issueIntegrationRecoveryArtifactAuthority(input: {
  stateDirectory: string;
  leaseContext: IntegrationMutationLeaseContext;
  transactionId: string;
  role: IntegrationRecoveryArtifactProof["role"];
  proof: IntegrationRecoveryArtifactProof;
}): IntegrationRecoveryArtifactAuthority {
  const authority = Object.freeze(Object.create(null)) as IntegrationRecoveryArtifactAuthority;
  authorities.set(authority, {
    ...input,
    stateDirectory: resolve(input.stateDirectory),
    consumed: false
  });
  return authority;
}

export function consumeIntegrationRecoveryArtifactAuthority(
  authority: unknown,
  stateDirectory: string,
  transactionId: string,
  role: IntegrationRecoveryArtifactProof["role"],
  leaseContext: IntegrationMutationLeaseContext
): IntegrationRecoveryArtifactProof {
  if ((typeof authority !== "object" && typeof authority !== "function") || authority === null) {
    throw new Error("A Store-issued integration recovery artifact authority is required");
  }
  const state = authorities.get(authority as IntegrationRecoveryArtifactAuthority);
  if (
    state === undefined
    || state.consumed
    || state.stateDirectory !== resolve(stateDirectory)
    || state.transactionId !== transactionId
    || state.role !== role
    || state.leaseContext !== leaseContext
  ) {
    throw new Error("Integration recovery artifact authority is invalid, stale, or mismatched");
  }
  state.consumed = true;
  return state.proof;
}
