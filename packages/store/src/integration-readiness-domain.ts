import type { IntegrationFileMutationOptions } from "./integration-file-domain.js";
import type { IntegrationReadinessRecoveryBinding } from "./integration-readiness-recovery-binding.js";

export type IntegrationHarness = "codex" | "claude-code" | "github-copilot";

export interface IntegrationReadinessTrigger {
  planId: string;
  harness: IntegrationHarness;
  createdAt: string;
}

export interface IntegrationReadinessPublishOptions extends IntegrationFileMutationOptions {
  /** Must be the exact ID of the v2 integration record that will commit this readiness report. */
  transactionId: string;
  trigger: IntegrationReadinessTrigger;
  recovery?: {
    transactionId: string;
    beforePublish(binding: IntegrationReadinessRecoveryBinding): Promise<void>;
  };
}

export interface IntegrationReadinessRecoveryIdentity {
  device: string;
  inode: string;
}

export type IntegrationReadinessRecoveryFileState =
  | { state: "absent" }
  | {
      state: "file";
      bytesBase64: string;
      fingerprint: string;
      mode: number;
      identity: IntegrationReadinessRecoveryIdentity;
    };

export type IntegrationReadinessRecoveryDesiredState =
  | { state: "absent" }
  | {
      state: "file";
      bytesBase64: string;
      fingerprint: string;
      mode: number;
    };

export interface IntegrationReadinessRecoveryArtifact {
  schemaVersion: 1;
  transactionId: string;
  stateDirectory: string;
  stateDirectoryIdentity: IntegrationReadinessRecoveryIdentity;
  reportFingerprint: string;
  trigger: IntegrationReadinessTrigger;
  backup: {
    fingerprint: string;
    identity: IntegrationReadinessRecoveryIdentity;
  };
  latest: {
    before: IntegrationReadinessRecoveryDesiredState;
    observed: IntegrationReadinessRecoveryFileState;
  };
  previous: {
    before: IntegrationReadinessRecoveryDesiredState;
    observed: IntegrationReadinessRecoveryFileState;
  };
}

export type IntegrationReadinessErrorCode =
  | "INTEGRATION_READINESS_INVALID"
  | "INTEGRATION_READINESS_DRIFT"
  | "INTEGRATION_READINESS_FAILED"
  | "INTEGRATION_READINESS_UNCERTAIN"
  | "INTEGRATION_READINESS_RECOVERY_INCOMPLETE";

export class IntegrationReadinessError extends Error {
  readonly recoveryArtifact?: IntegrationReadinessRecoveryArtifact;
  readonly recoveryTransactionId?: string;

  constructor(
    public readonly code: IntegrationReadinessErrorCode,
    message: string,
    options?: ErrorOptions & {
      recoveryArtifact?: IntegrationReadinessRecoveryArtifact;
      recoveryTransactionId?: string;
    }
  ) {
    super(message, options);
    this.name = "IntegrationReadinessError";
    if (options?.recoveryArtifact) {
      Object.defineProperty(this, "recoveryArtifact", {
        value: options.recoveryArtifact,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }
    if (options?.recoveryTransactionId) this.recoveryTransactionId = options.recoveryTransactionId;
  }
}

export function invalidReadiness(message: string, cause?: unknown): IntegrationReadinessError {
  return new IntegrationReadinessError(
    "INTEGRATION_READINESS_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}
