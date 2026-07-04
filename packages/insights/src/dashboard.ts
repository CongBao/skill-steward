import {
  isVisibilityReport,
  type Finding,
  type InventorySource,
  type HarnessCoverage,
  type PortfolioReport,
  type SkillRecord,
  type SkillRecordV2
} from "@skill-steward/engine";
import {
  buildKpis,
  type HistorySummary,
  type KpiResult,
  type RootStatus
} from "./kpis.js";

export interface DashboardSnapshotInput {
  latest: PortfolioReport | undefined;
  previous: PortfolioReport | undefined;
  history: HistorySummary[];
  roots: RootStatus[];
}

export interface DashboardSnapshot {
  status: "first-run" | "ready";
  latest: null | {
    generatedAt: string;
    portfolioFingerprint: string;
    skillCount: number;
    findingCount: number;
  };
  kpis: KpiResult[];
  skills: Array<SkillRecord | SkillRecordV2>;
  priorityFindings: Finding[];
  history: HistorySummary[];
  roots: RootStatus[];
  inventory: null | {
    sources: InventorySource[];
    harnesses: HarnessCoverage[];
  };
}

const severityRank: Record<Finding["severity"], number> = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1
};

export function buildDashboardSnapshot({
  latest,
  previous,
  history,
  roots
}: DashboardSnapshotInput): DashboardSnapshot {
  if (!latest) {
    return {
      status: "first-run",
      latest: null,
      kpis: [],
      skills: [],
      priorityFindings: [],
      history,
      roots,
      inventory: null
    };
  }

  return {
    status: "ready",
    latest: {
      generatedAt: latest.generatedAt,
      portfolioFingerprint: latest.portfolioFingerprint,
      skillCount: latest.skills.length,
      findingCount: latest.findings.length
    },
    kpis: buildKpis({
      latest,
      ...(previous ? { previous } : {}),
      history,
      roots
    }),
    skills: latest.skills,
    priorityFindings: [...latest.findings]
      .sort((left, right) => severityRank[right.severity] - severityRank[left.severity])
      .slice(0, 5),
    history,
    roots,
    inventory: isVisibilityReport(latest) ? latest.inventory : null
  };
}
