import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  discoverSkills,
  scanInventory,
  scanPortfolio,
  standardRoots,
  type FindingLabel,
  type PortfolioReport,
  type SkillRoot
} from "@skill-steward/engine";
import {
  buildDashboardSnapshot,
  calculateHealth,
  type DashboardSnapshot,
  type HistorySummary,
  type RootStatus
} from "@skill-steward/insights";
import {
  appendFindingLabel,
  readLatestReport,
  readPreviousReport,
  readReportHistory,
  writeLatestReport
} from "@skill-steward/store";

export type FindingLabelValue = FindingLabel["label"];

export interface DashboardServices {
  dashboard(): Promise<DashboardSnapshot>;
  latestReport(): Promise<PortfolioReport | undefined>;
  scan(roots: string[]): Promise<DashboardSnapshot>;
  history(): Promise<HistorySummary[]>;
  roots(): Promise<RootStatus[]>;
  labelFinding(
    findingId: string,
    label: FindingLabelValue,
    comment?: string
  ): Promise<void>;
}

export interface DashboardServiceOptions {
  stateDirectory: string;
  home: string;
  cwd: string;
  now?: () => Date;
}

function summarize(report: PortfolioReport): HistorySummary {
  return {
    generatedAt: report.generatedAt,
    healthScore: calculateHealth(report.findings).score,
    skillCount: report.skills.length,
    findingCount: report.findings.length,
    estimatedTokens: report.skills.reduce(
      (total, skill) => total + skill.estimatedTokens,
      0
    )
  };
}

async function inspectRoot(root: SkillRoot): Promise<RootStatus> {
  let available = false;
  let readable = false;
  try {
    available = (await stat(root.path)).isDirectory();
    await access(root.path, constants.R_OK);
    readable = true;
  } catch {
    // Missing and unreadable roots are valid status entries.
  }
  const skills = readable ? await discoverSkills([root]) : [];
  return {
    harness: root.visibleTo[0] ?? "unknown",
    visibleTo: [...root.visibleTo],
    scope: root.scope,
    path: root.path,
    available,
    readable,
    skillCount: skills.length
  };
}

export function createDashboardServices(
  options: DashboardServiceOptions
): DashboardServices {
  const now = options.now ?? (() => new Date());
  const standard = () => standardRoots({ home: options.home, cwd: options.cwd });

  const history = async () =>
    (await readReportHistory(options.stateDirectory)).map(summarize);
  const roots = async () => Promise.all(standard().map(inspectRoot));
  const dashboard = async () =>
    buildDashboardSnapshot({
      latest: await readLatestReport(options.stateDirectory),
      previous: await readPreviousReport(options.stateDirectory),
      history: await history(),
      roots: await roots()
    });

  return {
    dashboard,
    latestReport: () => readLatestReport(options.stateDirectory),
    async scan(paths) {
      const report = paths.length
        ? await scanPortfolio(paths.map((path): SkillRoot => ({
            path,
            scope: "unknown",
            visibleTo: ["unknown"]
          })), now())
        : await scanInventory({ home: options.home, cwd: options.cwd }, now());
      await writeLatestReport(options.stateDirectory, report);
      return dashboard();
    },
    history,
    roots,
    async labelFinding(findingId, label, comment) {
      const report = await readLatestReport(options.stateDirectory);
      if (!report?.findings.some(({ id }) => id === findingId)) {
        throw new Error("Finding does not exist in the latest report");
      }
      await appendFindingLabel(options.stateDirectory, {
        findingId,
        label,
        createdAt: now().toISOString(),
        ...(comment ? { comment } : {})
      });
    }
  };
}
