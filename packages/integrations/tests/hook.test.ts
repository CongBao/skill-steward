import {
  PREFLIGHT_ALGORITHM_VERSION,
  toCompactPreflight,
  type PreflightResult
} from "@skill-steward/preflight";
import { describe, expect, it, vi } from "vitest";
import { renderPromptHook, runPromptHook } from "../src/hook.js";

const rawTask = "PRIVATE rotate customer encryption keys";

function result(): PreflightResult {
  return {
    schemaVersion: 5,
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    id: "run-1",
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    taskHash: `sha256:${"b".repeat(64)}`,
    taskCharacterCount: rawTask.length,
    taskTermCount: 5,
    useCandidateIds: ["security"],
    installCandidateIds: ["testing"],
    candidates: [
      {
        candidateId: "security",
        availability: "installed",
        installedSkillId: "security",
        name: "security-review",
        description: rawTask,
        scope: "global",
        compatibleHarnesses: ["codex"],
        compatibility: "declared",
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.8,
        uniqueCoverage: 0.5,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0,
        contextTokens: 200,
        features: {
          taskCoverage: 0.8,
          skillPrecision: 0.6,
          nameMatch: true,
          projectScopeFit: false,
          capabilityCoverage: 0.5,
          capabilityPrecision: 0.5,
          triggerConfidence: "exact"
        },
        decision: "use",
        reasons: [{ code: "TASK_TERM_MATCH", detail: rawTask }]
      },
      {
        candidateId: "testing",
        availability: "available",
        catalogSkillId: "testing",
        name: "testing-review",
        description: "Find missing tests",
        scope: "unknown",
        compatibleHarnesses: [],
        compatibility: "unknown",
        scripts: [],
        executables: [],
        highestSeverity: null,
        relevance: 0.7,
        uniqueCoverage: 0.25,
        riskPenalty: 0,
        redundancyPenalty: 0,
        installPenalty: 0.08,
        contextTokens: 180,
        features: {
          taskCoverage: 0.5,
          skillPrecision: 0.4,
          nameMatch: false,
          projectScopeFit: false,
          capabilityCoverage: 0.25,
          capabilityPrecision: 0.25,
          triggerConfidence: "partial"
        },
        decision: "install",
        source: {
          sourceId: "fixture",
          trust: "user",
          url: "https://example.com/private.git",
          revision: "c".repeat(40),
          relativePath: "testing"
        },
        reasons: [{ code: "INSTALL_REQUIRED", detail: "Approval required" }]
      }
    ],
    conflicts: [{
      id: "conflict",
      code: "OVERLAPPING_TRIGGER",
      severity: "warning",
      skillIds: ["security"],
      summary: "Overlap",
      evidence: [],
      recommendation: "Review",
      confidence: 1
    }],
    inventoryWarnings: [{
      code: "HARNESS_AMBIGUOUS",
      harness: "codex",
      detail: "Visibility is ambiguous for every matching installed candidate."
    }],
    capabilityGaps: ["deployment"],
    installedCoverage: 0.5,
    projectedCoverage: 0.75,
    selectedContextTokens: 380,
    plausibleContextTokens: 500,
    estimatedContextSaved: 120
  };
}

describe.each(["codex", "claude-code"] as const)("%s prompt hook", (harness) => {
  it("injects compact sanitized recommendation context", () => {
    const output = renderPromptHook({ harness, result: result(), maxBytes: 2_048 });
    const serialized = JSON.stringify(output);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2_048);
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("Use now: security-review")
      }
    });
    expect(serialized).toContain("Consider installing (approval required): testing-review");
    expect(serialized).toContain("Warnings: HARNESS_AMBIGUOUS, OVERLAPPING_TRIGGER");
    expect(serialized).not.toContain(rawTask);
    expect(serialized).not.toContain("https://example.com/");
  });
});

it("truncates complete list items to the byte budget", () => {
  const oversized = result();
  oversized.candidates[0]!.name = "安".repeat(400);
  oversized.candidates[1]!.name = "测".repeat(400);
  const output = renderPromptHook({
    harness: "codex",
    result: oversized,
    maxBytes: 512
  });
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(512);
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  expect(context).not.toContain("�");
  expect(context).toContain("Do not install or modify Skills without explicit user approval.");
});

it("renders names and codes through the shared compact Preflight contract", () => {
  const oversized = result();
  oversized.candidates[0]!.name = `共享-${"安".repeat(2_000)}`;
  oversized.candidates[1]!.name = `安装-${"测".repeat(2_000)}`;
  const compact = toCompactPreflight(oversized);

  const output = renderPromptHook({
    harness: "codex",
    result: oversized,
    maxBytes: 2_048
  });
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  expect(context).toContain(`Use now: ${compact.use[0]!.name}`);
  expect(context).toContain(`Warnings: ${[
    ...compact.inventoryWarningCodes,
    ...compact.conflictWarningCodes
  ].join(", ")}`);
  expect(context).not.toContain(oversized.candidates[0]!.name);
  expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(2_048);
});

it("parses native input and fails open for invalid input or analysis errors", async () => {
  const analyze = vi.fn(async () => result());
  const output = await runPromptHook({
    harness: "codex",
    stdin: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: rawTask,
      cwd: "/tmp/project",
      session_id: "session-1"
    }),
    analyze
  });
  expect(analyze).toHaveBeenCalledWith({
    task: rawTask,
    cwd: "/tmp/project",
    harness: "codex"
  });
  expect(JSON.stringify(output)).not.toContain(rawTask);
  expect(await runPromptHook({
    harness: "codex",
    stdin: "not-json",
    analyze
  })).toEqual({});
  expect(await runPromptHook({
    harness: "claude-code",
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: rawTask, cwd: "/tmp" }),
    analyze: async () => { throw new Error("state unavailable"); }
  })).toEqual({});
});

it("records a content-free delivery without changing prompt output when evidence fails", async () => {
  const deliveries: unknown[] = [];
  const output = await runPromptHook({
    harness: "codex",
    stdin: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: rawTask,
      cwd: "/private/customer/project",
      session_id: "raw-session",
      turn_id: "raw-turn",
      transcript_path: "/private/transcript.jsonl"
    }),
    analyze: async () => result(),
    privacy: {
      key: (namespace) => `hmac-sha256:${(namespace === "session" ? "a" : "b").repeat(64)}`
    },
    now: () => new Date("2026-07-03T00:01:00.000Z"),
    id: () => "delivery-1",
    onDelivery: async (event) => {
      deliveries.push(event);
      throw new Error("journal unavailable");
    }
  });
  expect(output.hookSpecificOutput?.additionalContext).toContain("security-review");
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toEqual({
    schemaVersion: 1,
    id: "delivery-1",
    createdAt: "2026-07-03T00:01:00.000Z",
    kind: "preflight-delivered",
    harness: "codex",
    preflightId: "run-1",
    algorithmVersion: PREFLIGHT_ALGORITHM_VERSION,
    sessionKey: `hmac-sha256:${"a".repeat(64)}`,
    turnKey: `hmac-sha256:${"b".repeat(64)}`
  });
  expect(JSON.stringify(deliveries)).not.toMatch(/PRIVATE|raw-session|raw-turn|transcript|customer/);
});
