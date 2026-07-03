import type { CatalogSkillRecord, CatalogSource } from "@skill-steward/catalog";
import type { PortfolioReport, SkillRecord } from "@skill-steward/engine";
import { expect, it } from "vitest";
import { analyzePreflight } from "../src/analyze.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

it("analyzes one thousand installed and five thousand available Skills within budget", () => {
  const skills: SkillRecord[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `skill-${String(index).padStart(4, "0")}`,
    name: `skill-${index}`,
    description: index % 50 === 0
      ? "Review TypeScript security changes and missing tests"
      : `Perform specialized task number ${index}`,
    path: `/skills/skill-${index}`,
    root: `skill-${index}`,
    scope: index % 2 ? "global" : "project",
    visibleTo: ["codex"],
    fingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
    files: [],
    estimatedTokens: 100 + index
  }));
  const source: CatalogSource = {
    id: "performance-catalog",
    name: "Performance catalog",
    kind: "git",
    url: "https://example.com/performance.git",
    enabled: true,
    trust: "user",
    preset: false
  };
  const catalogSkills: CatalogSkillRecord[] = Array.from({ length: 5_000 }, (_, index) => ({
    id: `catalog-${String(index).padStart(4, "0")}`,
    sourceId: source.id,
    sourceRevision: "a".repeat(40),
    relativePath: `skill-${index}`,
    name: `catalog-skill-${index}`,
    description: index % 100 === 0
      ? "Review TypeScript security changes and missing tests"
      : `Handle catalog capability number ${index}`,
    fingerprint: `sha256:${(index + 10_000).toString(16).padStart(64, "0")}`,
    estimatedTokens: 100 + index,
    scripts: [],
    executables: [],
    findings: [],
    compatibleHarnesses: [],
    compatibility: "unknown"
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
    catalogSkills,
    catalogSources: [source],
    maxSkills: 5,
    id: "performance-run",
    now: new Date("2026-07-03T00:00:00.000Z")
  };

  const started = performance.now();
  const first = analyzePreflight(input);
  const elapsed = performance.now() - started;
  const second = analyzePreflight(input);

  expect(elapsed).toBeLessThan(250);
  expect(first.useCandidateIds).toEqual(second.useCandidateIds);
  expect(first.installCandidateIds).toEqual(second.installCandidateIds);
  expect(first.candidates).toEqual(second.candidates);
});
