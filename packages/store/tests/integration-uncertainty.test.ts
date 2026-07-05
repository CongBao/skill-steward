import { describe, expect, it } from "vitest";
import { isIntegrationMutationUncertainty } from "../src/integration-uncertainty.js";

describe("integration mutation uncertainty", () => {
  it("finds nested lease loss through causes and AggregateErrors without looping", () => {
    const cycle = new Error("cycle") as Error & { cause?: unknown };
    cycle.cause = cycle;
    const leaseLost = Object.assign(new Error("lease lost"), {
      code: "INTEGRATION_LEASE_LOST"
    });
    const nested = new Error("outer", {
      cause: new AggregateError([
        cycle,
        new Error("middle", { cause: leaseLost })
      ], "aggregate")
    });

    expect(isIntegrationMutationUncertainty(nested)).toBe(true);
    expect(isIntegrationMutationUncertainty(cycle)).toBe(false);
  });
});
