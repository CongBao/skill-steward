import { z } from "zod";

export const integrationHarnessSchema = z.enum(["codex", "claude-code", "github-copilot"]);
export const promptInjectionHarnessSchema = z.enum(["codex", "claude-code"]);

export const integrationCapabilitySchema = z.object({
  harness: integrationHarnessSchema,
  displayName: z.string().min(1),
  mode: z.enum(["recommend-and-observe", "observe-only"]),
  promptInjection: z.boolean(),
  observation: z.boolean(),
  turnLifecycle: z.boolean(),
  sessionLifecycle: z.boolean(),
  events: z.array(z.string().min(1)),
  installScopes: z.array(z.enum(["global", "project"])),
  validationStatus: z.enum(["fixture-tested"])
}).strict();

export const integrationCapabilities = z.array(integrationCapabilitySchema).parse([
  {
    harness: "codex",
    displayName: "Codex",
    mode: "recommend-and-observe",
    promptInjection: true,
    observation: true,
    turnLifecycle: true,
    sessionLifecycle: false,
    events: ["UserPromptSubmit", "Stop"],
    installScopes: ["global", "project"],
    validationStatus: "fixture-tested"
  },
  {
    harness: "claude-code",
    displayName: "Claude Code",
    mode: "recommend-and-observe",
    promptInjection: true,
    observation: true,
    turnLifecycle: true,
    sessionLifecycle: true,
    events: ["UserPromptSubmit", "Stop", "SessionEnd"],
    installScopes: ["global", "project"],
    validationStatus: "fixture-tested"
  },
  {
    harness: "github-copilot",
    displayName: "GitHub Copilot CLI",
    mode: "observe-only",
    promptInjection: false,
    observation: true,
    turnLifecycle: false,
    sessionLifecycle: true,
    events: ["userPromptSubmitted", "sessionEnd"],
    installScopes: ["global", "project"],
    validationStatus: "fixture-tested"
  }
]);

export const promptHookInputSchema = z.object({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(4_096),
  session_id: z.string().min(1).max(1_024).optional(),
  turn_id: z.string().min(1).max(1_024).optional()
}).passthrough();

export type IntegrationHarness = z.infer<typeof integrationHarnessSchema>;
export type PromptInjectionHarness = z.infer<typeof promptInjectionHarnessSchema>;
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;
export type PromptHookInput = z.infer<typeof promptHookInputSchema>;

export interface PromptHookOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}
