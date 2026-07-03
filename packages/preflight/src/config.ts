export const PREFLIGHT_CONFIG = Object.freeze({
  taskCoverageWeight: 0.55,
  skillPrecisionWeight: 0.25,
  nameMatchWeight: 0.1,
  projectScopeWeight: 0.1,
  plausibleThreshold: 0.18,
  coverageTarget: 0.8,
  marginalThreshold: 0.12,
  installPenalty: 0.08,
  availableMarginalThreshold: 0.18,
  projectedCoverageTarget: 0.85,
  maxAvailableSkills: 3,
  maxCapabilityGaps: 6,
  redundancyWeight: 0.35,
  riskWeights: Object.freeze({
    critical: 0.4,
    error: 0.2,
    warning: 0.07,
    info: 0.02
  })
});
