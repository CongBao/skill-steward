import type { CatalogSkillRecord, CatalogSource } from "../src/domain.js";
import { InstallerError } from "@skill-steward/installer";
import { describe, expect, it } from "vitest";
import {
  catalogCandidateSource,
  verifyCatalogCandidateInspection
} from "../src/installation.js";

const source: CatalogSource = {
  id: "fixture",
  name: "Fixture",
  kind: "git",
  url: "https://example.com/skills.git",
  ref: "main",
  subdirectory: "skills",
  enabled: true,
  trust: "user",
  preset: false
};

function candidate(relativePath = "review"): CatalogSkillRecord {
  return {
    id: "catalog-review",
    sourceId: source.id,
    sourceRevision: "a".repeat(40),
    relativePath,
    name: "review",
    description: "Review changes",
    fingerprint: `sha256:${"b".repeat(64)}`,
    estimatedTokens: 200,
    scripts: [],
    executables: [],
    findings: [],
    compatibleHarnesses: [],
    compatibility: "unknown"
  };
}

describe("catalog candidate installation", () => {
  it("pins the recorded revision and exact candidate subdirectory", () => {
    expect(catalogCandidateSource(candidate(), source)).toEqual({
      kind: "git",
      url: source.url,
      ref: "a".repeat(40),
      subdirectory: "skills/review"
    });
    expect(catalogCandidateSource(candidate("."), source)).toEqual({
      kind: "git",
      url: source.url,
      ref: "a".repeat(40),
      subdirectory: "skills"
    });
  });

  it("requires one reinspected root candidate with the recorded fingerprint", () => {
    const recorded = candidate();
    const inspected = {
      id: "staged-root",
      relativePath: ".",
      name: "review",
      description: "Review changes",
      fingerprint: recorded.fingerprint,
      files: [],
      estimatedTokens: 200,
      scripts: [],
      executables: [],
      findings: []
    };
    expect(verifyCatalogCandidateInspection(recorded, {
      commitSha: recorded.sourceRevision,
      candidates: [inspected]
    })).toBe(inspected);
    for (const inspection of [
      { commitSha: "c".repeat(40), candidates: [inspected] },
      { commitSha: recorded.sourceRevision, candidates: [{ ...inspected, fingerprint: `sha256:${"d".repeat(64)}` }] },
      { commitSha: recorded.sourceRevision, candidates: [inspected, { ...inspected, id: "two" }] }
    ]) {
      expect(() => verifyCatalogCandidateInspection(recorded, inspection))
        .toThrowError(InstallerError);
    }
  });
});
