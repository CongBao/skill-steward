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
  schemaVersion: 1,
  algorithmVersion: 1,
  id: "run-1",
  generatedAt: "2026-07-03T01:00:00.000Z",
  portfolioFingerprint: `sha256:${"a".repeat(64)}`,
  taskHash: `sha256:${"b".repeat(64)}`,
  taskCharacterCount: 45,
  taskTermCount: 7,
  selectedSkillIds: ["security"],
  candidates: [
    {
      skillId: "security",
      name: "security-review",
      description: "Review security changes",
      scope: "project",
      visibleTo: ["codex"],
      relevance: 0.82,
      uniqueCoverage: 0.57,
      riskPenalty: 0,
      redundancyPenalty: 0,
      contextTokens: 240,
      decision: "selected",
      reasons: [
        { code: "TASK_TERM_MATCH", detail: "review, security, change" },
        { code: "UNIQUE_COVERAGE", detail: "57% unique task-term coverage." }
      ]
    },
    {
      skillId: "testing",
      name: "test-review",
      description: "Review missing tests",
      scope: "global",
      visibleTo: ["claude"],
      relevance: 0.41,
      uniqueCoverage: 0,
      riskPenalty: 0.07,
      redundancyPenalty: 0.18,
      contextTokens: 180,
      decision: "excluded",
      reasons: [
        {
          code: "REDUNDANT_WITH_SELECTED",
          detail: "18% weighted overlap with the selected set."
        }
      ]
    }
  ],
  conflicts: [
    {
      id: "finding-1",
      code: "SCOPE_SHADOWING",
      severity: "warning",
      skillIds: ["security"],
      summary: "Skill is installed in multiple scopes.",
      evidence: ["global", "project"],
      recommendation: "Keep one copy.",
      confidence: 0.95
    }
  ],
  selectedContextTokens: 240,
  plausibleContextTokens: 420,
  estimatedContextSaved: 180
};

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<script id="__SKILL_STEWARD_BOOTSTRAP__" type="application/json">{"mutationToken":"test-token"}</script>';
});

describe("PreflightPage", () => {
  it("validates input and renders explainable selected, conflict, and excluded results", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: result, error: null, meta: { apiVersion: 1 } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PreflightPage />, { wrapper: wrapper() });

    const task = screen.getByRole("textbox", { name: "Task to analyze" });
    const analyze = screen.getByRole("button", { name: "Analyze task" });
    expect(analyze).toBeDisabled();
    await user.type(task, "Review this TypeScript change for security and missing tests");
    expect(analyze).toBeEnabled();
    await user.click(analyze);

    expect(await screen.findByText("security-review")).toBeVisible();
    expect(screen.getByText("Recommended Skills")).toBeVisible();
    expect(screen.getByText("180")).toBeVisible();
    expect(screen.getByText("SCOPE_SHADOWING")).toBeVisible();
    expect(screen.getByText("Deterministic local analysis")).toBeVisible();
    const excluded = screen.getByText("Excluded candidates (1)");
    await user.click(excluded);
    expect(screen.getByText("test-review")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/preflights",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Review this TypeScript change")
      })
    );
  });

  it("lets incomplete feedback correct the selected Skill set", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit
    ) => {
      const url = String(input);
      return url.endsWith("/feedback")
        ? {
            ok: true,
            json: async () => ({
              data: { saved: true },
              error: null,
              meta: { apiVersion: 1 }
            })
          }
        : {
            ok: true,
            json: async () => ({ data: result, error: null, meta: { apiVersion: 1 } })
          };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PreflightPage />, { wrapper: wrapper() });
    await user.type(
      screen.getByRole("textbox", { name: "Task to analyze" }),
      "Review this TypeScript change for security and missing tests"
    );
    await user.click(screen.getByRole("button", { name: "Analyze task" }));
    await screen.findByText("security-review");

    await user.click(screen.getByRole("button", { name: "Incomplete" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Include test-review" })
    );
    await user.click(screen.getByRole("button", { name: "Save feedback" }));

    expect(await screen.findByText("Feedback saved locally")).toBeVisible();
    const feedbackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/feedback")
    );
    expect(feedbackCall?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          label: "incomplete",
          selectedSkillIds: ["security", "testing"]
        })
      })
    );
  });

  it("shows no-match guidance", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            ...result,
            selectedSkillIds: [],
            candidates: [],
            conflicts: [],
            selectedContextTokens: 0,
            plausibleContextTokens: 0,
            estimatedContextSaved: 0
          },
          error: null,
          meta: { apiVersion: 1 }
        })
      }))
    );
    render(<PreflightPage />, { wrapper: wrapper() });
    await user.type(
      screen.getByRole("textbox", { name: "Task to analyze" }),
      "Prepare an unrelated astronomy observation"
    );
    await user.click(screen.getByRole("button", { name: "Analyze task" }));

    expect(await screen.findByText("No relevant Skills found")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Skills inventory" })).toHaveAttribute(
      "href",
      "/skills"
    );
  });

  it("preserves task text after an API error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          data: null,
          error: { code: "INTERNAL_ERROR", message: "Analysis failed" },
          meta: { apiVersion: 1 }
        })
      }))
    );
    render(<PreflightPage />, { wrapper: wrapper() });
    const task = screen.getByRole("textbox", { name: "Task to analyze" });
    await user.type(task, "Review this task after a temporary failure");
    await user.click(screen.getByRole("button", { name: "Analyze task" }));

    expect(await screen.findByText("Analysis failed")).toBeVisible();
    expect(task).toHaveValue("Review this task after a temporary failure");
  });

  it("localizes structured reason details in Chinese", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_PREFERENCES, locale: "zh-CN" })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: result, error: null, meta: { apiVersion: 1 } })
      }))
    );
    render(<PreflightPage />, { wrapper: wrapper() });

    await user.type(
      screen.getByRole("textbox", { name: "待分析任务" }),
      "检查这次安全变更并补充缺失测试"
    );
    await user.click(screen.getByRole("button", { name: "分析任务" }));

    expect(await screen.findByText("57% 的任务词由该 Skill 独立覆盖。")).toBeVisible();
    expect(screen.queryByText("57% unique task-term coverage.")).not.toBeInTheDocument();
  });
});
