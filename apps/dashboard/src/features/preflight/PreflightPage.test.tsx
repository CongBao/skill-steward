import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  PreferencesProvider
} from "../../theme/preferences.js";
import { PreflightPage } from "./PreflightPage.js";

const result = {
  schemaVersion: 3,
  algorithmVersion: 2,
  id: "run-1",
  generatedAt: "2026-07-03T01:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  taskHash: `sha256:${"b".repeat(64)}`,
  taskCharacterCount: 45,
  taskTermCount: 7,
  useCandidateIds: ["security"],
  installCandidateIds: ["testing"],
  candidates: [
    {
      candidateId: "security",
      availability: "installed",
      installedSkillId: "security",
      name: "security-review",
      description: "Review security changes",
      scope: "project",
      compatibleHarnesses: ["codex"],
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.82,
      uniqueCoverage: 0.57,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0,
      contextTokens: 240,
      features: {
        taskCoverage: 0.82,
        skillPrecision: 0.6,
        nameMatch: true,
        projectScopeFit: true
      },
      decision: "use",
      reasons: [{ code: "UNIQUE_COVERAGE", detail: "57% unique task-term coverage." }]
    },
    {
      candidateId: "testing",
      availability: "available",
      catalogSkillId: "testing",
      name: "test-review",
      description: "Review missing tests",
      scope: "unknown",
      compatibleHarnesses: ["codex"],
      compatibility: "declared",
      scripts: ["scripts/check.sh"],
      executables: ["scripts/check.sh"],
      highestSeverity: "warning",
      relevance: 0.72,
      uniqueCoverage: 0.28,
      riskPenalty: 0.07,
      redundancyPenalty: 0,
      installPenalty: 0.08,
      contextTokens: 180,
      features: {
        taskCoverage: 0.72,
        skillPrecision: 0.5,
        nameMatch: false,
        projectScopeFit: false
      },
      decision: "install",
      source: {
        sourceId: "openai-plugins",
        trust: "vendor",
        url: "https://github.com/openai/plugins.git",
        revision: "c".repeat(40),
        relativePath: "testing"
      },
      reasons: [{ code: "INSTALL_REQUIRED", detail: "Approval required" }]
    },
    {
      candidateId: "resume",
      availability: "installed",
      installedSkillId: "resume",
      name: "resume-review",
      description: "Review resumes",
      scope: "global",
      compatibleHarnesses: ["codex"],
      compatibility: "declared",
      scripts: [],
      executables: [],
      highestSeverity: null,
      relevance: 0.1,
      uniqueCoverage: 0,
      riskPenalty: 0,
      redundancyPenalty: 0,
      installPenalty: 0,
      contextTokens: 300,
      features: {
        taskCoverage: 0.1,
        skillPrecision: 0.1,
        nameMatch: false,
        projectScopeFit: false
      },
      decision: "excluded",
      reasons: [{ code: "LOW_RELEVANCE", detail: "Low relevance" }]
    }
  ],
  conflicts: [],
  capabilityGaps: ["deployment"],
  installedCoverage: 0.57,
  projectedCoverage: 0.85,
  selectedContextTokens: 420,
  plausibleContextTokens: 600,
  estimatedContextSaved: 180
};

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><MemoryRouter>{children}</MemoryRouter></PreferencesProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<script id="__SKILL_STEWARD_BOOTSTRAP__" type="application/json">{"mutationToken":"test-token"}</script>';
});

function fetchMock() {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const data = url.includes("inspect-installation")
      ? {
          catalogCandidateId: "testing",
          previewId: "preview-1",
          expiresAt: 10_000,
          source: { kind: "git" },
          candidates: [{
            id: "root",
            relativePath: ".",
            name: "test-review",
            description: "Review missing tests",
            fingerprint: `sha256:${"d".repeat(64)}`,
            files: [], estimatedTokens: 180, scripts: [], executables: [], findings: []
          }]
        }
      : url.endsWith("/feedback")
        ? { saved: true }
        : result;
    return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
  });
}

describe("PreflightPage v2", () => {
  it("renders four decision groups and inspects available candidates", async () => {
    const user = userEvent.setup();
    const mockedFetch = fetchMock();
    vi.stubGlobal("fetch", mockedFetch);
    render(<PreflightPage />, { wrapper: wrapper() });
    await user.type(
      screen.getByRole("textbox", { name: "Task to analyze" }),
      "Review this TypeScript change for security and missing tests"
    );
    await user.click(screen.getByRole("button", { name: "Analyze task" }));

    expect(await screen.findByText("Use now")).toBeVisible();
    expect(screen.getByText("Consider installing")).toBeVisible();
    expect(screen.getByText("Capability gaps")).toBeVisible();
    expect(screen.getByText("deployment")).toBeVisible();
    expect(screen.getByText("Known publisher · not a safety guarantee")).toBeVisible();
    expect(screen.getByText("Excluded candidates (1)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect test-review installation" }));
    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/v1/catalog/candidates/testing/inspect-installation",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ preflightId: "run-1" })
      })
    );
  });

  it("submits feedback with candidate IDs", async () => {
    const user = userEvent.setup();
    const mockedFetch = fetchMock();
    vi.stubGlobal("fetch", mockedFetch);
    render(<PreflightPage />, { wrapper: wrapper() });
    await user.type(screen.getByRole("textbox", { name: "Task to analyze" }), "Review security and missing tests");
    await user.click(screen.getByRole("button", { name: "Analyze task" }));
    await screen.findByText("security-review");
    await user.click(screen.getByRole("button", { name: "Incomplete" }));
    await user.click(screen.getByRole("checkbox", { name: "Include resume-review" }));
    await user.click(screen.getByRole("button", { name: "Save feedback" }));
    const call = mockedFetch.mock.calls.find(([url]) => String(url).endsWith("/feedback"));
    expect(call?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        label: "incomplete",
        candidateIds: ["security", "testing", "resume"]
      })
    }));
  });

  it("localizes the discovery groups in Chinese", async () => {
    const user = userEvent.setup();
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      locale: "zh-CN"
    }));
    vi.stubGlobal("fetch", fetchMock());
    render(<PreflightPage />, { wrapper: wrapper() });
    await user.type(screen.getByRole("textbox", { name: "待分析任务" }), "检查代码安全问题和测试遗漏");
    await user.click(screen.getByRole("button", { name: "分析任务" }));
    expect(await screen.findByText("立即使用")).toBeVisible();
    expect(screen.getByText("建议安装")).toBeVisible();
    expect(screen.getByText("能力缺口")).toBeVisible();
  });
});
