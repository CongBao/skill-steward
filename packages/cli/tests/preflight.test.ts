import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPreflightEvidence,
  readLatestReport,
  writeCatalogSnapshot,
  writeCatalogSources
} from "@skill-steward/store";
import type { PreflightResult } from "@skill-steward/preflight";
import { beforeEach, describe, expect, it } from "vitest";
import { renderPreflightHuman } from "../src/commands/preflight.js";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

interface Fixture {
  base: string;
  stateDir: string;
  taskFile: string;
  context: CliContext & { stdin: () => Promise<string> };
  stdout: string[];
  stderr: string[];
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "steward-cli-preflight-"));
  const skillDirectory = join(base, ".agents", "skills", "security-review");
  const stateDir = join(base, "state");
  const taskFile = join(base, "task.txt");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: security-review\ndescription: Review TypeScript security changes\n---\nReview the change.\n"
  );
  await writeFile(taskFile, "Review this TypeScript change for security regressions");
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    base,
    stateDir,
    taskFile,
    stdout,
    stderr,
    context: {
      cwd: base,
      home: join(base, "home"),
      stateDir,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      stdin: async () => "Review security changes and missing tests"
    }
  };
}

async function seedCatalog(current: Fixture): Promise<void> {
  const source = {
    id: "fixture-catalog",
    name: "Fixture catalog",
    kind: "git" as const,
    url: "https://example.com/skills.git",
    enabled: true,
    trust: "user" as const,
    preset: false
  };
  await writeCatalogSources(current.stateDir, [source]);
  await writeCatalogSnapshot(current.stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    sources: [{
      sourceId: source.id,
      status: "ready",
      commitSha: "a".repeat(40),
      refreshedAt: "2026-07-03T00:00:00.000Z",
      skillCount: 1
    }],
    skills: [{
      id: "testing-available",
      sourceId: source.id,
      sourceRevision: "a".repeat(40),
      relativePath: "testing",
      name: "testing-review",
      description: "Find missing tests and test regressions",
      fingerprint: `sha256:${"e".repeat(64)}`,
      estimatedTokens: 180,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: ["codex"],
      compatibility: "declared"
    }]
  });
}

describe("preflight command", () => {
  let current: Fixture;

  beforeEach(async () => {
    current = await fixture();
  });

  it("prints an explainable human recommendation and saves a fresh report", async () => {
    await seedCatalog(current);
    const exitCode = await run(
      [
        "preflight",
        "--task",
        "Review this TypeScript change for security regressions and missing tests",
        "--max-skills",
        "3",
        "--harness",
        "codex"
      ],
      current.context
    );

    expect(exitCode).toBe(0);
    expect(current.stdout.join("")).toContain("security-review");
    expect(current.stdout.join("")).toMatch(/Run ID: [a-f0-9-]+/u);
    expect(current.stdout.join("")).toContain("Task match:");
    expect(current.stdout.join("")).not.toContain("TASK_TERM_MATCH:");
    expect(current.stdout.join("")).toContain("Consider installing");
    expect(current.stdout.join("")).toContain("testing-review");
    expect(current.stdout.join("")).toContain("Estimated context saved");
    expect(await readLatestReport(current.stateDir)).toMatchObject({
      schemaVersion: 1,
      skills: [expect.objectContaining({ name: "security-review" })]
    });
    const disk = await readFile(join(current.stateDir, "preflights.json"), "utf8");
    expect(disk).not.toContain("Review this TypeScript change");
    expect((await readPreflightEvidence(current.stateDir))[0]).toMatchObject({
      harness: "codex",
      delivery: "cli"
    });
  });

  it("reads task files relative to cwd", async () => {
    const exitCode = await run(
      ["preflight", "--task-file", "task.txt", "--json"],
      current.context
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      schemaVersion: 3,
      candidates: [expect.objectContaining({ name: "security-review" })]
    });
  });

  it("reads stdin and emits the shared JSON schema", async () => {
    const exitCode = await run(
      ["preflight", "--stdin", "--json"],
      current.context
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(current.stdout.join(""));
    expect(output).toMatchObject({
      schemaVersion: 3,
      algorithmVersion: 3,
      useCandidateIds: expect.any(Array),
      installCandidateIds: expect.any(Array)
    });
    expect(output).not.toHaveProperty("task");
  });

  it("rejects missing or multiple task sources", async () => {
    expect(await run(["preflight"], current.context)).toBe(1);
    expect(
      await run(
        ["preflight", "--task", "Review this change", "--stdin"],
        current.context
      )
    ).toBe(1);
    expect(current.stderr.join(" ")).toContain("exactly one task source");
  });

  it("rejects max-skills outside one through five", async () => {
    expect(
      await run(
        ["preflight", "--task", "Review this source change", "--max-skills", "0"],
        current.context
      )
    ).toBe(1);
    expect(
      await run(
        ["preflight", "--task", "Review this source change", "--max-skills", "6"],
        current.context
      )
    ).toBe(1);
    expect(current.stderr.join(" ")).toContain("max-skills");
  });

  it("supports installed-only mode and rejects invalid Harness IDs", async () => {
    await seedCatalog(current);
    expect(await run([
      "preflight",
      "--task", "Review TypeScript security changes and missing tests",
      "--harness", "codex",
      "--installed-only",
      "--json"
    ], current.context)).toBe(0);
    const output = JSON.parse(current.stdout.splice(0).join(""));
    expect(output.installCandidateIds).toEqual([]);
    expect(output.candidates.every(({ availability }: { availability: string }) =>
      availability === "installed"
    )).toBe(true);
    expect(await run([
      "preflight",
      "--task", "Review TypeScript security changes",
      "--harness", "invalid-harness",
      "--json"
    ], current.context)).toBe(1);
  });

  it("bounds low-value exclusions and points to complete JSON", () => {
    const result: PreflightResult = {
      schemaVersion: 3,
      algorithmVersion: 3,
      id: "run-1",
      generatedAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"a".repeat(64)}`,
      taskHash: `sha256:${"b".repeat(64)}`,
      taskCharacterCount: 20,
      taskTermCount: 4,
      useCandidateIds: [],
      installCandidateIds: [],
      candidates: Array.from({ length: 8 }, (_, index) => ({
        candidateId: `candidate-${index}`,
        availability: "installed" as const,
        installedSkillId: `candidate-${index}`,
        name: `candidate-${index}`,
        description: "Unrelated helper",
        scope: "global" as const,
        compatibleHarnesses: ["codex" as const],
        compatibility: "portable" as const,
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.01,
        uniqueCoverage: 0,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: 100,
        features: {
          taskCoverage: 0,
          skillPrecision: 0,
          nameMatch: false,
          projectScopeFit: false
        },
        decision: "excluded" as const,
        reasons: [{
          code: "LOW_RELEVANCE" as const,
          detail: "Task relevance is below the deterministic threshold."
        }]
      })),
      conflicts: [],
      capabilityGaps: ["security"],
      installedCoverage: 0,
      projectedCoverage: 0,
      selectedContextTokens: 0,
      plausibleContextTokens: 0,
      estimatedContextSaved: 0
    };

    result.candidates[0]!.name = "trusted\u001b[2J\nspoof";
    result.candidates[0]!.reasons[0]!.detail = "low\u001b]52;c;payload\u0007";
    const output = renderPreflightHuman(result);
    expect(output).toContain("5 shown, 3 more omitted; use --json for full details");
    expect(output).toContain(
      "skill-steward evidence feedback --preflight run-1 --label useful"
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("trusted\\u{001b}[2J\\u{000a}spoof");
    expect(output).toContain("low\\u{001b}]52;c;payload\\u{0007}");
  });

  it("explains a hard exclusion instead of the generic relevance fallback", () => {
    const result: PreflightResult = {
      schemaVersion: 3,
      algorithmVersion: 3,
      id: "run-1",
      generatedAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"a".repeat(64)}`,
      taskHash: `sha256:${"b".repeat(64)}`,
      taskCharacterCount: 20,
      taskTermCount: 4,
      useCandidateIds: [],
      installCandidateIds: [],
      candidates: [{
        candidateId: "docx",
        availability: "available",
        catalogSkillId: "docx",
        name: "docx",
        description: "Do not use for PDFs.",
        scope: "unknown",
        compatibleHarnesses: [],
        compatibility: "unknown",
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.2,
        uniqueCoverage: 0,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0.05,
        contextTokens: 100,
        features: {
          taskCoverage: 0.2,
          skillPrecision: 0.2,
          nameMatch: false,
          projectScopeFit: false
        },
        decision: "excluded",
        source: {
          sourceId: "fixture",
          trust: "user",
          url: "https://example.com/fixture.git",
          revision: "a".repeat(40),
          relativePath: "docx"
        },
        reasons: [
          { code: "NEGATIVE_TRIGGER", detail: "The Skill explicitly excludes PDF tasks." },
          { code: "LOW_RELEVANCE", detail: "Task relevance is below the threshold." }
        ]
      }],
      conflicts: [],
      capabilityGaps: ["pdf"],
      installedCoverage: 0,
      projectedCoverage: 0,
      selectedContextTokens: 0,
      plausibleContextTokens: 0,
      estimatedContextSaved: 0
    };

    expect(renderPreflightHuman(result)).toContain(
      "docx: The Skill explicitly excludes PDF tasks."
    );
  });
});
