import { describe, expect, it, vi } from "vitest";
import {
  normalizeLifecycleInput,
  runLifecycleHook
} from "../src/lifecycle.js";

const pseudonym = (namespace: "session" | "turn") =>
  `hmac-sha256:${(namespace === "session" ? "a" : "b").repeat(64)}` as const;

const privacy = {
  key: (namespace: "session" | "turn") => pseudonym(namespace)
};

describe("Codex lifecycle", () => {
  it("normalizes Stop through an allow-list and ignores content fields", () => {
    const event = normalizeLifecycleInput({
      harness: "codex",
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "raw-session",
        turn_id: "raw-turn",
        cwd: "/private/customer/project",
        transcript_path: "/private/transcript.jsonl",
        last_assistant_message: "PRIVATE customer output",
        tool_output: "PRIVATE tool output"
      }),
      privacy,
      preflightId: "run-1",
      now: () => new Date("2026-07-03T00:02:00.000Z"),
      id: () => "turn-1"
    });
    expect(event).toEqual({
      schemaVersion: 1,
      id: "turn-1",
      createdAt: "2026-07-03T00:02:00.000Z",
      kind: "turn-finished",
      harness: "codex",
      preflightId: "run-1",
      sessionKey: pseudonym("session"),
      turnKey: pseudonym("turn"),
      reason: "complete"
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|raw-session|raw-turn|transcript|customer/);
  });

  it("fails open with neutral JSON for malformed input and evidence errors", async () => {
    const onEvent = vi.fn(async () => { throw new Error("journal unavailable"); });
    expect(await runLifecycleHook({
      harness: "codex",
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session" }),
      privacy,
      onEvent
    })).toEqual({});
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(await runLifecycleHook({
      harness: "codex",
      stdin: "not-json",
      privacy,
      onEvent
    })).toEqual({});
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe("Claude Code lifecycle", () => {
  it("closes the latest open delivery for the pseudonymous session", () => {
    const sessionKey = pseudonym("session");
    const event = normalizeLifecycleInput({
      harness: "claude-code",
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "raw-session",
        stop_hook_active: false,
        transcript_path: "/private/transcript.jsonl",
        last_assistant_message: "PRIVATE customer output"
      }),
      privacy,
      events: [
        {
          schemaVersion: 1,
          id: "delivery-old",
          createdAt: "2026-07-03T00:00:00.000Z",
          kind: "preflight-delivered",
          harness: "claude-code",
          preflightId: "run-old",
          algorithmVersion: 2,
          sessionKey
        },
        {
          schemaVersion: 1,
          id: "delivery-latest",
          createdAt: "2026-07-03T00:01:00.000Z",
          kind: "preflight-delivered",
          harness: "claude-code",
          preflightId: "run-latest",
          algorithmVersion: 2,
          sessionKey
        }
      ],
      now: () => new Date("2026-07-03T00:02:00.000Z"),
      id: () => "turn-claude"
    });
    expect(event).toMatchObject({
      kind: "turn-finished",
      harness: "claude-code",
      preflightId: "run-latest",
      sessionKey,
      reason: "complete"
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|raw-session|transcript|customer/);
  });

  it.each([
    ["clear", "user-exit"],
    ["resume", "user-exit"],
    ["logout", "user-exit"],
    ["prompt_input_exit", "user-exit"],
    ["bypass_permissions_disabled", "other"],
    ["other", "other"]
  ] as const)("buckets SessionEnd reason %s as %s", (reason, expected) => {
    expect(normalizeLifecycleInput({
      harness: "claude-code",
      stdin: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: "raw-session",
        reason,
        transcript_path: "/private/transcript.jsonl"
      }),
      privacy,
      id: () => `session-${reason}`,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).toEqual({
      schemaVersion: 1,
      id: `session-${reason}`,
      createdAt: "2026-07-03T00:03:00.000Z",
      kind: "session-ended",
      harness: "claude-code",
      sessionKey: pseudonym("session"),
      reason: expected
    });
  });
});
