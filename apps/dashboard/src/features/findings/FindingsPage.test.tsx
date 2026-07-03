import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, PreferencesProvider } from "../../theme/preferences.js";
import { FindingsPage } from "./FindingsPage.js";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><PreferencesProvider>{children}</PreferencesProvider></QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("shows a load error instead of claiming there are no findings", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ data: null, error: { message: "failed" }, meta: { apiVersion: 1 } })
  })));

  render(<FindingsPage />, { wrapper });

  expect(await screen.findByRole("heading", { name: "Local data unavailable" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "No findings match the current filter." })).not.toBeInTheDocument();
});

it("shows the names of every Skill affected by a finding", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        status: "ready",
        latest: { generatedAt: "2026-07-03T10:00:00.000Z", portfolioFingerprint: `sha256:${"a".repeat(64)}`, skillCount: 2, findingCount: 1 },
        kpis: [],
        skills: [
          { id: "skill-a", name: "API reviewer", description: "", path: "/skills/a", scope: "project", visibleTo: ["codex"], fingerprint: `sha256:${"b".repeat(64)}`, files: [], estimatedTokens: 100 },
          { id: "skill-b", name: "Test guardian", description: "", path: "/skills/b", scope: "global", visibleTo: ["codex"], fingerprint: `sha256:${"c".repeat(64)}`, files: [], estimatedTokens: 100 }
        ],
        priorityFindings: [{
          id: "finding-1",
          code: "OVERLAPPING_TRIGGER",
          severity: "warning",
          skillIds: ["skill-b", "skill-a"],
          summary: "Overlapping activation rules",
          evidence: ["shared trigger"],
          recommendation: "Clarify the routing rules.",
          confidence: 0.9
        }],
        history: [],
        roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  render(<FindingsPage />, { wrapper });

  expect(await screen.findByText("Affected Skills")).toBeVisible();
  expect(screen.getByText("Test guardian, API reviewer")).toBeVisible();
  expect(screen.getByText("Showing up to five priority findings from the latest scan.")).toBeVisible();
});

it("localizes every severity filter option", async () => {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    ...DEFAULT_PREFERENCES,
    locale: "zh-CN"
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        status: "ready",
        latest: null,
        kpis: [],
        skills: [],
        priorityFindings: [],
        history: [],
        roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  render(<FindingsPage />, { wrapper });

  expect(await screen.findByRole("option", { name: "严重" })).toBeVisible();
  expect(screen.getByRole("option", { name: "错误" })).toBeVisible();
  expect(screen.getByRole("option", { name: "警告" })).toBeVisible();
  expect(screen.getByRole("option", { name: "提示" })).toBeVisible();
});
