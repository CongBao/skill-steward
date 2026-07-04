import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvidencePolicyPlan,
  planEvidencePolicyChange,
  readEvidenceEvents,
  readPreflightEvidence,
  writeCatalogSnapshot,
  writeCatalogSources,
  writeLatestReport
} from "@skill-steward/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "steward-hook-cli-"));
  const stateDir = join(base, "state");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: base,
    home: base,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "PRIVATE review security and missing tests",
      cwd: base
    })
  };
  return { base, stateDir, stdout, stderr, context };
}

async function enableLearning(stateDir: string): Promise<void> {
  const plan = await planEvidencePolicyChange(stateDir, {
    mode: "learning",
    retentionDays: 30,
    maxEvents: 5_000
  });
  await applyEvidencePolicyPlan(stateDir, plan);
}

async function seedState(stateDir: string): Promise<void> {
  await writeLatestReport(stateDir, {
    schemaVersion: 2,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    workspace: {
      path: "/fixture/workspace",
      identity: `sha256:${"e".repeat(64)}`
    },
    skills: [{
      id: "security",
      name: "security-review",
      description: "Review security risks",
      path: "/fixture/security",
      root: "security",
      scope: "global",
      visibleTo: ["codex", "claude"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 200,
      ownership: "direct",
      sourceIds: ["codex:fixture", "claude:fixture"],
      exposures: [
        {
          harness: "codex",
          effectiveName: "security-review",
          state: "effective",
          sourceId: "codex:fixture",
          reason: "TEST_EFFECTIVE"
        },
        {
          harness: "claude",
          effectiveName: "security-review",
          state: "effective",
          sourceId: "claude:fixture",
          reason: "TEST_EFFECTIVE"
        }
      ]
    }],
    findings: [],
    inventory: {
      sources: ["codex", "claude"].map((harness) => ({
        id: `${harness}:fixture`,
        harness: harness as "codex" | "claude",
        scope: "global" as const,
        kind: "direct-root" as const,
        path: `/fixture/${harness}/skills`,
        status: "scanned" as const,
        skillCount: 1,
        effectiveSkillCount: 1
      })),
      harnesses: ["codex", "claude"].map((harness) => ({
        harness: harness as "codex" | "claude",
        status: "verified" as const,
        sourceIds: [`${harness}:fixture`],
        skillCount: 1,
        effectiveSkillCount: 1
      }))
    }
  });
  const source = {
    id: "fixture-catalog",
    name: "Fixture catalog",
    kind: "git" as const,
    url: "https://example.com/skills.git",
    enabled: true,
    trust: "user" as const,
    preset: false
  };
  await writeCatalogSources(stateDir, [source]);
  await writeCatalogSnapshot(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    sources: [{ sourceId: source.id, status: "ready", skillCount: 1 }],
    skills: [{
      id: "testing",
      sourceId: source.id,
      sourceRevision: "c".repeat(40),
      relativePath: "testing",
      name: "testing-review",
      description: "Find missing tests",
      fingerprint: `sha256:${"d".repeat(64)}`,
      estimatedTokens: 180,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: ["codex", "claude"],
      compatibility: "declared"
    }]
  });
}

async function seedLegacyState(stateDir: string): Promise<void> {
  await writeLatestReport(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [{
      id: "legacy-security",
      name: "legacy-security",
      description: "Review security risks",
      path: "/private/legacy/native/cache/security",
      root: "security",
      scope: "global",
      visibleTo: ["codex"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 200
    }],
    findings: []
  });
}

describe("hook command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("reads cached local state and emits one sanitized JSON object", async () => {
    await seedState(current.stateDir);
    expect(await run([
      "hook", "prompt", "--harness", "codex"
    ], current.context)).toBe(0);
    expect(current.stdout).toHaveLength(1);
    const output = JSON.parse(current.stdout[0]!);
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("security-review")
      }
    });
    expect(output.hookSpecificOutput.additionalContext).toContain("testing-review");
    expect(current.stdout[0]).not.toContain("PRIVATE");
    expect(current.stdout[0]).not.toContain("https://example.com");
    const [record] = await readPreflightEvidence(current.stateDir);
    expect(record).toMatchObject({
      schemaVersion: 3,
      harness: "codex",
      delivery: "hook"
    });
    expect(record).not.toHaveProperty("candidateFeatures");
    await expect(access(join(current.stateDir, "evidence-events.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "evidence-salt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails open with valid JSON for missing state and malformed input", async () => {
    expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
    expect(current.stdout.splice(0)).toEqual(["{}\n"]);
    current.context.stdin = async () => "not-json";
    expect(await run([
      "hook", "prompt", "--harness", "claude-code"
    ], current.context)).toBe(0);
    expect(current.stdout).toEqual(["{}\n"]);
  });

  it("fails open for legacy inventory and reports only a compact debug status", async () => {
    await seedLegacyState(current.stateDir);
    vi.stubEnv("SKILL_STEWARD_DEBUG", "1");
    try {
      expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
      expect(current.stdout).toEqual(["{}\n"]);
      expect(current.stderr).toEqual(["INVENTORY_RESCAN_REQUIRED\n"]);
      expect(current.stderr.join("")).not.toMatch(/private|legacy|cache|security/iu);
      expect(await readPreflightEvidence(current.stateDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records learning-mode prompt, turn, and Copilot session evidence without content", async () => {
    await seedState(current.stateDir);
    await enableLearning(current.stateDir);
    current.context.stdin = async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "PRIVATE review security and missing tests",
      cwd: "/private/customer/project",
      session_id: "raw-session",
      turn_id: "raw-turn",
      transcript_path: "/private/transcript.jsonl"
    });
    expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
    const delivery = (await readEvidenceEvents(current.stateDir)).find(
      ({ kind }) => kind === "preflight-delivered"
    );
    expect(delivery).toMatchObject({
      kind: "preflight-delivered",
      harness: "codex",
      sessionKey: expect.stringMatching(/^hmac-sha256:/),
      turnKey: expect.stringMatching(/^hmac-sha256:/)
    });
    expect((await readPreflightEvidence(current.stateDir))[0]).toMatchObject({
      harness: "codex",
      candidateFeatures: expect.any(Array)
    });

    current.stdout.splice(0);
    current.context.stdin = async () => JSON.stringify({
      hook_event_name: "Stop",
      session_id: "raw-session",
      turn_id: "raw-turn",
      last_assistant_message: "PRIVATE assistant output",
      transcript_path: "/private/transcript.jsonl"
    });
    expect(await run(["hook", "lifecycle", "--harness", "codex"], current.context)).toBe(0);
    expect(current.stdout).toEqual(["{}\n"]);

    current.stdout.splice(0);
    current.context.stdin = async () => JSON.stringify({
      sessionId: "raw-copilot-session",
      timestamp: 1_783_035_600_000,
      cwd: "/private/customer/project",
      prompt: "PRIVATE copilot prompt"
    });
    expect(await run([
      "hook", "observe", "--harness", "github-copilot", "--event", "userPromptSubmitted"
    ], current.context)).toBe(0);
    expect(current.stdout).toEqual(["{}\n"]);

    current.stdout.splice(0);
    current.context.stdin = async () => JSON.stringify({
      sessionId: "raw-copilot-session",
      timestamp: 1_783_035_601_000,
      cwd: "/private/customer/project",
      reason: "complete"
    });
    expect(await run([
      "hook", "observe", "--harness", "github-copilot", "--event", "sessionEnd"
    ], current.context)).toBe(0);
    expect(current.stdout).toEqual(["{}\n"]);

    const serialized = await readFile(join(current.stateDir, "evidence-events.jsonl"), "utf8");
    expect(serialized).toContain('"kind":"turn-finished"');
    expect(serialized).toContain('"kind":"prompt-observed"');
    expect(serialized).toContain('"kind":"session-ended"');
    expect(serialized).not.toMatch(/PRIVATE|raw-session|raw-turn|raw-copilot|customer|transcript/);
  });

  it("keeps Harness output valid when learning evidence fails or stdin is oversized", async () => {
    await seedState(current.stateDir);
    await enableLearning(current.stateDir);
    await writeFile(join(current.stateDir, "evidence-salt"), "invalid", "utf8");
    expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout[0]!)).toHaveProperty("hookSpecificOutput");

    current.stdout.splice(0);
    current.context.stdin = async () => "x".repeat(65_537);
    expect(await run(["hook", "lifecycle", "--harness", "codex"], current.context)).toBe(0);
    expect(current.stdout).toEqual(["{}\n"]);
  });
});
