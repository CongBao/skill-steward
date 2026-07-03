import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import {
  analyzePreflight,
  preflightRequestSchema,
  type PreflightResult
} from "@skill-steward/preflight";
import {
  appendPreflightEvidence,
  readCatalogSnapshot,
  readCatalogSources,
  writeLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";

export interface PreflightCommandOptions {
  task?: string;
  taskFile?: string;
  stdin: boolean;
  maxSkills: number;
  json: boolean;
  harness?: string;
  includeAvailable: boolean;
}

async function resolveTask(
  options: PreflightCommandOptions,
  context: CliContext
): Promise<string> {
  const sourceCount = [
    typeof options.task === "string",
    typeof options.taskFile === "string",
    options.stdin
  ].filter(Boolean).length;
  if (sourceCount !== 1) {
    throw new Error(
      "Choose exactly one task source: --task, --task-file, or --stdin"
    );
  }
  if (typeof options.task === "string") return options.task;
  if (typeof options.taskFile === "string") {
    return readFile(resolve(context.cwd, options.taskFile), "utf8");
  }
  if (!context.stdin) {
    throw new Error("Standard input is unavailable in this environment");
  }
  return context.stdin();
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderPreflightHuman(result: PreflightResult): string {
  const selected = result.candidates.filter(({ decision }) => decision === "use");
  const install = result.candidates.filter(({ decision }) => decision === "install");
  const excluded = result.candidates.filter(
    ({ decision }) => decision === "excluded"
  );
  const lines = ["Task Preflight", "", "Use now:"];
  if (selected.length === 0) {
    lines.push("- none matched the deterministic relevance threshold");
  } else {
    for (const candidate of selected) {
      lines.push(
        `- ${candidate.name} — relevance ${percentage(candidate.relevance)}, ` +
          `${candidate.contextTokens} estimated tokens`
      );
      for (const reason of candidate.reasons) {
        lines.push(`  ${reason.code}: ${reason.detail}`);
      }
    }
  }

  lines.push("", "Consider installing:");
  if (install.length === 0) {
    lines.push("- none");
  } else {
    for (const candidate of install) {
      lines.push(
        `- ${candidate.name} — relevance ${percentage(candidate.relevance)}, ` +
        `${candidate.contextTokens} estimated tokens`
      );
      if (candidate.source) {
        lines.push(
          `  source ${candidate.source.sourceId} [${candidate.source.trust}], ` +
          `revision ${candidate.source.revision.slice(0, 12)}, ${candidate.compatibility}`
        );
      }
      if (candidate.highestSeverity) {
        lines.push(`  highest finding ${candidate.highestSeverity}`);
      }
      for (const reason of candidate.reasons) lines.push(`  ${reason.code}: ${reason.detail}`);
    }
  }

  lines.push("", "Capability gaps:");
  lines.push(result.capabilityGaps.length
    ? `- ${result.capabilityGaps.join(", ")}`
    : "- none");

  lines.push("", "Conflicts:");
  if (result.conflicts.length === 0) {
    lines.push("- none");
  } else {
    for (const conflict of result.conflicts) {
      lines.push(`- ${conflict.code}: ${conflict.summary}`);
    }
  }

  lines.push("", "Excluded candidates:");
  if (excluded.length === 0) {
    lines.push("- none");
  } else {
    for (const candidate of excluded) {
      const reason = candidate.reasons.at(-1);
      lines.push(`- ${candidate.name}: ${reason?.detail ?? "lower marginal value"}`);
    }
  }

  lines.push(
    "",
    `Selected context: ${result.selectedContextTokens} estimated tokens`,
    `Installed coverage: ${percentage(result.installedCoverage)}`,
    `Projected coverage: ${percentage(result.projectedCoverage)}`,
    `Estimated context saved: ${result.estimatedContextSaved} tokens`,
    ""
  );
  return lines.join("\n");
}

export async function preflightCommand(
  options: PreflightCommandOptions,
  context: CliContext
): Promise<number> {
  try {
    if (
      !Number.isInteger(options.maxSkills) ||
      options.maxSkills < 1 ||
      options.maxSkills > 5
    ) {
      throw new Error("--max-skills must be an integer from 1 through 5");
    }
    const task = await resolveTask(options, context);
    const request = preflightRequestSchema.parse({
      task,
      maxSkills: options.maxSkills,
      ...(options.harness ? { harness: options.harness } : {}),
      includeAvailable: options.includeAvailable
    });
    const [report, catalogSources, catalogSnapshot] = await Promise.all([
      scanPortfolio(standardRoots({ home: context.home, cwd: context.cwd })),
      readCatalogSources(context.stateDir),
      readCatalogSnapshot(context.stateDir)
    ]);
    await writeLatestReport(context.stateDir, report);
    const result = analyzePreflight({
      task: request.task,
      maxSkills: request.maxSkills,
      includeAvailable: request.includeAvailable,
      ...(request.harness ? { harness: request.harness } : {}),
      report,
      catalogSkills: catalogSnapshot?.skills ?? [],
      catalogSources,
      id: randomUUID(),
      now: new Date()
    });
    await appendPreflightEvidence(context.stateDir, result);
    context.stdout(
      options.json ? `${JSON.stringify(result, null, 2)}\n` : renderPreflightHuman(result)
    );
    return 0;
  } catch (error) {
    context.stderr(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}
