import { randomUUID } from "node:crypto";
import {
  integrationHarnessSchema,
  runPromptHook,
  type IntegrationHarness
} from "@skill-steward/integrations";
import { analyzePreflight } from "@skill-steward/preflight";
import {
  appendPreflightEvidence,
  readCatalogSnapshot,
  readCatalogSources,
  readLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";

function preflightHarness(harness: IntegrationHarness): "codex" | "claude" {
  return harness === "codex" ? "codex" : "claude";
}

export async function hookPromptCommand(
  inputHarness: string,
  context: CliContext
): Promise<number> {
  let output: unknown = {};
  try {
    const harness = integrationHarnessSchema.parse(inputHarness);
    if (!context.stdin) throw new Error("Standard input is unavailable");
    const stdin = await context.stdin();
    output = await runPromptHook({
      harness,
      stdin,
      analyze: async ({ task }) => {
        const [report, sources, snapshot] = await Promise.all([
          readLatestReport(context.stateDir),
          readCatalogSources(context.stateDir),
          readCatalogSnapshot(context.stateDir)
        ]);
        if (!report) throw new Error("No cached portfolio report is available");
        const result = analyzePreflight({
          task,
          report,
          catalogSkills: snapshot?.skills ?? [],
          catalogSources: sources,
          harness: preflightHarness(harness),
          includeAvailable: true,
          id: randomUUID(),
          now: context.now?.() ?? new Date()
        });
        await appendPreflightEvidence(context.stateDir, result);
        return result;
      }
    });
  } catch (error) {
    if (process.env.SKILL_STEWARD_DEBUG === "1") {
      context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  context.stdout(`${JSON.stringify(output)}\n`);
  return 0;
}
