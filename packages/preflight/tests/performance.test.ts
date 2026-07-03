import type { PortfolioReport, SkillRecord } from "@skill-steward/engine";
import { expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

it("analyzes one thousand Skills within the preflight budget", () => {
  const skills: SkillRecord[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `skill-${String(index).padStart(4, "0")}`,
    name: `skill-${index}`,
    description:
      index % 50 === 0
        ? "Review TypeScript security changes and missing tests"
        : `Perform specialized task number ${index}`,
    path: `/skills/skill-${index}`,
    root: `skill-${index}`,
    scope: index % 2 ? "global" : "project",
    visibleTo: ["codex"],
    fingerprint: hash("b"),
    files: [],
    estimatedTokens: 100 + index
  }));
  const report: PortfolioReport = {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: hash("a"),
    skills,
    findings: []
  };
  const input = {
    task: "Review this TypeScript change for security regressions and missing tests",
    report,
    maxSkills: 5,
    id: "performance-run",
    now: new Date("2026-07-03T00:00:00.000Z")
  };

  const started = performance.now();
  const first = analyzePreflight(input);
  const elapsed = performance.now() - started;
  const second = analyzePreflight(input);

  expect(elapsed).toBeLessThan(500);
  expect(first.selectedSkillIds).toEqual(second.selectedSkillIds);
  expect(first.candidates).toEqual(second.candidates);
});
