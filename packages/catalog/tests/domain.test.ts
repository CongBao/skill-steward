import { describe, expect, it } from "vitest";
import {
  catalogSnapshotSchema,
  catalogSourcePresets,
  catalogSourceSchema,
  catalogSkillRecordSchema
} from "../src/index.js";

describe("catalog domain", () => {
  it("rejects credential-bearing and non-HTTPS sources", () => {
    expect(() => catalogSourceSchema.parse({
      id: "bad",
      name: "Bad",
      kind: "git",
      url: "http://example.com/skills.git",
      enabled: true,
      trust: "user",
      preset: false
    })).toThrow();
    expect(() => catalogSourceSchema.parse({
      id: "bad",
      name: "Bad",
      kind: "git",
      url: "https://token@example.com/skills.git",
      enabled: true,
      trust: "user",
      preset: false
    })).toThrow();
  });

  it("ships three disabled known-publisher presets", () => {
    expect(catalogSourcePresets.map(({ id }) => id)).toEqual([
      "openai-plugins",
      "anthropic-skills",
      "github-awesome-copilot"
    ]);
    expect(catalogSourcePresets.every(({ enabled }) => !enabled)).toBe(true);
    expect(catalogSourcePresets[0]).toMatchObject({
      url: "https://github.com/openai/plugins.git",
      subdirectory: "plugins"
    });
  });

  it("validates metadata-only catalog records and snapshots", () => {
    const skill = catalogSkillRecordSchema.parse({
      id: "catalog:review",
      sourceId: "openai-plugins",
      sourceRevision: "a".repeat(40),
      relativePath: "review",
      name: "review",
      description: "Review source changes",
      fingerprint: `sha256:${"b".repeat(64)}`,
      estimatedTokens: 200,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: [],
      compatibility: "unknown"
    });
    expect(catalogSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      sources: [],
      skills: [skill]
    }).skills[0]?.name).toBe("review");
  });

  it("supports a root Skill and all configured source states", () => {
    const rootSkill = catalogSkillRecordSchema.parse({
      id: "catalog:root",
      sourceId: "root-source",
      sourceRevision: "a".repeat(40),
      relativePath: ".",
      name: "root-skill",
      description: "A Skill at the configured catalog root",
      fingerprint: `sha256:${"b".repeat(64)}`,
      estimatedTokens: 100,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: [],
      compatibility: "unknown"
    });
    const sources = Array.from({ length: 8 }, (_, index) => ({
      sourceId: `source-${index}`,
      status: "disabled" as const,
      skillCount: 0
    }));
    expect(catalogSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      sources,
      skills: [rootSkill]
    }).sources).toHaveLength(8);
    expect(() => catalogSourceSchema.parse({
      id: "bad-subdirectory",
      name: "Bad subdirectory",
      kind: "git",
      url: "https://example.com/skills.git",
      subdirectory: ".",
      enabled: false,
      trust: "user",
      preset: false
    })).toThrow();
  });
});
