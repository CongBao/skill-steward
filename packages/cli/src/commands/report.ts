import { writeFile } from "node:fs/promises";
import { renderJson, renderMarkdown } from "@skill-steward/report";
import { readLatestReport } from "@skill-steward/store";
import type { CliContext } from "../context.js";

export type ReportFormat = "markdown" | "json";

export async function reportCommand(
  options: { format: ReportFormat; output?: string },
  context: CliContext
): Promise<number> {
  const report = await readLatestReport(context.stateDir);
  if (!report) {
    context.stderr("No saved report. Run 'skill-steward scan' first.\n");
    return 1;
  }

  const rendered =
    options.format === "json" ? renderJson(report) : renderMarkdown(report);
  if (options.output) await writeFile(options.output, rendered);
  else context.stdout(rendered);
  return 0;
}

export async function explainCommand(
  id: string,
  format: ReportFormat,
  context: CliContext
): Promise<number> {
  const report = await readLatestReport(context.stateDir);
  const finding = report?.findings.find((item) => item.id === id);
  if (!finding) {
    context.stderr(`Finding '${id}' does not exist in the latest report.\n`);
    return 1;
  }

  context.stdout(
    format === "json"
      ? `${JSON.stringify(finding, null, 2)}\n`
      : [
          `# ${finding.code}`,
          "",
          finding.summary,
          "",
          ...finding.evidence.map((item) => `- ${item}`),
          "",
          `Recommendation: ${finding.recommendation}`,
          ""
        ].join("\n")
  );
  return 0;
}
