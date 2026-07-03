import { resolve } from "node:path";

const observeCommand = (event: "userPromptSubmitted" | "sessionEnd") =>
  `skill-steward hook observe --harness github-copilot --event ${event}`;

function command(event: "userPromptSubmitted" | "sessionEnd") {
  const value = observeCommand(event);
  return {
    type: "command",
    bash: value,
    powershell: value,
    timeoutSec: 1
  };
}

export function copilotHookTarget(home: string): string {
  return resolve(home, ".copilot", "hooks", "skill-steward.json");
}

export function copilotHookConfig(): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      userPromptSubmitted: [command("userPromptSubmitted")],
      sessionEnd: [command("sessionEnd")]
    }
  };
}
