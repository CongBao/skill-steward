import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCatalogSnapshot,
  writeCatalogSources,
  writeLatestReport
} from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
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

async function seedState(stateDir: string): Promise<void> {
  await writeLatestReport(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
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
      estimatedTokens: 200
    }],
    findings: []
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
});
