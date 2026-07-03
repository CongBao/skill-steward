import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp, createEvidenceServices } from "@skill-steward/dashboard-server";
import {
  applyEvidencePolicyPlan,
  planEvidencePolicyChange,
  writeLatestReport
} from "@skill-steward/store";
import { expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

const canaries = {
  prompt: "CANARY_RAW_PROMPT_94721",
  transcript: "CANARY_TRANSCRIPT_94721",
  rawId: "CANARY_RAW_IDENTIFIER_94721",
  path: "/CANARY/WORKING/PATH/94721",
  toolArgument: "CANARY_TOOL_ARGUMENT_94721",
  toolOutput: "CANARY_TOOL_OUTPUT_94721",
  assistant: "CANARY_ASSISTANT_MESSAGE_94721"
};

async function stateText(stateDirectory: string): Promise<string> {
  const entries = await readdir(stateDirectory, { recursive: true });
  return (await Promise.all(entries.map(async (entry) => {
    try {
      return await readFile(join(stateDirectory, entry), "utf8");
    } catch {
      return "";
    }
  }))).join("\n");
}

it("keeps every Harness response valid and every adversarial content canary out of evidence", async () => {
  const base = await mkdtemp(join(tmpdir(), "steward-privacy-gate-"));
  const home = join(base, "home");
  const stateDir = join(base, "state");
  const workspace = join(base, "workspace");
  await mkdir(home);
  await mkdir(stateDir);
  await mkdir(workspace);
  await writeLatestReport(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [{
      id: "review-skill",
      name: "review-skill",
      description: "Review security changes",
      path: join(home, ".agents", "skills", "review-skill"),
      root: "review-skill",
      scope: "global",
      visibleTo: ["codex", "claude", "github-copilot"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 80
    }],
    findings: []
  });
  const policyPlan = await planEvidencePolicyChange(stateDir, {
    mode: "learning",
    retentionDays: 30,
    maxEvents: 5_000
  });
  await applyEvidencePolicyPlan(stateDir, policyPlan);

  const stdout: string[] = [];
  const context: CliContext = {
    cwd: workspace,
    home,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
    now: () => new Date("2026-07-03T00:05:00.000Z")
  };
  const invoke = async (args: string[], payload: Record<string, unknown>) => {
    stdout.splice(0);
    context.stdin = async () => JSON.stringify(payload);
    expect(await run(args, context)).toBe(0);
    expect(stdout).toHaveLength(1);
    const parsed: unknown = JSON.parse(stdout[0]!);
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
    expect(typeof parsed).toBe("object");
    return parsed as Record<string, unknown>;
  };
  const contentFields = {
    cwd: canaries.path,
    transcript_path: canaries.transcript,
    transcript: canaries.transcript,
    tool_input: canaries.toolArgument,
    tool_output: canaries.toolOutput,
    last_assistant_message: canaries.assistant
  };

  expect(await invoke(["hook", "prompt", "--harness", "codex"], {
    hook_event_name: "UserPromptSubmit",
    prompt: `${canaries.prompt} review security`,
    session_id: canaries.rawId,
    turn_id: `${canaries.rawId}-turn`,
    ...contentFields
  })).toHaveProperty("hookSpecificOutput");
  expect(await invoke(["hook", "lifecycle", "--harness", "codex"], {
    hook_event_name: "Stop",
    session_id: canaries.rawId,
    turn_id: `${canaries.rawId}-turn`,
    ...contentFields
  })).toEqual({});
  expect(await invoke(["hook", "prompt", "--harness", "claude-code"], {
    hook_event_name: "UserPromptSubmit",
    prompt: `${canaries.prompt} review security`,
    session_id: `${canaries.rawId}-claude`,
    ...contentFields
  })).toHaveProperty("hookSpecificOutput");
  expect(await invoke(["hook", "lifecycle", "--harness", "claude-code"], {
    hook_event_name: "Stop",
    session_id: `${canaries.rawId}-claude`,
    stop_hook_active: false,
    ...contentFields
  })).toEqual({});
  expect(await invoke(["hook", "lifecycle", "--harness", "claude-code"], {
    hook_event_name: "SessionEnd",
    session_id: `${canaries.rawId}-claude`,
    reason: "clear",
    ...contentFields
  })).toEqual({});
  expect(await invoke(["hook", "observe", "--harness", "github-copilot", "--event", "userPromptSubmitted"], {
    sessionId: `${canaries.rawId}-copilot`,
    timestamp: 1_783_036_800_000,
    prompt: canaries.prompt,
    ...contentFields
  })).toEqual({});
  expect(await invoke(["hook", "observe", "--harness", "github-copilot", "--event", "sessionEnd"], {
    sessionId: `${canaries.rawId}-copilot`,
    timestamp: 1_783_036_801_000,
    reason: "complete",
    ...contentFields
  })).toEqual({});

  const persisted = await stateText(stateDir);
  for (const canary of Object.values(canaries)) expect(persisted).not.toContain(canary);

  const salt = await readFile(join(stateDir, "evidence-salt"));
  const exportPath = join(base, "evidence-export.json");
  stdout.splice(0);
  expect(await run(["evidence", "export", "--output", exportPath], context)).toBe(0);
  const exported = await readFile(exportPath, "utf8");
  for (const canary of Object.values(canaries)) expect(exported).not.toContain(canary);
  expect(exported).not.toContain(salt.toString("hex"));
  expect(exported).not.toContain(salt.toString("base64"));

  const evidenceServices = createEvidenceServices({ stateDirectory: stateDir });
  const { app } = createDashboardApp({ mutationToken: "test-token", evidenceServices });
  const response = await app.inject({ url: "/api/v1/evidence/summary" });
  expect(response.statusCode).toBe(200);
  for (const canary of Object.values(canaries)) expect(response.body).not.toContain(canary);
  expect(response.body).not.toContain(salt.toString("hex"));
  expect(response.body).not.toContain(salt.toString("base64"));
  await app.close();
}, 30_000);
