export const INSTALLER_HARNESSES = [
  "agents", "amazon-q", "antigravity", "auggie", "bob", "claude", "cline",
  "codebuddy", "codex", "forgecode", "continue", "costrict", "crush", "cursor",
  "factory", "gemini", "github-copilot", "iflow", "junie", "kilocode", "kimi",
  "kiro", "lingma", "vibe", "opencode", "pi", "qoder", "qwen", "roocode",
  "trae", "windsurf"
] as const;

export type InstallerHarness = (typeof INSTALLER_HARNESSES)[number];

const candidateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/u;

export interface InstallerRouteRequest {
  requested: boolean;
  candidateId: string | null;
  harness: InstallerHarness | null;
}

function isInstallerHarness(value: string): value is InstallerHarness {
  return (INSTALLER_HARNESSES as readonly string[]).includes(value);
}

export function installerSearch(candidateId: string, harness: string): string {
  if (!candidateIdPattern.test(candidateId) || !isInstallerHarness(harness)) return "";
  return `?${new URLSearchParams({ installCandidate: candidateId, harness }).toString()}`;
}

export function parseInstallerRoute(search: string): InstallerRouteRequest {
  const params = new URLSearchParams(search);
  const candidates = params.getAll("installCandidate");
  const harnesses = params.getAll("harness");
  const candidate = candidates.length === 1 ? candidates[0] ?? "" : "";
  const harness = harnesses.length === 1 ? harnesses[0] ?? "" : "";
  return {
    requested: params.has("installCandidate") || params.has("harness"),
    candidateId: candidateIdPattern.test(candidate) ? candidate : null,
    harness: isInstallerHarness(harness) ? harness : null
  };
}

export function orderedInstallerHarnesses(compatibleHarnesses: readonly string[]): InstallerHarness[] {
  const compatible = INSTALLER_HARNESSES.filter((harness) => compatibleHarnesses.includes(harness));
  return [
    ...compatible,
    ...INSTALLER_HARNESSES.filter((harness) => !compatible.includes(harness))
  ];
}

export function initialInstallerHarness(
  requestedHarness: InstallerHarness | null,
  compatibleHarnesses: readonly string[]
): InstallerHarness | "" {
  if (!requestedHarness) return "";
  return compatibleHarnesses.length === 0 || compatibleHarnesses.includes(requestedHarness)
    ? requestedHarness
    : "";
}
