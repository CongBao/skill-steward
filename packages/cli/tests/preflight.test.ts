import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPreflightEvidence,
  readLatestReport,
  writeLatestReport,
  writeCatalogSnapshot,
  writeCatalogSources
} from "@skill-steward/store";
import {
  COMPACT_PREFLIGHT_MAX_BYTES,
  COMPACT_PREFLIGHT_SCHEMA_VERSION,
  PREFLIGHT_ALGORITHM_VERSION,
  compactPreflightResultSchema,
  type PreflightResult
} from "@skill-steward/preflight";
import { fingerprintDirectory } from "@skill-steward/installer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  preflightCommand,
  renderPreflightHuman
} from "../src/commands/preflight.js";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

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
  const candidateDirectory = join(current.base, "catalog-candidate");
  await mkdir(candidateDirectory, { recursive: true });
  await writeFile(
    join(candidateDirectory, "SKILL.md"),
    "---\nname: testing-review\ndescription: Find missing tests and test regressions\n---\nReview tests.\n"
  );
  const fingerprint = await fingerprintDirectory(candidateDirectory);
  current.context.catalogStage = async (destination) => {
    const staged = join(destination, "source");
    await cp(candidateDirectory, staged, { recursive: true });
    return { sourceDirectory: staged, commitSha: "a".repeat(40) };
  };
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
      fingerprint,
      estimatedTokens: 180,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: ["codex"],
      compatibility: "declared"
    }]
  });
}

type CandidateHarness = PreflightResult["candidates"][number]["compatibleHarnesses"][number];
type CandidateScope = PreflightResult["candidates"][number]["scope"];

function installRecommendationResult(
  candidateId = "testing-available",
  compatibleHarnesses: CandidateHarness[] = ["codex"],
  scope: CandidateScope = "unknown"
): PreflightResult {
  return {
    schemaVersion: 5,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id: "run-install",
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    taskHash: `sha256:${"b".repeat(64)}`,
    taskCharacterCount: 28,
    taskTermCount: 4,
    useCandidateIds: [],
    installCandidateIds: [candidateId],
    candidates: [{
      candidateId,
      catalogSkillId: candidateId,
      availability: "available",
      name: "testing-review",
      description: "Find missing tests and regressions",
      scope,
      compatibleHarnesses,
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.8,
      uniqueCoverage: 0.6,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0.05,
      contextTokens: 180,
      features: {
        taskCoverage: 0.8,
        skillPrecision: 0.75,
        nameMatch: false,
        projectScopeFit: false,
        capabilityCoverage: 0.8,
        capabilityPrecision: 0.75,
        triggerConfidence: "exact"
      },
      decision: "install",
      source: {
        sourceId: "fixture-catalog",
        trust: "user",
        url: "https://example.com/skills.git",
        revision: "a".repeat(40),
        relativePath: "testing"
      },
      reasons: [{
        code: "INSTALL_REQUIRED",
        detail: "Install preview is required before use."
      }]
    }],
    conflicts: [],
    inventoryWarnings: [],
    capabilityGaps: [],
    installedCoverage: 0,
    projectedCoverage: 0.8,
    selectedContextTokens: 0,
    plausibleContextTokens: 180,
    estimatedContextSaved: 0
  };
}

describe("preflight command", () => {
  it("documents the bounded max-skills range in command help", async () => {
    const stdout: string[] = [];
    const exitCode = await run(["preflight", "--help"], {
      cwd: process.cwd(),
      home: process.cwd(),
      stateDir: join(process.cwd(), ".test-state"),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(stdout.join(" ")).toContain("--max-skills <1-5>");
  });
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
    const output = current.stdout.join("");
    expect(output).toContain("security-review");
    expect(output).toMatch(/Run ID: [a-f0-9-]+/u);
    expect(output).toContain("Task match:");
    expect(output).not.toContain("TASK_TERM_MATCH:");
    expect(output).toContain("Consider installing");
    expect(output).toContain("testing-review");
    expect(output).toContain("Candidate ID: testing-available");
    const installCommand = output.split("\n").find((line) =>
      line.trimStart().startsWith("skill-steward install --catalog-candidate")
    );
    expect(installCommand?.trim()).toMatch(
      /^skill-steward install --catalog-candidate testing-available --harness codex --scope project --preflight [A-Za-z0-9._:@+-]+$/u
    );
    expect(output).toContain("Estimated context saved");
    expect(await readLatestReport(current.stateDir)).toMatchObject({
      schemaVersion: 2,
      skills: [expect.objectContaining({ name: "security-review" })]
    });
    const disk = await readFile(join(current.stateDir, "preflights.json"), "utf8");
    expect(disk).not.toContain("Review this TypeScript change");
    expect((await readPreflightEvidence(current.stateDir))[0]).toMatchObject({
      harness: "codex",
      delivery: "cli"
    });

    current.stdout.splice(0);
    const previewArguments = installCommand?.trim().split(/\s+/u).slice(1) ?? [];
    expect(await run([...previewArguments, "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      status: "ready",
      provenance: {
        preflightId: expect.any(String),
        candidateId: "testing-available"
      }
    });
  });

  it.each([
    ["codex", "codex"],
    ["claude", "claude"],
    ["github-copilot", "github-copilot"]
  ] as const)(
    "prints an exact reviewed install preview for explicit %s Preflight",
    (harness, compatibleHarness) => {
      const output = renderPreflightHuman(
        installRecommendationResult("testing-available", [compatibleHarness]),
        { harness }
      );

      expect(output).toContain("Candidate ID: testing-available");
      expect(output).toContain(
        `skill-steward install --catalog-candidate testing-available ` +
        `--harness ${harness} --scope project --preflight run-install`
      );
      expect(output).toContain("reviewed preview");
      expect(output).not.toContain("--confirm");
    }
  );

  it.each([
    ["global", "--scope global"],
    ["project", "--scope project"]
  ] as const)(
    "preserves a declared %s scope in the install preview",
    (scope, args) => {
      const output = renderPreflightHuman(
        installRecommendationResult("testing-available", ["codex"], scope),
        { harness: "codex" }
      );

      expect(output).toContain(
        `skill-steward install --catalog-candidate testing-available ` +
        `--harness codex ${args} --preflight run-install`
      );
      expect(output).not.toContain("--workspace");
    }
  );

  it("prints candidate identity without guessing a Harness", () => {
    const output = renderPreflightHuman(installRecommendationResult());

    expect(output).toContain("Candidate ID: testing-available");
    expect(output).toContain("rerun Preflight with --harness <id>");
    expect(output).not.toContain("skill-steward install --catalog-candidate");
    expect(output).not.toContain("--harness codex");
  });

  it.each(["unknown", "not-a-harness"])(
    "does not print an install preview for unsupported Harness %s",
    (harness) => {
      const output = renderPreflightHuman(installRecommendationResult(), {
        harness
      });

      expect(output).toContain("Candidate ID: testing-available");
      expect(output).toContain("rerun Preflight with --harness <id>");
      expect(output).not.toContain("skill-steward install --catalog-candidate");
    }
  );

  it("keeps install handoff identifiers terminal-safe", () => {
    const unsafeId = "testing\u001b[2J\nspoof";
    const output = renderPreflightHuman(
      installRecommendationResult(unsafeId),
      { harness: "codex" }
    );

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\nspoof");
    expect(output).toContain("testing\\u{001b}[2J\\u{000a}spoof");
  });

  it("renders a readable lifecycle-trigger explanation for a long review task", async () => {
    await writeFile(
      join(current.base, ".agents", "skills", "security-review", "SKILL.md"),
      "---\nname: requesting-code-review\ndescription: Use before merging to review completed work\n---\nReview the change.\n"
    );

    expect(await run([
      "preflight",
      "--task", "Review Phase 2 lifecycle compatibility, filesystem safety, and API privacy before merge",
      "--harness", "codex"
    ], current.context)).toBe(0);

    const output = current.stdout.join("");
    expect(output).toContain("requesting-code-review");
    expect(output).toContain("Lifecycle trigger:");
    expect(output).not.toContain("HIGH_CONFIDENCE_TRIGGER:");
  });

  it("runs explicit preflight against the shared native inventory", async () => {
    await writeLatestReport(current.stateDir, {
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"1".repeat(64)}`,
      skills: [],
      findings: []
    });
    await installNativeCodexFixture(current.context.home, "native-security-review");

    expect(await run([
      "preflight",
      "--task", "Review native plugin security changes and tests",
      "--harness", "codex",
      "--json"
    ], current.context)).toBe(0);

    const output = JSON.parse(current.stdout.splice(0).join(""));
    expect(output.schemaVersion).toBe(5);
    expect(output.candidates).toContainEqual(expect.objectContaining({
      name: "native-security-review",
      availability: "installed"
    }));
    expect(await readLatestReport(current.stateDir)).toMatchObject({
      schemaVersion: 2,
      skills: expect.arrayContaining([expect.objectContaining({
        name: "native-security-review",
        ownership: "native-plugin"
      })]),
      inventory: {
        harnesses: expect.arrayContaining([
          expect.objectContaining({ harness: "codex", status: "verified" })
        ])
      }
    });
  });

  it("reads task files relative to cwd", async () => {
    const exitCode = await run(
      ["preflight", "--task-file", "task.txt", "--json"],
      current.context
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      schemaVersion: 5,
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
      schemaVersion: 5,
      algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
      useCandidateIds: expect.any(Array),
      installCandidateIds: expect.any(Array)
    });
    expect(output).not.toHaveProperty("task");
  });

  it("emits one minified compact JSON line from the same fresh inventory path", async () => {
    await seedCatalog(current);
    const exitCode = await run(
      ["preflight", "--stdin", "--harness", "codex", "--compact-json"],
      current.context
    );

    expect(exitCode).toBe(0);
    const serialized = current.stdout.join("");
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.slice(0, -1)).not.toContain("\n");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      COMPACT_PREFLIGHT_MAX_BYTES + 1
    );
    const output = compactPreflightResultSchema.parse(JSON.parse(serialized));
    expect(output).toMatchObject({
      schemaVersion: COMPACT_PREFLIGHT_SCHEMA_VERSION,
      algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
      use: [expect.objectContaining({ name: "security-review" })],
      feedbackCommand: expect.stringContaining("skill-steward evidence feedback --preflight ")
    });
    expect(output).not.toHaveProperty("candidates");
    expect(output).not.toHaveProperty("taskHash");
    expect(await readLatestReport(current.stateDir)).toMatchObject({ schemaVersion: 2 });
    expect((await readPreflightEvidence(current.stateDir))[0]).toMatchObject({
      harness: "codex",
      delivery: "cli"
    });
  });

  it("returns recommendations when report and evidence persistence are unavailable", async () => {
    const exitCode = await preflightCommand({
      task: "Review security changes and missing tests",
      stdin: false,
      maxSkills: 3,
      json: true,
      compactJson: false,
      harness: "codex",
      includeAvailable: true
    }, current.context, {
      writeReport: async () => {
        throw Object.assign(new Error("secret/path/report"), { code: "EPERM" });
      },
      appendEvidence: async () => {
        throw Object.assign(new Error("secret/path/evidence"), { code: "EACCES" });
      }
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      schemaVersion: 5,
      useCandidateIds: expect.any(Array)
    });
    expect(current.stderr.join("")).toBe(
      "PREFLIGHT_PERSISTENCE_UNAVAILABLE: portfolio cache and evidence were not saved; " +
      "recommendations remain valid for this run, but feedback cannot be recorded.\n"
    );
    expect(current.stderr.join("")).not.toContain("secret/path");
  });

  it("marks compact handoff when persistence is unavailable", async () => {
    const exitCode = await preflightCommand({
      stdin: true,
      maxSkills: 3,
      json: false,
      compactJson: true,
      harness: "codex",
      includeAvailable: true
    }, current.context, {
      writeReport: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      appendEvidence: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    });

    expect(exitCode).toBe(0);
    const serialized = current.stdout.join("");
    const output = compactPreflightResultSchema.parse(JSON.parse(serialized));
    expect(output.conflictWarningCodes).toContain("PREFLIGHT_PERSISTENCE_UNAVAILABLE");
    expect(output.feedbackCommand).toBeNull();
    expect(Buffer.byteLength(serialized, "utf8"))
      .toBeLessThanOrEqual(COMPACT_PREFLIGHT_MAX_BYTES + 1);
  });

  it("keeps feedback available when only the portfolio cache write fails", async () => {
    const exitCode = await preflightCommand({
      task: "Review security changes and missing tests",
      stdin: false,
      maxSkills: 3,
      json: false,
      compactJson: false,
      harness: "codex",
      includeAvailable: true
    }, current.context, {
      writeReport: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      appendEvidence: async () => undefined
    });

    expect(exitCode).toBe(0);
    expect(current.stdout.join("")).toContain("Record feedback:");
    expect(current.stderr.join("")).toBe(
      "PREFLIGHT_PERSISTENCE_UNAVAILABLE: portfolio cache was not saved; " +
      "recommendations remain valid for this run, and evidence feedback remains available.\n"
    );
  });

  it("keeps recommendations but hides feedback when only evidence persistence fails", async () => {
    let reportWrites = 0;
    const exitCode = await preflightCommand({
      task: "Review security changes and missing tests",
      stdin: false,
      maxSkills: 3,
      json: false,
      compactJson: false,
      harness: "codex",
      includeAvailable: true
    }, current.context, {
      writeReport: async () => { reportWrites += 1; },
      appendEvidence: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    });

    expect(exitCode).toBe(0);
    expect(reportWrites).toBe(1);
    expect(current.stdout.join(""))
      .toContain("Feedback unavailable: this run could not be saved");
    expect(current.stdout.join("")).not.toContain("Record feedback:");
    expect(current.stderr.join("")).toBe(
      "PREFLIGHT_PERSISTENCE_UNAVAILABLE: evidence was not saved; " +
      "recommendations remain valid for this run, but feedback cannot be recorded.\n"
    );
  });

  it("rejects complete and compact JSON flags together", async () => {
    expect(await run([
      "preflight",
      "--stdin",
      "--json",
      "--compact-json"
    ], current.context)).toBe(1);
    expect(current.stderr.join(" ")).toMatch(/cannot be used with|conflict/i);
  });

  it("attributes valid cursor and gemini preflight requests", async () => {
    for (const harness of ["cursor", "gemini"]) {
      expect(await run([
        "preflight",
        "--task", "Review security changes and missing tests",
        "--harness", harness,
        "--json"
      ], current.context)).toBe(0);
      current.stdout.splice(0);
    }

    expect((await readPreflightEvidence(current.stateDir)).map((record) => ({
      harness: record.schemaVersion === 3 ? record.harness : undefined,
      delivery: record.schemaVersion === 3 ? record.delivery : undefined
    }))).toEqual([
      { harness: "gemini", delivery: "cli" },
      { harness: "cursor", delivery: "cli" }
    ]);
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
      schemaVersion: 5,
      algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
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
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
        },
        decision: "excluded" as const,
        reasons: [{
          code: "LOW_RELEVANCE" as const,
          detail: "Task relevance is below the deterministic threshold."
        }]
      })),
      conflicts: [],
      inventoryWarnings: [],
      capabilityGaps: ["security"],
      installedCoverage: 0,
      projectedCoverage: 0,
      selectedContextTokens: 0,
      plausibleContextTokens: 0,
      estimatedContextSaved: 0
    };

    result.candidates[0]!.name = "trusted\u001b[2J\nspoof";
    result.candidates[0]!.reasons[0]!.detail = "low\u001b]52;c;payload\u0007";
    result.candidates[1]!.name = "requesting-code-review";
    result.candidates[2]!.name = "requesting-code-review";
    result.candidates[1]!.compatibleHarnesses = ["codex"];
    result.candidates[2]!.compatibleHarnesses = ["github-copilot"];
    const output = renderPreflightHuman(result);
    expect(output).toContain("5 shown, 3 more omitted; use --json for full details");
    expect(output).toContain(
      "skill-steward evidence feedback --preflight run-1 --label useful"
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("trusted\\u{001b}[2J\\u{000a}spoof");
    expect(output).toContain("low\\u{001b}]52;c;payload\\u{0007}");
    expect(output).toContain("requesting-code-review [Codex]");
    expect(output).toContain("requesting-code-review [GitHub Copilot CLI]");
  });

  it("explains a hard exclusion instead of the generic relevance fallback", () => {
    const result: PreflightResult = {
      schemaVersion: 5,
      algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
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
          projectScopeFit: false,
          capabilityCoverage: 0,
          capabilityPrecision: 0,
          triggerConfidence: "none"
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
      inventoryWarnings: [{
        code: "HARNESS_AMBIGUOUS",
        harness: "codex",
        detail: "Visibility is ambiguous for every matching installed candidate."
      }],
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
    expect(renderPreflightHuman(result)).toContain(
      "Inventory warning: Visibility is ambiguous for every matching installed candidate."
    );
  });
});
