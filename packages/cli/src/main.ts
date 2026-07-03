#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import { defaultContext, type CliContext } from "./context.js";
import {
  dashboardCommand,
  dashboardPort
} from "./commands/dashboard.js";
import { discoverCommand } from "./commands/discover.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { labelCommand } from "./commands/label.js";
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
    .option("--json", "JSON output", false)
    .action(
      async (options: {
        task?: string;
        taskFile?: string;
        stdin: boolean;
        maxSkills: string;
        json: boolean;
      }) => {
        exitCode = await preflightCommand(
          {
            ...(options.task ? { task: options.task } : {}),
            ...(options.taskFile ? { taskFile: options.taskFile } : {}),
            stdin: options.stdin,
            maxSkills: Number(options.maxSkills),
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
