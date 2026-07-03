import {
  preflightResultSchema,
  type PreflightResult
} from "@skill-steward/preflight";
import {
  promptInjectionHarnessSchema,
  promptHookInputSchema,
  type IntegrationHarness,
  type PromptHookOutput
} from "./domain.js";
import {
  normalizePromptDelivery,
  type LifecyclePrivacy
} from "./lifecycle.js";
import type { EvidenceEvent } from "@skill-steward/evidence";

export interface RenderPromptHookInput {
  harness: IntegrationHarness;
  result: PreflightResult;
  maxBytes?: number;
}

function safeItem(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(safeItem).filter(Boolean))];
}

function renderContext(input: {
  id: string;
  use: string[];
  install: string[];
  warnings: string[];
  gaps: string[];
}): string {
  const list = (values: string[]) => values.length ? values.join(", ") : "none";
  return [
    `Skill Steward preflight ${safeItem(input.id)}`,
    `Use now: ${list(input.use)}`,
    `Consider installing (approval required): ${list(input.install)}`,
    `Warnings: ${list(input.warnings)}`,
    `Capability gaps: ${list(input.gaps)}`,
    "Do not install or modify Skills without explicit user approval."
  ].join("\n");
}

function outputFor(context: string): PromptHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  };
}

export function renderPromptHook(input: RenderPromptHookInput): PromptHookOutput {
  promptInjectionHarnessSchema.parse(input.harness);
  const result = preflightResultSchema.parse(input.result);
  const maxBytes = input.maxBytes ?? 2_048;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return {};

  const lists = {
    id: result.id,
    use: unique(result.candidates.filter(({ decision }) => decision === "use").map(({ name }) => name)),
    install: unique(result.candidates.filter(({ decision }) => decision === "install").map(({ name }) => name)),
    warnings: unique(result.conflicts.map(({ code }) => code)),
    gaps: unique(result.capabilityGaps)
  };
  let output = outputFor(renderContext(lists));
  const removalOrder: Array<keyof Pick<typeof lists, "gaps" | "warnings" | "install" | "use">> = [
    "gaps",
    "warnings",
    "install",
    "use"
  ];
  while (Buffer.byteLength(JSON.stringify(output)) > maxBytes) {
    const key = removalOrder.find((candidate) => lists[candidate].length > 0);
    if (!key) return {};
    lists[key].pop();
    output = outputFor(renderContext(lists));
  }
  return output;
}

export interface RunPromptHookInput {
  harness: IntegrationHarness;
  stdin: string;
  maxBytes?: number;
  privacy?: LifecyclePrivacy;
  now?: () => Date;
  id?: () => string;
  onDelivery?(event: EvidenceEvent): Promise<void> | void;
  analyze(input: {
    task: string;
    cwd: string;
    harness: IntegrationHarness;
  }): Promise<PreflightResult>;
}

export async function runPromptHook(
  input: RunPromptHookInput
): Promise<PromptHookOutput> {
  try {
    const harness = promptInjectionHarnessSchema.parse(input.harness);
    const payload = promptHookInputSchema.parse(JSON.parse(input.stdin));
    const result = await input.analyze({
      task: payload.prompt,
      cwd: payload.cwd,
      harness
    });
    const output = renderPromptHook({
      harness,
      result,
      ...(input.maxBytes ? { maxBytes: input.maxBytes } : {})
    });
    if (input.onDelivery) {
      try {
        await input.onDelivery(normalizePromptDelivery({
          harness,
          payload,
          preflightId: result.id,
          algorithmVersion: result.algorithmVersion,
          ...(input.privacy ? { privacy: input.privacy } : {}),
          ...(input.now ? { now: input.now } : {}),
          ...(input.id ? { id: input.id } : {})
        }));
      } catch {
        // Recommendation injection remains fail-open if evidence cannot be recorded.
      }
    }
    return output;
  } catch {
    return {};
  }
}
