import { randomUUID } from "node:crypto";
import {
  promptInjectionHarnessSchema,
  runLifecycleHook,
  runObserveHook,
  runPromptHook,
  type PromptInjectionHarness
} from "@skill-steward/integrations";
import { analyzePreflight } from "@skill-steward/preflight";
import {
  appendPreflightEvidence,
  appendEvidenceEvent,
  createEvidencePrivacy,
  DEFAULT_EVIDENCE_POLICY,
  readCatalogSnapshot,
  readCatalogSources,
  readEvidenceEvents,
  readEvidencePolicy,
  readLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";

const MAX_HOOK_STDIN_BYTES = 64 * 1_024;

function preflightHarness(harness: PromptInjectionHarness): "codex" | "claude" {
  return harness === "codex" ? "codex" : "claude";
}

function debug(context: CliContext, error: unknown): void {
  if (process.env.SKILL_STEWARD_DEBUG === "1") {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function hookStdin(context: CliContext): Promise<string> {
  if (!context.stdin) throw new Error("Standard input is unavailable");
  const value = await context.stdin(MAX_HOOK_STDIN_BYTES);
  if (Buffer.byteLength(value, "utf8") > MAX_HOOK_STDIN_BYTES) {
    throw new Error(`Standard input exceeds ${MAX_HOOK_STDIN_BYTES} bytes`);
  }
  return value;
}

async function evidencePolicy(context: CliContext) {
  try {
    return await readEvidencePolicy(context.stateDir);
  } catch (error) {
    debug(context, error);
    return { ...DEFAULT_EVIDENCE_POLICY };
  }
}

export async function hookPromptCommand(
  inputHarness: string,
  context: CliContext
): Promise<number> {
  let output: unknown = {};
  try {
    const harness = promptInjectionHarnessSchema.parse(inputHarness);
    const stdin = await hookStdin(context);
    const policy = await evidencePolicy(context);
    let privacy;
    if (policy.mode === "learning") {
      try {
        privacy = await createEvidencePrivacy(context.stateDir);
      } catch (error) {
        debug(context, error);
      }
    }
    output = await runPromptHook({
      harness,
      stdin,
      ...(privacy ? { privacy } : {}),
      ...(context.now ? { now: context.now } : {}),
      ...(privacy ? {
        onDelivery: (event) => appendEvidenceEvent(context.stateDir, event)
      } : {}),
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
        try {
          await appendPreflightEvidence(context.stateDir, result, {
            policy,
            harness,
            delivery: "hook"
          });
        } catch (error) {
          debug(context, error);
        }
        return result;
      }
    });
  } catch (error) {
    debug(context, error);
  }
  context.stdout(`${JSON.stringify(output)}\n`);
  return 0;
}

export async function hookLifecycleCommand(
  inputHarness: string,
  context: CliContext
): Promise<number> {
  let output: unknown = {};
  try {
    const harness = promptInjectionHarnessSchema.parse(inputHarness);
    const stdin = await hookStdin(context);
    const policy = await evidencePolicy(context);
    if (policy.mode === "learning") {
      const privacy = await createEvidencePrivacy(context.stateDir);
      const events = await readEvidenceEvents(context.stateDir);
      output = await runLifecycleHook({
        harness,
        stdin,
        privacy,
        events,
        ...(context.now ? { now: context.now } : {}),
        onEvent: (event) => appendEvidenceEvent(context.stateDir, event)
      });
    }
  } catch (error) {
    debug(context, error);
  }
  context.stdout(`${JSON.stringify(output)}\n`);
  return 0;
}

export async function hookObserveCommand(
  inputHarness: string,
  inputEvent: string,
  context: CliContext
): Promise<number> {
  let output: unknown = {};
  try {
    if (inputHarness !== "github-copilot") throw new Error("Observe Hook requires github-copilot");
    if (inputEvent !== "userPromptSubmitted" && inputEvent !== "sessionEnd") {
      throw new Error("Unsupported Copilot Hook event");
    }
    const stdin = await hookStdin(context);
    const policy = await evidencePolicy(context);
    if (policy.mode === "learning") {
      const privacy = await createEvidencePrivacy(context.stateDir);
      output = await runObserveHook({
        harness: "github-copilot",
        event: inputEvent,
        stdin,
        privacy,
        ...(context.now ? { now: context.now } : {}),
        onEvent: (event) => appendEvidenceEvent(context.stateDir, event)
      });
    }
  } catch (error) {
    debug(context, error);
  }
  context.stdout(`${JSON.stringify(output)}\n`);
  return 0;
}
