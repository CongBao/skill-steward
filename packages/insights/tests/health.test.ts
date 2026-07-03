import { describe, expect, it } from "vitest";
import { calculateHealth } from "../src/health.js";

describe("calculateHealth", () => {
  it("deducts by severity and explains every deduction", () => {
    expect(
      calculateHealth([
        { severity: "critical" },
        { severity: "warning" },
        { severity: "info" }
      ])
    ).toEqual({
      score: 69,
      deductions: { critical: 25, error: 0, warning: 5, info: 1 }
    });
  });

  it("clamps the score to zero", () => {
    expect(
      calculateHealth(
        Array.from({ length: 10 }, () => ({ severity: "critical" as const }))
      )
    ).toMatchObject({ score: 0 });
  });
});
