import { z } from "zod";

export const integrationHarnessSchema = z.enum(["codex", "claude-code"]);

export const promptHookInputSchema = z.object({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string().min(1).max(20_000),
  cwd: z.string().min(1),
  session_id: z.string().optional(),
  turn_id: z.string().optional()
}).passthrough();

export type IntegrationHarness = z.infer<typeof integrationHarnessSchema>;
export type PromptHookInput = z.infer<typeof promptHookInputSchema>;

export interface PromptHookOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}
