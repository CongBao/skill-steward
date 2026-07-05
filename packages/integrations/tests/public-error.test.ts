import { describe, expect, it } from "vitest";
import { CompanionTransactionError } from "../src/companion-transaction.js";
import { IntegrationError } from "../src/config.js";
import {
  IntegrationTransactionError,
  serializePublicIntegrationError
} from "../src/integration-lifecycle.js";

describe("public integration error serialization", () => {
  it("normalizes code-shaped system errors without exposing private details", () => {
    const error = Object.assign(
      new Error("EACCES: lstat '/Users/private/.codex/hooks.json' server-canary"),
      {
        code: "EACCES",
        path: "/Users/private/.codex/hooks.json",
        syscall: "lstat",
        stack: "server-canary-stack"
      }
    );

    const result = serializePublicIntegrationError(error);

    expect(result).toEqual({
      code: "INTEGRATION_OPERATION_FAILED",
      message: "Integration operation could not be completed safely.",
      httpStatus: 500
    });
    expect(JSON.stringify(result)).not.toMatch(
      /EACCES|Users|\.codex|hooks\.json|lstat|server-canary|stack|cause/u
    );
  });

  it("preserves an allowlisted typed code with a stable mapped message", () => {
    const result = serializePublicIntegrationError(new IntegrationError(
      "INTEGRATION_DRIFTED",
      "Reviewed path /Users/private/.codex/hooks.json changed server-canary"
    ));

    expect(result).toEqual({
      code: "INTEGRATION_DRIFTED",
      message: "The reviewed integration state changed. Create a fresh plan.",
      httpStatus: 409
    });
    expect(JSON.stringify(result)).not.toMatch(/Users|\.codex|server-canary/u);
  });

  it("replaces a private transaction reason in both error and receipt", () => {
    const transaction = new IntegrationTransactionError(new CompanionTransactionError(
      Object.assign(new Error("EIO /Users/private server-canary"), { code: "EIO" }),
      {
        transactionId: "00000000-0000-4000-8000-000000000001",
        outcome: "recovery-required",
        hook: "unknown",
        companion: "unknown",
        recordId: "record-private",
        cleanup: "pending",
        reasonCode: "EIO",
        nextSafeAction: "recover-transaction"
      }
    ));

    const result = serializePublicIntegrationError(transaction);

    expect(result).toEqual({
      code: "INTEGRATION_RECOVERY_REQUIRED",
      message: "Integration recovery is required before another change.",
      httpStatus: 409,
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000001",
        outcome: "recovery-required",
        hook: "unknown",
        companion: "unknown",
        recordId: "record-private",
        cleanup: "pending",
        reasonCode: "INTEGRATION_RECOVERY_REQUIRED",
        nextSafeAction: "recover-transaction"
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/EIO|Users|server-canary|cause/u);
  });

  it("preserves an allowlisted transaction reason with its safe public message", () => {
    const transaction = new IntegrationTransactionError(new CompanionTransactionError(
      new IntegrationError("INTEGRATION_DRIFTED", "private changed path"),
      {
        transactionId: "00000000-0000-4000-8000-000000000002",
        outcome: "rolled-back",
        hook: "unchanged",
        companion: "unchanged",
        recordId: "record-drift",
        cleanup: "clean",
        reasonCode: "INTEGRATION_DRIFTED",
        nextSafeAction: "create-new-plan"
      }
    ));

    expect(serializePublicIntegrationError(transaction)).toEqual({
      code: "INTEGRATION_DRIFTED",
      message: "The reviewed integration state changed. Create a fresh plan.",
      httpStatus: 409,
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000002",
        outcome: "rolled-back",
        hook: "unchanged",
        companion: "unchanged",
        recordId: "record-drift",
        cleanup: "clean",
        reasonCode: "INTEGRATION_DRIFTED",
        nextSafeAction: "create-new-plan"
      }
    });
  });
});
