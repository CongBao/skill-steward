import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecoveryTransition,
  createIntegrationRecoveryIntent,
  type IntegrationRecoveryIntentInput,
  type IntegrationRecoveryTransitionInput
} from "../src/index.js";

describe("integration recovery mutation types", () => {
  it("requires an opaque live lease context in every mutation call", () => {
    if (false) {
      // @ts-expect-error mutation options with a live lease context are required
      void createIntegrationRecoveryIntent("/state", {} as IntegrationRecoveryIntentInput);
      // @ts-expect-error mutation options with a live lease context are required
      void appendIntegrationRecoveryTransition(
        "/state",
        {} as IntegrationRecoveryTransitionInput
      );
    }
    expect(true).toBe(true);
  });
});
