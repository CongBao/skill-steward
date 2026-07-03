import type { Finding, Severity } from "@skill-steward/engine";

const severityWeights: Record<Severity, number> = {
  critical: 25,
  error: 12,
  warning: 5,
  info: 1
};

export interface HealthResult {
  score: number;
  deductions: Record<Severity, number>;
}

export function calculateHealth(
  findings: Array<Pick<Finding, "severity">>
): HealthResult {
  const deductions: Record<Severity, number> = {
    critical: 0,
    error: 0,
    warning: 0,
    info: 0
  };

  for (const finding of findings) {
    deductions[finding.severity] += severityWeights[finding.severity];
  }

  const total = Object.values(deductions).reduce(
    (sum, deduction) => sum + deduction,
    0
  );

  return {
    score: Math.max(0, 100 - total),
    deductions
  };
}
