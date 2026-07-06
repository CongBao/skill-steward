import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { harnessIdSchema, scanInventory } from "@skill-steward/engine";
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

export interface PreflightCommandDependencies {
  writeReport: typeof writeLatestReport;
  appendEvidence: typeof appendPreflightEvidence;
}

const preflightCommandDefaults: PreflightCommandDependencies = {
  writeReport: writeLatestReport,
  appendEvidence: appendPreflightEvidence
};

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
  NEGATIVE_TRIGGER: "Explicit exclusion",
  CAPABILITY_MATCH: "Capability match",
  EXACT_TRIGGER_MATCH: "Exact capability trigger",
  MARGINAL_CAPABILITY: "Distinct capability",
  REDUNDANT_CAPABILITY: "Capability overlap"
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
  "REDUNDANT_CAPABILITY",
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

function explicitInstallHarness(value: string | undefined): string | undefined {
  const parsed = harnessIdSchema.safeParse(value);
  return parsed.success && parsed.data !== "unknown" ? parsed.data : undefined;
}

function installPreviewScope(
  candidate: PreflightResult["candidates"][number]
): { label: string; arguments: string } {
  if (candidate.scope === "global") {
    return { label: "Global reviewed preview", arguments: "--scope global" };
  }
  return {
    label: candidate.scope === "project"
      ? "Project reviewed preview"
      : "Project reviewed preview (unknown candidate scope; current workspace only)",
    arguments: "--scope project"
  };
}

const harnessDisplayNames: Readonly<Record<string, string>> = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
  "github-copilot": "GitHub Copilot CLI"
});

function duplicateCandidateDisplayNames(
  candidates: PreflightResult["candidates"]
): ReadonlyMap<string, string> {
  const byName = new Map<string, PreflightResult["candidates"]>();
  for (const candidate of candidates) {
    const group = byName.get(candidate.name) ?? [];
    group.push(candidate);
    byName.set(candidate.name, group);
  }

  const displayNames = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      displayNames.set(group[0]!.candidateId, name);
      continue;
    }
    const qualifierFor = (candidate: PreflightResult["candidates"][number]) =>
      candidate.availability === "available" && candidate.source
        ? `catalog ${candidate.source.sourceId}`
        : candidate.compatibleHarnesses.length > 0
          ? candidate.compatibleHarnesses
              .map((harness) => harnessDisplayNames[harness] ?? harness)
              .join(", ")
          : candidate.availability;
    const qualifiers = group.map(qualifierFor);
    for (const [index, candidate] of group.entries()) {
      const qualifier = qualifiers[index]!;
      const sameQualifierIndex = qualifiers
        .slice(0, index + 1)
        .filter((value) => value === qualifier).length;
      const sameQualifierCount = qualifiers.filter((value) => value === qualifier).length;
      displayNames.set(
        candidate.candidateId,
        `${name} [${qualifier}${sameQualifierCount > 1 ? ` ${sameQualifierIndex}` : ""}]`
      );
    }
  }
  return displayNames;
}

export function renderPreflightHuman(
  result: PreflightResult,
  options: { feedbackAvailable?: boolean; harness?: string } = {}
): string {
  const selected = result.candidates.filter(({ decision }) => decision === "use");
  const install = result.candidates.filter(({ decision }) => decision === "install");
  const excluded = result.candidates.filter(
    ({ decision }) => decision === "excluded"
  );
  const displayNames = duplicateCandidateDisplayNames(result.candidates);
  const installHarness = explicitInstallHarness(options.harness);
  const lines = ["Task Preflight", `Run ID: ${result.id}`, "", "Use now:"];
  if (selected.length === 0) {
    lines.push("- none matched the deterministic relevance threshold");
  } else {
    for (const candidate of selected) {
      lines.push(
        `- ${terminalSafeText(
          displayNames.get(candidate.candidateId) ?? candidate.name
        )} — relevance ${percentage(candidate.relevance)}, ` +
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
        `- ${terminalSafeText(
          displayNames.get(candidate.candidateId) ?? candidate.name
        )} — relevance ${percentage(candidate.relevance)}, ` +
        `${candidate.contextTokens} estimated tokens`
      );
      const candidateId = terminalSafeText(candidate.candidateId);
      lines.push(`  Candidate ID: ${candidateId}`);
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
      if (installHarness) {
        const previewScope = installPreviewScope(candidate);
        lines.push(
          `  ${previewScope.label}:`,
          `  skill-steward install --catalog-candidate ${candidateId} ` +
          `--harness ${terminalSafeText(installHarness)} ${previewScope.arguments} ` +
          `--preflight ${terminalSafeText(result.id)}`
        );
      } else {
        lines.push(
          "  Next: rerun Preflight with --harness <id> to get a reviewed install preview."
        );
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
      lines.push(
        `- ${terminalSafeText(displayNames.get(candidate.candidateId) ?? candidate.name)}: ` +
        terminalSafeText(exclusionReason(candidate))
      );
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
    `Estimated context saved: ${result.estimatedContextSaved} tokens`
  );
  if (options.feedbackAvailable === false) {
    lines.push(
      "",
      "Feedback unavailable: this run could not be saved to the private state directory.",
      ""
    );
  } else {
    lines.push(
      "",
      "Record feedback:",
      `skill-steward evidence feedback --preflight ${result.id} --label useful`,
      ""
    );
  }
  return lines.join("\n");
}

export async function preflightCommand(
  options: PreflightCommandOptions,
  context: CliContext,
  dependencyOverrides: Partial<PreflightCommandDependencies> = {}
): Promise<number> {
  const dependencies = { ...preflightCommandDefaults, ...dependencyOverrides };
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
    const persistence = await Promise.allSettled([
      dependencies.writeReport(context.stateDir, report),
      dependencies.appendEvidence(context.stateDir, result, {
        delivery: "cli",
        ...(harness ? { harness } : {})
      })
    ]);
    const persistenceAvailable = persistence.every(({ status }) => status === "fulfilled");
    const evidenceAvailable = persistence[1]?.status === "fulfilled";
    if (!persistenceAvailable) {
      const unavailable = [
        ...(persistence[0]?.status === "rejected" ? ["portfolio cache"] : []),
        ...(persistence[1]?.status === "rejected" ? ["evidence"] : [])
      ];
      const subject = unavailable.length === 2
        ? "portfolio cache and evidence were"
        : `${unavailable[0]} was`;
      context.stderr(
        `PREFLIGHT_PERSISTENCE_UNAVAILABLE: ${subject} not saved; ` +
        (evidenceAvailable
          ? "recommendations remain valid for this run, and evidence feedback remains available.\n"
          : "recommendations remain valid for this run, but feedback cannot be recorded.\n")
      );
    }
    const compact = options.compactJson
      ? toCompactPreflight(result, !persistenceAvailable
          ? {
              additionalConflictWarningCodes: ["PREFLIGHT_PERSISTENCE_UNAVAILABLE"],
              feedbackAvailable: evidenceAvailable
            }
          : { feedbackAvailable: true })
      : undefined;
    context.stdout(options.compactJson
      ? `${JSON.stringify(compact)}\n`
      : options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderPreflightHuman(result, {
            feedbackAvailable: evidenceAvailable,
            ...(request.harness ? { harness: request.harness } : {})
          })
    );
    return 0;
  } catch (error) {
    context.stderr(
      `${terminalSafeText(error instanceof Error ? error.message : String(error))}\n`
    );
    return 1;
  }
}
