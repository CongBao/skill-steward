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
