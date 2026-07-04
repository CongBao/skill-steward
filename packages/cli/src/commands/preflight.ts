import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanInventory } from "@skill-steward/engine";
import { normalizeEvidenceHarness } from "@skill-steward/evidence";
import {
  analyzePreflight,
  preflightRequestSchema,
  toCompactPreflight,
  type PreflightReasonCode,
  type PreflightResult
} from "@skill-steward/preflight";
import {
  appendPreflightEvidence,
  readCatalogSnapshot,
  readCatalogSources,
  writeLatestReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import { terminalSafeText } from "../terminal.js";

export interface PreflightCommandOptions {
  task?: string;
  taskFile?: string;
  stdin: boolean;
  maxSkills: number;
  json: boolean;
  compactJson: boolean;
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

const reasonLabels: Record<PreflightReasonCode, string> = {
  TASK_TERM_MATCH: "Task match",
  NAME_MATCH: "Name match",
  HIGH_CONFIDENCE_TRIGGER: "Lifecycle trigger",
  PROJECT_SCOPE_FIT: "Project fit",
  UNIQUE_COVERAGE: "Unique value",
  REDUNDANT_WITH_SELECTED: "Redundant",
  LOW_RELEVANCE: "Low relevance",
  PORTFOLIO_RISK: "Portfolio risk",
  INSTALL_REQUIRED: "Install required",
  CRITICAL_RISK: "Critical risk",
  HARNESS_INCOMPATIBLE: "Harness mismatch",
  HARNESS_SHADOWED: "Harness shadowed",
  HARNESS_INACTIVE: "Harness inactive",
  HARNESS_AMBIGUOUS: "Harness ambiguous",
  INVENTORY_RESCAN_REQUIRED: "Inventory rescan required",
  NEGATIVE_TRIGGER: "Explicit exclusion"
};

function renderReason(code: PreflightReasonCode, detail: string): string {
  return `  ${reasonLabels[code]}: ${terminalSafeText(detail)}`;
}

const exclusionReasonPriority: readonly PreflightReasonCode[] = [
  "INVENTORY_RESCAN_REQUIRED",
  "HARNESS_SHADOWED",
  "HARNESS_INACTIVE",
  "HARNESS_AMBIGUOUS",
  "NEGATIVE_TRIGGER",
  "CRITICAL_RISK",
  "HARNESS_INCOMPATIBLE",
  "REDUNDANT_WITH_SELECTED",
  "LOW_RELEVANCE"
];

function exclusionReason(
  candidate: PreflightResult["candidates"][number]
): string {
  for (const code of exclusionReasonPriority) {
    const reason = candidate.reasons.find((item) => item.code === code);
    if (reason) return reason.detail;
  }
  return candidate.reasons.at(-1)?.detail ?? "lower marginal value";
}

export function renderPreflightHuman(result: PreflightResult): string {
  const selected = result.candidates.filter(({ decision }) => decision === "use");
  const install = result.candidates.filter(({ decision }) => decision === "install");
  const excluded = result.candidates.filter(
    ({ decision }) => decision === "excluded"
  );
  const lines = ["Task Preflight", `Run ID: ${result.id}`, "", "Use now:"];
  if (selected.length === 0) {
    lines.push("- none matched the deterministic relevance threshold");
  } else {
    for (const candidate of selected) {
      lines.push(
        `- ${terminalSafeText(candidate.name)} — relevance ${percentage(candidate.relevance)}, ` +
          `${candidate.contextTokens} estimated tokens`
      );
      for (const reason of candidate.reasons) {
        lines.push(renderReason(reason.code, reason.detail));
      }
    }
  }

  lines.push("", "Consider installing:");
  if (install.length === 0) {
    lines.push("- none");
  } else {
    for (const candidate of install) {
      lines.push(
        `- ${terminalSafeText(candidate.name)} — relevance ${percentage(candidate.relevance)}, ` +
        `${candidate.contextTokens} estimated tokens`
      );
      if (candidate.source) {
        lines.push(
          `  source ${terminalSafeText(candidate.source.sourceId)} [${candidate.source.trust}], ` +
          `revision ${terminalSafeText(candidate.source.revision.slice(0, 12))}, ${candidate.compatibility}`
        );
      }
      if (candidate.highestSeverity) {
        lines.push(`  highest finding ${candidate.highestSeverity}`);
      }
      for (const reason of candidate.reasons) {
        lines.push(renderReason(reason.code, reason.detail));
      }
    }
  }

  lines.push("", "Inventory warnings:");
  if (result.inventoryWarnings.length === 0) {
    lines.push("- none");
  } else {
    for (const warning of result.inventoryWarnings) {
      lines.push(`- Inventory warning: ${terminalSafeText(warning.detail)}`);
    }
  }

  lines.push("", "Capability gaps:");
  lines.push(result.capabilityGaps.length
    ? `- ${result.capabilityGaps.map(terminalSafeText).join(", ")}`
    : "- none");

  lines.push("", "Conflicts:");
  if (result.conflicts.length === 0) {
    lines.push("- none");
  } else {
    for (const conflict of result.conflicts) {
      lines.push(`- ${terminalSafeText(conflict.code)}: ${terminalSafeText(conflict.summary)}`);
    }
  }

  lines.push("", "Excluded candidates:");
  if (excluded.length === 0) {
    lines.push("- none");
  } else {
    const shown = excluded.slice(0, 5);
    for (const candidate of shown) {
      lines.push(`- ${terminalSafeText(candidate.name)}: ${terminalSafeText(exclusionReason(candidate))}`);
    }
    if (shown.length < excluded.length) {
      lines.push(
        `- ${shown.length} shown, ${excluded.length - shown.length} more omitted; ` +
        "use --json for full details"
      );
    }
  }

  lines.push(
    "",
    `Selected context: ${result.selectedContextTokens} estimated tokens`,
    `Installed coverage: ${percentage(result.installedCoverage)}`,
    `Projected coverage: ${percentage(result.projectedCoverage)}`,
    `Estimated context saved: ${result.estimatedContextSaved} tokens`,
    "",
    "Record feedback:",
    `skill-steward evidence feedback --preflight ${result.id} --label useful`,
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
      scanInventory({ home: context.home, cwd: context.cwd }),
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
    const harness = normalizeEvidenceHarness(request.harness);
    await appendPreflightEvidence(context.stateDir, result, {
      delivery: "cli",
      ...(harness ? { harness } : {})
    });
    context.stdout(options.compactJson
      ? `${JSON.stringify(toCompactPreflight(result))}\n`
      : options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderPreflightHuman(result)
    );
    return 0;
  } catch (error) {
    context.stderr(
      `${terminalSafeText(error instanceof Error ? error.message : String(error))}\n`
    );
    return 1;
  }
}
