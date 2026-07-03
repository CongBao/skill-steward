import { readFile } from "node:fs/promises";
import {
  portfolioReportSchema,
  type PortfolioReport
} from "@skill-steward/engine";
import {
  diffReports,
  readLatestReport,
  readPreviousReport
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import type { ReportFormat } from "./report.js";

export function renderDiff(
  before: PortfolioReport,
  after: PortfolioReport,
  format: ReportFormat
): string {
  const diff = diffReports(before, after);
  if (format === "json") return `${JSON.stringify(diff, null, 2)}\n`;
  return [
    "# Portfolio Diff",
    "",
    `- Added: ${diff.added.join(", ") || "none"}`,
    `- Changed: ${diff.changed.join(", ") || "none"}`,
    `- Removed: ${diff.removed.join(", ") || "none"}`,
    ""
  ].join("\n");
}

export async function diffCommand(
  beforePath: string | undefined,
  format: ReportFormat,
  context: CliContext
): Promise<number> {
  const latest = await readLatestReport(context.stateDir);
  if (!latest) {
    context.stderr("No saved report. Run 'skill-steward scan' first.\n");
    return 1;
  }

  const before = beforePath
    ? portfolioReportSchema.parse(
        JSON.parse(await readFile(beforePath, "utf8"))
      )
    : await readPreviousReport(context.stateDir);
  if (!before) {
    context.stderr(
      "No previous report. Run another changed scan or pass --before <report.json>.\n"
    );
    return 1;
  }

  context.stdout(renderDiff(before, latest, format));
  return 0;
}
