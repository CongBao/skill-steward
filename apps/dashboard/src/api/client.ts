export interface ApiEnvelope<T> {
  data: T | null;
  error: null | { code: string; message: string };
  meta: { apiVersion: number };
}

export type SemanticStatus = "neutral" | "positive" | "attention" | "risk";

export interface KpiResult {
  id: string;
  value: number | Record<string, number> | Array<{ generatedAt: string; value: number }>;
  status: SemanticStatus;
  comparison?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: "global" | "project" | "unknown";
  visibleTo: string[];
  fingerprint: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  estimatedTokens: number;
}

export interface FindingSummary {
  id: string;
  code: string;
  severity: "info" | "warning" | "error" | "critical";
  skillIds: string[];
  summary: string;
  evidence: string[];
  recommendation: string;
  confidence: number;
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
  skills: SkillSummary[];
  priorityFindings: FindingSummary[];
  history: Array<{
    generatedAt: string;
    healthScore: number;
    skillCount: number;
    findingCount: number;
    estimatedTokens: number;
  }>;
  roots: Array<{
    harness: string;
    scope: string;
    path: string;
    available: boolean;
    readable: boolean;
    skillCount: number;
  }>;
}

function mutationToken(): string {
  const element = document.getElementById("__SKILL_STEWARD_BOOTSTRAP__");
  if (!element?.textContent) return "";
  try {
    const value = JSON.parse(element.textContent) as { mutationToken?: unknown };
    return typeof value.mutationToken === "string" ? value.mutationToken : "";
  } catch {
    return "";
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (method !== "GET") headers.set("X-Skill-Steward-Token", mutationToken());
  const response = await fetch(path, { ...init, method, headers });
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || envelope.error || envelope.data === null) {
    throw new Error(envelope.error?.message ?? `Request failed with ${response.status}`);
  }
  return envelope.data;
}

export function fetchDashboard(): Promise<DashboardSnapshot> {
  return apiRequest("/api/v1/dashboard");
}

export function runScan(): Promise<DashboardSnapshot> {
  return apiRequest("/api/v1/scans", {
    method: "POST",
    body: JSON.stringify({ roots: [] })
  });
}

export interface InstallCandidate {
  id: string;
  relativePath: string;
  name: string;
  description: string;
  fingerprint: string | null;
  files: Array<{ relativePath: string; bytes: number; sha256?: string }>;
  estimatedTokens: number;
  scripts: string[];
  executables: string[];
  findings: FindingSummary[];
}

export interface InspectionResult {
  previewId: string;
  expiresAt: number;
  source: Record<string, unknown>;
  candidates: InstallCandidate[];
  provenance?: InstallationProvenance;
}

export interface InstallationProvenance {
  preflightId: string;
  candidateId: string;
  sourceId: string;
  sourceRevision: string;
}

export interface InstallationPlanResult {
  id: string;
  status: "ready" | "conflict" | "noop";
  action: "create" | "replace" | "cancel" | "none";
  destination: string;
  expectedDestinationFingerprint?: string | null;
  changes: Array<{ operation: "backup" | "create"; path: string }>;
  provenance?: InstallationProvenance;
}

export interface InstallationTransaction {
  id: string;
  status: "installed" | "rolled-back";
  destination?: string;
  backupDirectory?: string | null;
  provenance?: InstallationProvenance;
}

export type PreflightReasonCode =
  | "TASK_TERM_MATCH"
  | "NAME_MATCH"
  | "PROJECT_SCOPE_FIT"
  | "UNIQUE_COVERAGE"
  | "REDUNDANT_WITH_SELECTED"
  | "LOW_RELEVANCE"
  | "PORTFOLIO_RISK"
  | "INSTALL_REQUIRED"
  | "CRITICAL_RISK"
  | "NEGATIVE_TRIGGER"
  | "HARNESS_INCOMPATIBLE";

export interface PreflightCandidate {
  candidateId: string;
  availability: "installed" | "available";
  installedSkillId?: string;
  catalogSkillId?: string;
  name: string;
  description: string;
  scope: "global" | "project" | "unknown";
  compatibleHarnesses: string[];
  compatibility: "declared" | "portable" | "unknown";
  scripts: string[];
  executables: string[];
  highestSeverity: FindingSummary["severity"] | null;
  relevance: number;
  uniqueCoverage: number;
  riskPenalty: number;
  redundancyPenalty: number;
  installPenalty: number;
  contextTokens: number;
  features: {
    taskCoverage: number;
    skillPrecision: number;
    nameMatch: boolean;
    projectScopeFit: boolean;
  };
  decision: "use" | "install" | "excluded";
  source?: {
    sourceId: string;
    trust: "vendor" | "community" | "user";
    url: string;
    revision: string;
    relativePath: string;
  };
  reasons: Array<{ code: PreflightReasonCode; detail: string }>;
}

export interface PreflightResult {
  schemaVersion: 3;
  algorithmVersion: 3;
  id: string;
  generatedAt: string;
  portfolioFingerprint: string;
  taskHash: string;
  taskCharacterCount: number;
  taskTermCount: number;
  useCandidateIds: string[];
  installCandidateIds: string[];
  candidates: PreflightCandidate[];
  conflicts: FindingSummary[];
  capabilityGaps: string[];
  installedCoverage: number;
  projectedCoverage: number;
  selectedContextTokens: number;
  plausibleContextTokens: number;
  estimatedContextSaved: number;
}

export function runPreflight(
  task: string,
  maxSkills: number,
  harness = "codex",
  includeAvailable = true
): Promise<PreflightResult> {
  return apiRequest("/api/v1/preflights", {
    method: "POST",
    body: JSON.stringify({ task, maxSkills, harness, includeAvailable })
  });
}

export function submitPreflightFeedback(
  id: string,
  label: "useful" | "incomplete" | "incorrect",
  candidateIds: string[]
): Promise<{ saved: boolean }> {
  return apiRequest(`/api/v1/preflights/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ label, candidateIds })
  });
}

export interface CatalogSource {
  id: string;
  name: string;
  kind: "git";
  url: string;
  ref?: string;
  subdirectory?: string;
  enabled: boolean;
  trust: "vendor" | "community" | "user";
  preset: boolean;
}

export interface CatalogSourceState {
  sourceId: string;
  status: "disabled" | "ready" | "stale" | "error";
  commitSha?: string;
  refreshedAt?: string;
  errorCode?: string;
  skillCount: number;
}

export interface CatalogSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sources: CatalogSourceState[];
  skills: unknown[];
}

export interface CatalogState {
  sources: CatalogSource[];
  snapshot: CatalogSnapshot | null;
}

export function fetchCatalogSources(): Promise<CatalogState> {
  return apiRequest("/api/v1/catalog/sources");
}

export function addCatalogSource(source: Pick<CatalogSource, "id" | "name" | "url" | "ref" | "subdirectory">): Promise<CatalogSource> {
  return apiRequest("/api/v1/catalog/sources", {
    method: "POST",
    body: JSON.stringify(source)
  });
}

export function setCatalogSourceEnabled(id: string, enabled: boolean): Promise<CatalogSource> {
  return apiRequest(`/api/v1/catalog/sources/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
    method: "POST"
  });
}

export function removeCatalogSource(id: string): Promise<{ removed: boolean }> {
  return apiRequest(`/api/v1/catalog/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function refreshCatalog(): Promise<CatalogSnapshot> {
  return apiRequest("/api/v1/catalog/refresh", { method: "POST" });
}

export function inspectCatalogCandidate(
  id: string,
  preflightId?: string
): Promise<InspectionResult & { catalogCandidateId: string }> {
  return apiRequest(`/api/v1/catalog/candidates/${encodeURIComponent(id)}/inspect-installation`, {
    method: "POST",
    ...(preflightId ? { body: JSON.stringify({ preflightId }) } : {})
  });
}

export type IntegrationHarness = "codex" | "claude-code" | "github-copilot";
export type IntegrationStatusValue = "not-installed" | "installed" | "needs-trust" | "drifted" | "invalid";

export interface IntegrationStatus {
  harness: IntegrationHarness;
  status: IntegrationStatusValue;
  targetPath: string;
  lastChangedAt?: string;
  message?: string;
}

export interface IntegrationPlan {
  id: string;
  harness: IntegrationHarness;
  targetPath: string;
  backupPath?: string;
  changes: Array<{ operation: "backup" | "write"; path: string }>;
}

export function fetchIntegrations(): Promise<IntegrationStatus[]> {
  return apiRequest("/api/v1/integrations");
}

export interface IntegrationCapability {
  harness: IntegrationHarness;
  displayName: string;
  mode: "recommend-and-observe" | "observe-only";
  promptInjection: boolean;
  observation: boolean;
  turnLifecycle: boolean;
  sessionLifecycle: boolean;
  events: string[];
  installScopes: Array<"global" | "project">;
  validationStatus: "fixture-tested";
}

export function fetchIntegrationCapabilities(): Promise<IntegrationCapability[]> {
  return apiRequest("/api/v1/integrations/capabilities");
}

export function planHarnessIntegration(harness: IntegrationHarness): Promise<IntegrationPlan> {
  return apiRequest(`/api/v1/integrations/${harness}/plan`, { method: "POST" });
}

export function applyHarnessIntegration(harness: IntegrationHarness): Promise<IntegrationStatus> {
  return apiRequest(`/api/v1/integrations/${harness}/apply`, { method: "POST" });
}

export function removeHarnessIntegration(harness: IntegrationHarness): Promise<IntegrationStatus> {
  return apiRequest(`/api/v1/integrations/${harness}`, { method: "DELETE" });
}

export function inspectInstallation(payload: unknown): Promise<InspectionResult> {
  return apiRequest("/api/v1/install-sources/inspect", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function requestInstallationPlan(payload: unknown): Promise<InstallationPlanResult> {
  return apiRequest("/api/v1/installations/plan", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function commitInstallation(planId: string): Promise<InstallationTransaction> {
  return apiRequest("/api/v1/installations/commit", {
    method: "POST",
    body: JSON.stringify({ planId, confirmed: true })
  });
}

export function fetchInstallationHistory(): Promise<InstallationTransaction[]> {
  return apiRequest("/api/v1/installations");
}

export function rollbackTransaction(id: string): Promise<InstallationTransaction> {
  return apiRequest(`/api/v1/installations/${encodeURIComponent(id)}/rollback`, {
    method: "POST"
  });
}

export type HistoryItem = DashboardSnapshot["history"][number];
export type RootItem = DashboardSnapshot["roots"][number];

export function fetchHistory(): Promise<HistoryItem[]> {
  return apiRequest("/api/v1/history");
}

export function fetchRoots(): Promise<RootItem[]> {
  return apiRequest("/api/v1/roots");
}

export function labelFinding(
  id: string,
  label: "useful" | "incorrect" | "unclear" | "already-known"
): Promise<{ saved: boolean }> {
  return apiRequest(`/api/v1/findings/${encodeURIComponent(id)}/labels`, {
    method: "POST",
    body: JSON.stringify({ label })
  });
}

export interface EvidenceMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface EvidenceMetrics {
  feedbackRate: EvidenceMetric;
  usefulRate: EvidenceMetric;
  incompleteRate: EvidenceMetric;
  incorrectRate: EvidenceMetric;
  correctionPrecision: EvidenceMetric;
  correctionRecall: EvidenceMetric;
  correctionF1: EvidenceMetric;
  installConversion: EvidenceMetric;
}

export interface EvidenceTotals {
  preflights: number;
  labeled: number;
  portfolios: number;
  events: number;
}

export interface EvidenceBreakdown {
  key: string;
  totals: EvidenceTotals;
  metrics: EvidenceMetrics;
}

export interface EvidenceSummary {
  schemaVersion: 1;
  generatedAt: string;
  period: { from: string | null; to: string | null };
  totals: EvidenceTotals;
  metrics: EvidenceMetrics;
  lifecycleReasons: Partial<Record<"complete" | "error" | "abort" | "timeout" | "user-exit" | "other", number>>;
  harnesses: EvidenceBreakdown[];
  algorithms: EvidenceBreakdown[];
  windows: { last7Days: EvidenceBreakdown; last30Days: EvidenceBreakdown };
  readiness: {
    status: "insufficient-evidence" | "ready-for-calibration";
    reasons: string[];
  };
}

export type EvidenceMode = "minimal" | "learning";

export interface EvidencePolicy {
  schemaVersion: 1;
  mode: EvidenceMode;
  retentionDays: number;
  maxEvents: number;
}

export interface EvidencePolicyPlan {
  schemaVersion: 1;
  id: string;
  before: EvidencePolicy;
  beforeFingerprint: string;
  after: EvidencePolicy;
  afterFingerprint: string;
  createdAt: string;
  expiresAt: string;
}

export interface EvidenceErasePlan {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  paths: Array<{
    kind: "preflights" | "events" | "salt";
    path: string;
    exists: boolean;
    fingerprint: string | null;
  }>;
}

export function fetchEvidenceSummary(): Promise<EvidenceSummary> {
  return apiRequest("/api/v1/evidence/summary");
}

export function fetchEvidencePolicy(): Promise<EvidencePolicy> {
  return apiRequest("/api/v1/evidence/policy");
}

export function planEvidencePolicy(change: Omit<EvidencePolicy, "schemaVersion">): Promise<EvidencePolicyPlan> {
  return apiRequest("/api/v1/evidence/policy/plan", {
    method: "POST",
    body: JSON.stringify(change)
  });
}

export function applyEvidencePolicy(planId: string): Promise<EvidencePolicy> {
  return apiRequest("/api/v1/evidence/policy/apply", {
    method: "POST",
    body: JSON.stringify({ planId })
  });
}

export function compactEvidence(): Promise<{ before: number; kept: number; removed: number }> {
  return apiRequest("/api/v1/evidence/compact", { method: "POST" });
}

export function planEvidenceErase(): Promise<EvidenceErasePlan> {
  return apiRequest("/api/v1/evidence/erase/plan", { method: "POST" });
}

export function applyEvidenceErase(planId: string): Promise<{ erased: true }> {
  return apiRequest("/api/v1/evidence/erase/apply", {
    method: "POST",
    body: JSON.stringify({ planId })
  });
}

export interface GovernanceAlias {
  harness: string;
  scope: "global" | "project" | "unknown";
  rootPath: string;
}

export type GovernanceOperation =
  | { operation: "copy-to-staging"; from: string; to: string }
  | { operation: "verify-staging"; path: string; fingerprint: string }
  | { operation: "move-active-to-rollback"; from: string; to: string }
  | { operation: "commit-vault"; from: string; to: string }
  | { operation: "restore-active"; from: string; to: string }
  | { operation: "append-journal"; transactionId: string }
  | { operation: "cleanup-rollback"; path: string }
  | { operation: "cleanup-vault"; path: string };

export interface GovernancePlan {
  schemaVersion: 1;
  id: string;
  kind: "quarantine" | "restore";
  sourceTransactionId?: string;
  skillId: string;
  skillName?: string;
  activePath: string;
  vaultPath: string;
  stagingPath: string;
  rollbackPath?: string;
  sourceFingerprint: string;
  expectedDestinationFingerprint: string | null;
  visibleAliases: GovernanceAlias[];
  operations: GovernanceOperation[];
  createdAt: string;
  expiresAt: string;
}

export interface GovernanceTransaction {
  schemaVersion: 1;
  id: string;
  sourceTransactionId?: string;
  action: "quarantine" | "restore";
  status: "quarantined" | "restored" | "failed";
  skillId: string;
  skillName?: string;
  originalPath: string;
  vaultPath: string;
  fingerprint: string;
  visibleAliases: GovernanceAlias[];
  createdAt: string;
  failureBoundary?: "copy" | "verify" | "move" | "vault" | "journal" | "restore";
}

export interface GovernanceApplyResult {
  transaction: GovernanceTransaction;
  rescanRequired: true;
  cleanupPending: boolean;
}

export type GovernancePlanRequest =
  | { action: "quarantine"; skillId: string }
  | { action: "restore"; transactionId: string };

export function fetchGovernanceTransactions(): Promise<GovernanceTransaction[]> {
  return apiRequest("/api/v1/governance/transactions");
}

export function planGovernance(request: GovernancePlanRequest): Promise<GovernancePlan> {
  return apiRequest("/api/v1/governance/plans", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export function applyGovernancePlan(planId: string): Promise<GovernanceApplyResult> {
  return apiRequest(`/api/v1/governance/plans/${encodeURIComponent(planId)}/apply`, {
    method: "POST"
  });
}
