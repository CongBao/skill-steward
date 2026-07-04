import {
  scanInventory,
  scanPortfolio,
  type SkillRoot
} from "@skill-steward/engine";
import { renderJson, renderMarkdown } from "@skill-steward/report";
import { readLatestReport, writeLatestReport } from "@skill-steward/store";
import type { CliContext } from "../context.js";

export async function scanCommand(
  options: { roots: string[]; json: boolean; strict: boolean },
  context: CliContext
): Promise<number> {
  const previous = await readLatestReport(context.stateDir);
  const report = options.roots.length > 0
    ? await scanPortfolio(options.roots.map((path): SkillRoot => ({
        path,
        scope: "unknown",
        visibleTo: ["unknown"]
      })))
    : await scanInventory({ home: context.home, cwd: context.cwd });
  await writeLatestReport(context.stateDir, report);
  context.stdout(options.json ? renderJson(report) : renderMarkdown(report));

  const severe = report.findings.some(
    (finding) =>
      finding.severity === "error" || finding.severity === "critical"
  );
  if (options.strict && severe) return 2;
  if (previous?.portfolioFingerprint === report.portfolioFingerprint) {
    context.stderr("Portfolio unchanged.\n");
  }
  return 0;
}
