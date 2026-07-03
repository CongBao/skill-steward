import { describe, expect, it } from "vitest";
import type { PortfolioReport } from "@skill-steward/engine";
import { renderJson, renderMarkdown } from "../src/render.js";

const report: PortfolioReport = {
  schemaVersion: 1,
  generatedAt: "2026-07-02T00:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  skills: [],
  findings: [
    {
      id: "finding-1",
      code: "BROKEN_RELATIVE_REFERENCE",
      severity: "error",
      skillIds: [],
      summary: "Missing file.",
      evidence: ["references/missing.md"],
      recommendation: "Restore the file.",
      confidence: 1
    }
  ]
};

describe("report rendering", () => {
  it("renders a Markdown finding with evidence and recommendation", () => {
    const output = renderMarkdown(report);
    expect(output).toContain("# Skill Steward Portfolio Report");
    expect(output).toContain("BROKEN_RELATIVE_REFERENCE");
    expect(output).toContain("references/missing.md");
    expect(output).toContain("Restore the file.");
  });

  it("renders parseable JSON with a trailing newline", () => {
    const output = renderJson(report);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual(report);
  });
});
