import type {
  Finding,
  HarnessId,
  PortfolioReport,
  SkillScope
} from "@skill-steward/engine";
import { calculateHealth } from "./health.js";

export const KPI_IDS = [
  "health-score",
  "open-findings",
  "installed-skills",
  "estimated-context",
  "harness-coverage",
  "bundle-size",
  "tracked-files",
  "broken-references",
  "overlap-groups",
  "parse-failures",
  "scope-distribution",
  "portfolio-change",
  "health-trend",
  "largest-skill",
  "root-availability",
  "finding-confidence"
] as const;

export type KpiId = (typeof KPI_IDS)[number];

export const RECOMMENDED_KPI_IDS: KpiId[] = [
  "health-score",
  "open-findings",
  "installed-skills",
  "estimated-context",
  "harness-coverage"
];

export type KpiStatus = "neutral" | "positive" | "attention" | "risk";

export interface RootStatus {
  harness: HarnessId;
  scope: SkillScope;
  path: string;
  available: boolean;
  readable: boolean;
  skillCount: number;
}

export interface HistorySummary {
  generatedAt: string;
  healthScore: number;
  skillCount: number;
  findingCount: number;
  estimatedTokens: number;
}

export type KpiValue =
  | number
  | Record<string, number>
  | Array<{ generatedAt: string; value: number }>;

export interface KpiResult {
  id: KpiId;
  value: KpiValue;
  status: KpiStatus;
  comparison?: number;
}

export interface BuildKpiInput {
  latest: PortfolioReport;
  previous?: PortfolioReport;
  history: HistorySummary[];
  roots: RootStatus[];
}

function countFindings(findings: Finding[], codePart: string): number {
  return findings.filter(({ code }) => code.includes(codePart)).length;
}

function statusForFindings(findings: Finding[]): KpiStatus {
  if (findings.some(({ severity }) => severity === "critical" || severity === "error")) {
    return "risk";
  }
  return findings.some(({ severity }) => severity === "warning")
    ? "attention"
    : "positive";
}

export function buildKpis({
  latest,
  previous,
  history,
  roots
}: BuildKpiInput): KpiResult[] {
  const health = calculateHealth(latest.findings);
  const bytes = latest.skills.reduce(
    (total, skill) =>
      total + skill.files.reduce((skillTotal, file) => skillTotal + file.bytes, 0),
    0
  );
  const files = latest.skills.reduce((total, skill) => total + skill.files.length, 0);
  const tokens = latest.skills.reduce(
    (total, skill) => total + skill.estimatedTokens,
    0
  );
  const visibleHarnesses = new Set(
    latest.skills.flatMap(({ visibleTo }) =>
      visibleTo.filter((harness) => harness !== "unknown")
    )
  );
  const scopeDistribution: Record<SkillScope, number> = {
    global: 0,
    project: 0,
    unknown: 0
  };
  for (const skill of latest.skills) scopeDistribution[skill.scope] += 1;

  const largest = [...latest.skills].sort(
    (left, right) => right.estimatedTokens - left.estimatedTokens
  )[0];
  const confidence = latest.findings.length
    ? Math.round(
        (latest.findings.reduce((sum, finding) => sum + finding.confidence, 0) /
          latest.findings.length) *
          100
      )
    : 100;
  const availableRoots = roots.filter(({ available, readable }) => available && readable).length;
  const findingStatus = statusForFindings(latest.findings);

  return [
    {
      id: "health-score",
      value: health.score,
      status: health.score >= 90 ? "positive" : health.score >= 70 ? "attention" : "risk"
    },
    { id: "open-findings", value: latest.findings.length, status: findingStatus },
    { id: "installed-skills", value: latest.skills.length, status: "neutral" },
    { id: "estimated-context", value: tokens, status: "neutral" },
    { id: "harness-coverage", value: visibleHarnesses.size, status: "neutral" },
    { id: "bundle-size", value: bytes, status: "neutral" },
    { id: "tracked-files", value: files, status: "neutral" },
    {
      id: "broken-references",
      value: countFindings(latest.findings, "BROKEN_REFERENCE"),
      status: countFindings(latest.findings, "BROKEN_REFERENCE") ? "risk" : "positive"
    },
    {
      id: "overlap-groups",
      value: countFindings(latest.findings, "OVERLAP"),
      status: countFindings(latest.findings, "OVERLAP") ? "attention" : "positive"
    },
    {
      id: "parse-failures",
      value: countFindings(latest.findings, "PARSE"),
      status: countFindings(latest.findings, "PARSE") ? "risk" : "positive"
    },
    { id: "scope-distribution", value: scopeDistribution, status: "neutral" },
    {
      id: "portfolio-change",
      value: latest.skills.length,
      status: "neutral",
      comparison: previous ? latest.skills.length - previous.skills.length : 0
    },
    {
      id: "health-trend",
      value: history.map(({ generatedAt, healthScore }) => ({ generatedAt, value: healthScore })),
      status: "neutral"
    },
    {
      id: "largest-skill",
      value: { tokens: largest?.estimatedTokens ?? 0 },
      status: "neutral"
    },
    {
      id: "root-availability",
      value: { available: availableRoots, total: roots.length },
      status: availableRoots === roots.length ? "positive" : "attention"
    },
    {
      id: "finding-confidence",
      value: confidence,
      status: confidence >= 80 ? "positive" : "attention"
    }
  ];
}
