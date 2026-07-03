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
}

export interface InstallationPlanResult {
  id: string;
  status: "ready" | "conflict" | "noop";
  action: "create" | "replace" | "cancel" | "none";
  destination: string;
  expectedDestinationFingerprint?: string | null;
  changes: Array<{ operation: "backup" | "create"; path: string }>;
}

export interface InstallationTransaction {
  id: string;
  status: "installed" | "rolled-back";
  destination?: string;
  backupDirectory?: string | null;
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
