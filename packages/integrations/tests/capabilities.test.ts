import { describe, expect, it } from "vitest";
import {
  integrationCapabilities,
  integrationCapabilitySchema
} from "../src/domain.js";

describe("integration capability model", () => {
  it("reports prompt injection and lifecycle support honestly", () => {
    expect(integrationCapabilities.map(({ harness }) => harness)).toEqual([
      "codex",
      "claude-code",
      "github-copilot"
    ]);
    expect(integrationCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        harness: "codex",
        mode: "recommend-and-observe",
        promptInjection: true,
        observation: true,
        turnLifecycle: true,
        sessionLifecycle: false
      }),
      expect.objectContaining({
        harness: "claude-code",
        mode: "recommend-and-observe",
        promptInjection: true,
        observation: true,
        turnLifecycle: true,
        sessionLifecycle: true
      }),
      expect.objectContaining({
        harness: "github-copilot",
        mode: "observe-only",
        promptInjection: false,
        observation: true,
        turnLifecycle: false,
        sessionLifecycle: true,
        events: ["userPromptSubmitted", "sessionEnd"]
      })
    ]));
    for (const capability of integrationCapabilities) {
      expect(integrationCapabilitySchema.parse(capability)).toEqual(capability);
      expect(capability.installScopes).toEqual(["global", "project"]);
      expect(capability.validationStatus).toBe("fixture-tested");
    }
  });
});
