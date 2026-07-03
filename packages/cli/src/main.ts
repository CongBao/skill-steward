#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import { defaultContext, type CliContext } from "./context.js";
import {
  catalogAddCommand,
  catalogEnableCommand,
  catalogListCommand,
  catalogRefreshCommand,
  catalogRemoveCommand
} from "./commands/catalog.js";
import {
  dashboardCommand,
  dashboardPort
} from "./commands/dashboard.js";
import { discoverCommand } from "./commands/discover.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import {
  evidenceCompactCommand,
  evidenceEraseCommand,
  evidenceExportCommand,
  evidenceFeedbackCommand,
  evidencePolicyCommand,
  evidencePolicySetCommand,
  evidenceSummaryCommand
} from "./commands/evidence.js";
import {
  governHistoryCommand,
  governQuarantineCommand,
  governRestoreCommand
} from "./commands/govern.js";
import { labelCommand } from "./commands/label.js";
import {
  hookLifecycleCommand,
  hookObserveCommand,
  hookPromptCommand
} from "./commands/hook.js";
import {
  integrateApplyCommand,
  integratePlanCommand,
  integrateRemoveCommand,
  integrateStatusCommand
} from "./commands/integrate.js";
import { catalogInstallCommand } from "./commands/install.js";
import {
  explainCommand,
  reportCommand,
  type ReportFormat
} from "./commands/report.js";
import { scanCommand } from "./commands/scan.js";
import { preflightCommand } from "./commands/preflight.js";

function reportFormat(input: string): ReportFormat {
  if (input === "markdown" || input === "json") return input;
  throw new Error(`Invalid format '${input}'. Use 'markdown' or 'json'.`);
}

export async function run(
  argv: string[],
  context: CliContext = defaultContext()
): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name("skill-steward")
    .description("Inspect and improve local Agent Skills portfolios")
    .version(packageMetadata.version)
    .exitOverride();

  const catalog = program
    .command("catalog")
    .description("Manage local metadata indexes for public Skill sources");

  catalog
    .command("list")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await catalogListCommand(options.json, context);
    });

  const hook = program
    .command("hook")
    .description("Run fail-open Harness Hook protocols");

  hook
    .command("prompt")
    .requiredOption("--harness <id>", "codex or claude-code")
    .action(async (options: { harness: string }) => {
      exitCode = await hookPromptCommand(options.harness, context);
    });

  hook
    .command("lifecycle")
    .requiredOption("--harness <id>", "codex or claude-code")
    .action(async (options: { harness: string }) => {
      exitCode = await hookLifecycleCommand(options.harness, context);
    });

  hook
    .command("observe")
    .requiredOption("--harness <id>", "github-copilot")
    .requiredOption("--event <name>", "userPromptSubmitted or sessionEnd")
    .action(async (options: { harness: string; event: string }) => {
      exitCode = await hookObserveCommand(options.harness, options.event, context);
    });

  const integrate = program
    .command("integrate")
    .description("Plan and manage Harness preflight integrations");

  const evidence = program
    .command("evidence")
    .description("Inspect and manage private local recommendation evidence");

  const evidencePolicy = evidence
    .command("policy")
    .description("Show the local evidence policy")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await evidencePolicyCommand(options.json, context);
    });

  evidencePolicy
    .command("set")
    .option("--mode <mode>", "minimal or learning")
    .option("--retention-days <number>")
    .option("--max-events <number>")
    .option("--plan <id>", "apply an exact reviewed policy plan")
    .option("--confirm", "apply the reviewed policy plan", false)
    .option("--json", "JSON output", false)
    .action(async (options: {
      mode?: string;
      retentionDays?: string;
      maxEvents?: string;
      plan?: string;
      confirm: boolean;
      json: boolean;
    }) => {
      exitCode = await evidencePolicySetCommand({
        ...options,
        json: options.json || Boolean(evidencePolicy.opts().json)
      }, context);
    });

  evidence
    .command("summary")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await evidenceSummaryCommand(options.json, context);
    });

  evidence
    .command("feedback")
    .requiredOption("--preflight <id>")
    .requiredOption("--label <label>", "useful, incomplete, or incorrect")
    .option("--candidate <id...>", "complete correct candidate set IDs", [])
    .option("--json", "JSON output", false)
    .action(async (options: {
      preflight: string;
      label: string;
      candidate: string[];
      json: boolean;
    }) => {
      exitCode = await evidenceFeedbackCommand({
        preflight: options.preflight,
        label: options.label,
        candidates: options.candidate,
        json: options.json
      }, context);
    });

  evidence
    .command("export")
    .requiredOption("--output <path>")
    .option("--replace", "replace an existing export", false)
    .action(async (options: { output: string; replace: boolean }) => {
      exitCode = await evidenceExportCommand(options.output, options.replace, context);
    });

  evidence.command("compact").action(async () => {
    exitCode = await evidenceCompactCommand(context);
  });

  evidence
    .command("erase")
    .option("--plan <id>", "apply an exact reviewed evidence erase plan")
    .option("--confirm", "erase the reviewed evidence files", false)
    .option("--json", "JSON output", false)
    .action(async (options: { plan?: string; confirm: boolean; json: boolean }) => {
      exitCode = await evidenceEraseCommand(options, context);
    });

  const govern = program
    .command("govern")
    .description("Review and apply reversible Skill lifecycle actions");

  govern
    .command("quarantine")
    .option("--skill <id>")
    .option("--plan <id>", "apply an exact reviewed quarantine plan")
    .option("--confirm", "apply the reviewed quarantine", false)
    .option("--json", "JSON output", false)
    .action(async (options: {
      skill?: string;
      plan?: string;
      confirm: boolean;
      json: boolean;
    }) => {
      exitCode = await governQuarantineCommand(options, context);
    });

  govern
    .command("restore")
    .option("--transaction <id>")
    .option("--plan <id>", "apply an exact reviewed restore plan")
    .option("--confirm", "apply the reviewed restore", false)
    .option("--json", "JSON output", false)
    .action(async (options: {
      transaction?: string;
      plan?: string;
      confirm: boolean;
      json: boolean;
    }) => {
      exitCode = await governRestoreCommand(options, context);
    });

  govern
    .command("history")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await governHistoryCommand(options.json, context);
    });

  integrate
    .command("plan")
    .requiredOption("--harness <id>", "codex, claude-code, or github-copilot")
    .option("--json", "JSON output", false)
    .action(async (options: { harness: string; json: boolean }) => {
      exitCode = await integratePlanCommand(options.harness, options.json, context);
    });

  program
    .command("install")
    .description([
      "Install a catalog recommendation using one of two mutually exclusive modes.",
      "Preview: --catalog-candidate <id> --harness <id> --scope <scope>",
      "Apply: --plan <id> --confirm"
    ].join("\n"))
    .option("--catalog-candidate <id>", "catalog candidate ID to preview")
    .option("--harness <id>", "target Harness for preview")
    .option("--scope <scope>", "global or project")
    .option("--workspace <path>", "project workspace path")
    .option("--preflight <id>", "link an explicit Task Preflight recommendation")
    .option("--target-name <name>", "installed directory name")
    .option("--replace", "replace a differing destination with backup", false)
    .option("--plan <id>", "apply an exact reviewed installation plan")
    .option("--confirm", "confirm the reviewed installation", false)
    .option("--json", "JSON output", false)
    .action(async (options: {
      catalogCandidate?: string;
      harness?: string;
      scope?: string;
      workspace?: string;
      preflight?: string;
      targetName?: string;
      replace: boolean;
      plan?: string;
      confirm: boolean;
      json: boolean;
    }) => {
      exitCode = await catalogInstallCommand(options, context);
    });

  integrate
    .command("apply")
    .description("Apply one exact reviewed integration plan")
    .option("--plan <id>", "reviewed integration plan ID")
    .option("--harness <id>", "not accepted with reviewed-plan apply")
    .option("--confirm", "confirm the reviewed integration plan", false)
    .option("--json", "JSON output", false)
    .action(async (options: {
      plan?: string;
      harness?: string;
      confirm: boolean;
      json: boolean;
    }) => {
      exitCode = await integrateApplyCommand(options, context);
    });

  integrate
    .command("status")
    .option("--harness <id>", "codex, claude-code, or github-copilot")
    .option("--json", "JSON output", false)
    .action(async (options: { harness?: string; json: boolean }) => {
      exitCode = await integrateStatusCommand(options.harness, options.json, context);
    });

  integrate
    .command("remove")
    .requiredOption("--harness <id>", "codex, claude-code, or github-copilot")
    .option("--confirm", "confirm integration removal", false)
    .action(async (options: { harness: string; confirm: boolean }) => {
      exitCode = await integrateRemoveCommand(options.harness, options.confirm, context);
    });

  catalog
    .command("add")
    .requiredOption("--id <id>")
    .requiredOption("--name <name>")
    .requiredOption("--url <url>")
    .option("--ref <ref>")
    .option("--subdirectory <path>")
    .option("--json", "JSON output", false)
    .action(async (options: {
      id: string;
      name: string;
      url: string;
      ref?: string;
      subdirectory?: string;
      json: boolean;
    }) => {
      exitCode = await catalogAddCommand(options, context);
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    catalog.command(name)
      .argument("<id>")
      .option("--json", "JSON output", false)
      .action(async (id: string, options: { json: boolean }) => {
        exitCode = await catalogEnableCommand(id, enabled, options.json, context);
      });
  }

  catalog
    .command("remove")
    .argument("<id>")
    .option("--confirm", "confirm source removal", false)
    .action(async (id: string, options: { confirm: boolean }) => {
      exitCode = await catalogRemoveCommand(id, options.confirm, context);
    });

  catalog
    .command("refresh")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await catalogRefreshCommand(options.json, context);
    });

  program
    .command("dashboard")
    .description("Launch the local Skill Steward dashboard")
    .option("--port <number>", "loopback port; 0 chooses an available port", dashboardPort, 4762)
    .option("--no-open", "do not open the system browser")
    .action(async (options: { port: number; open: boolean }) => {
      exitCode = await dashboardCommand(options, context);
    });

  program
    .command("discover")
    .option("--root <path...>", "skill roots", [])
    .option("--json", "JSON output", false)
    .action(async (options: { root: string[]; json: boolean }) => {
      exitCode = await discoverCommand(
        { roots: options.root, json: options.json },
        context
      );
    });

  program
    .command("scan")
    .option("--root <path...>", "skill roots", [])
    .option("--json", "JSON output", false)
    .option("--strict", "exit 2 for severe findings", false)
    .action(
      async (options: { root: string[]; json: boolean; strict: boolean }) => {
        exitCode = await scanCommand(
          {
            roots: options.root,
            json: options.json,
            strict: options.strict
          },
          context
        );
      }
    );

  program
    .command("report")
    .option("--format <format>", "markdown or json", "markdown")
    .option("--output <path>")
    .action(async (options: { format: string; output?: string }) => {
      exitCode = await reportCommand(
        {
          format: reportFormat(options.format),
          ...(options.output ? { output: options.output } : {})
        },
        context
      );
    });

  program
    .command("diff")
    .option("--before <path>")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (options: { before?: string; format: string }) => {
      exitCode = await diffCommand(
        options.before,
        reportFormat(options.format),
        context
      );
    });

  program
    .command("explain")
    .argument("<finding-id>")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (id: string, options: { format: string }) => {
      exitCode = await explainCommand(
        id,
        reportFormat(options.format),
        context
      );
    });

  program
    .command("label")
    .argument("<finding-id>")
    .argument("<label>")
    .option("--comment <text>")
    .action(
      async (
        id: string,
        label: string,
        options: { comment?: string }
      ) => {
        const allowed = [
          "useful",
          "incorrect",
          "unclear",
          "already-known"
        ] as const;
        const validLabel = allowed.find((candidate) => candidate === label);
        if (!validLabel) {
          context.stderr(`Invalid label '${label}'.\n`);
          exitCode = 1;
          return;
        }
        exitCode = await labelCommand(id, validLabel, options.comment, context);
      }
    );

  program
    .command("preflight")
    .description("Recommend a minimal set of Skills for a task")
    .option("--task <text>", "task text")
    .option("--task-file <path>", "read task text from a UTF-8 file")
    .option("--stdin", "read task text from stdin", false)
    .option("--max-skills <number>", "maximum recommended Skills", "5")
    .option("--harness <id>", "target Harness ID")
    .option("--include-available", "include locally indexed catalog candidates", true)
    .option("--installed-only", "exclude not-yet-installed candidates", false)
    .option("--json", "JSON output", false)
    .action(
      async (options: {
        task?: string;
        taskFile?: string;
        stdin: boolean;
        maxSkills: string;
        harness?: string;
        includeAvailable: boolean;
        installedOnly: boolean;
        json: boolean;
      }) => {
        exitCode = await preflightCommand(
          {
            ...(options.task ? { task: options.task } : {}),
            ...(options.taskFile ? { taskFile: options.taskFile } : {}),
            stdin: options.stdin,
            maxSkills: Number(options.maxSkills),
            ...(options.harness ? { harness: options.harness } : {}),
            includeAvailable: options.installedOnly ? false : options.includeAvailable,
            json: options.json
          },
          context
        );
      }
    );

  program
    .command("doctor")
    .option("--json", "JSON output", false)
    .action(async (options: { json: boolean }) => {
      exitCode = await doctorCommand(options.json, context);
    });

  try {
    await program.parseAsync(["node", "skill-steward", ...argv]);
    return exitCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.version" ||
        error.code === "commander.helpDisplayed")
    ) {
      return exitCode;
    }
    context.stderr(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

async function isMainModule(entryPath: string): Promise<boolean> {
  try {
    return (
      (await realpath(entryPath)) ===
      (await realpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && (await isMainModule(process.argv[1]))) {
  process.exitCode = await run(process.argv.slice(2));
}
