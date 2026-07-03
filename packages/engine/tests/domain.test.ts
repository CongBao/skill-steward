import { describe, expect, it } from "vitest";
import { findingLabelSchema, portfolioReportSchema } from "../src/domain.js";

describe("portfolioReportSchema", () => {
  it("rejects an unsupported report schema version", () => {
    const result = portfolioReportSchema.safeParse({
      schemaVersion: 2,
      generatedAt: "2026-07-02T00:00:00.000Z",
      portfolioFingerprint: "sha256:abc",
      skills: [],
      findings: []
    });

    expect(result.success).toBe(false);
  });

  it("does not persist a complete skill body in report records", () => {
    const result = portfolioReportSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"a".repeat(64)}`,
      skills: [{
        id: "skill-1",
        name: "review",
        description: "Review code",
        path: "/skills/review",
        root: "review",
        scope: "global",
        visibleTo: ["agents"],
        fingerprint: `sha256:${"b".repeat(64)}`,
        files: [],
        estimatedTokens: 10,
        body: "private instructions"
      }],
      findings: []
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills[0]).not.toHaveProperty("body");
  });
});

describe("findingLabelSchema", () => {
  it("accepts the four feedback values used by the alpha", () => {
    for (const label of ["useful", "incorrect", "unclear", "already-known"]) {
      expect(findingLabelSchema.safeParse({
        findingId: "finding-1",
        label,
        createdAt: "2026-07-02T00:00:00.000Z"
      }).success).toBe(true);
    }
  });
});
