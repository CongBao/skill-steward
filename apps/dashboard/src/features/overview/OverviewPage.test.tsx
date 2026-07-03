import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { OverviewPage } from "./OverviewPage.js";

const snapshot = {
  status: "ready",
  latest: {
    generatedAt: "2026-07-02T10:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skillCount: 4,
    findingCount: 2
  },
  kpis: [
    { id: "health-score", value: 83, status: "attention" },
    { id: "open-findings", value: 2, status: "risk" },
    { id: "installed-skills", value: 4, status: "neutral" },
    { id: "estimated-context", value: 1500, status: "neutral" },
    { id: "harness-coverage", value: 3, status: "neutral" },
    { id: "bundle-size", value: 3800, status: "neutral" }
  ],
  skills: [
    {
      id: "skill-release",
      name: "Release steward",
      description: "Review releases",
      path: "/skills/release",
      scope: "project",
      visibleTo: ["codex"],
      fingerprint: `sha256:${"b".repeat(64)}`,
      files: [],
      estimatedTokens: 320
    }
  ],
  priorityFindings: [
    {
      id: "finding-1",
      code: "BROKEN_RELATIVE_REFERENCE",
      severity: "error",
      skillIds: ["skill-release"],
      summary: "Broken relative reference",
      evidence: ["missing.md"],
      recommendation: "Repair it",
      confidence: 1
    }
  ],
  history: [],
  roots: []
};

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>{children}</PreferencesProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: snapshot, error: null, meta: { apiVersion: 1 } })
  })));
});

it("renders the five recommended KPIs and priority findings", async () => {
  render(<OverviewPage />, { wrapper: wrapper() });

  expect(await screen.findByRole("article", { name: /Health score: 83/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Open findings: 2/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Installed Skills: 4/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Estimated context: 1.5K/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Active Harnesses: 3/ })).toBeVisible();
  expect(screen.queryByRole("article", { name: /Bundle size/ })).not.toBeInTheDocument();
  expect(screen.getByText("Broken relative reference")).toBeVisible();
  expect(screen.getByText("Release steward")).toBeVisible();
});

it("shows discovery actions instead of a misleading perfect score when a scan finds no Skills", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        ...snapshot,
        latest: { ...snapshot.latest, skillCount: 0, findingCount: 0 },
        kpis: [
          { id: "health-score", value: 100, status: "positive" },
          { id: "installed-skills", value: 0, status: "neutral" }
        ],
        skills: [],
        priorityFindings: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  render(<OverviewPage />, { wrapper: wrapper() });

  expect(await screen.findByRole("heading", { name: "No Skills found" })).toBeVisible();
  expect(screen.queryByRole("article", { name: /Health score: 100/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Portfolio KPIs")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Skills" })).toHaveAttribute("href", "/skills");
  expect(screen.getByRole("link", { name: "Review discovery settings" })).toHaveAttribute("href", "/settings");
});

it("shows a first-run action when no report exists", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: { ...snapshot, status: "first-run", latest: null, kpis: [], priorityFindings: [] },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
  render(<OverviewPage />, { wrapper: wrapper() });
  expect(await screen.findByRole("button", { name: "Run first scan" })).toBeVisible();
});
