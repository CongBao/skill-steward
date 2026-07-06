import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { ScanProvider } from "../scan/ScanProvider.js";
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
    { id: "inventory-coverage", value: { verified: 2, total: 3 }, status: "attention" },
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
      <PreferencesProvider>
        <MemoryRouter><ScanProvider>{children}</ScanProvider></MemoryRouter>
      </PreferencesProvider>
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

it("renders the six recommended KPIs and priority findings", async () => {
  render(<OverviewPage />, { wrapper: wrapper() });

  expect(await screen.findByRole("article", { name: /Health score: 83/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Open findings: 2/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Installed Skills: 4/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Estimated context: 1.5K/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Harnesses with active Skills: 3/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Verified inventory coverage: 2\/3/ })).toBeVisible();
  expect(screen.queryByRole("article", { name: /Bundle size/ })).not.toBeInTheDocument();
  expect(screen.getByText("Broken relative reference")).toBeVisible();
  expect(screen.getByText("Release steward")).toBeVisible();
});

it("guides first value with explicit links and persists dismissal locally", async () => {
  const user = userEvent.setup();
  render(<OverviewPage />, { wrapper: wrapper() });

  const guide = await screen.findByRole("region", { name: "Your next useful actions" });
  expect(within(guide).getByRole("link", { name: "Run task Preflight" })).toHaveAttribute("href", "/preflight");
  expect(within(guide).getByRole("link", { name: "Review optional Catalog sources" })).toHaveAttribute("href", "/settings#catalog-sources");
  expect(within(guide).getByRole("link", { name: "Review Harness integration" })).toHaveAttribute("href", "/settings#harness-integrations");

  await user.click(within(guide).getByRole("button", { name: "Dismiss first-value guide" }));

  expect(screen.queryByRole("region", { name: "Your next useful actions" })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("skill-steward:preferences") ?? "{}").showFirstValueGuide).toBe(false);
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
  expect(screen.getByText(/Public Catalog sources remain disabled and uncontacted/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Open optional Catalog settings" })).toHaveAttribute("href", "/settings#catalog-sources");
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

it("submits at most one first-run scan while the first request is pending", async () => {
  const user = userEvent.setup();
  let resolveScan: ((value: unknown) => void) | undefined;
  const scanResponse = new Promise((resolve) => { resolveScan = resolve; });
  const mockedFetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/v1/scans")) return scanResponse;
    return {
      ok: true,
      json: async () => ({
        data: { ...snapshot, status: "first-run", latest: null, kpis: [], priorityFindings: [] },
        error: null,
        meta: { apiVersion: 1 }
      })
    };
  });
  vi.stubGlobal("fetch", mockedFetch);
  render(<OverviewPage />, { wrapper: wrapper() });

  const action = await screen.findByRole("button", { name: "Run first scan" });
  await user.dblClick(action);
  expect(mockedFetch.mock.calls.filter(([input]) => String(input).endsWith("/api/v1/scans"))).toHaveLength(1);

  resolveScan?.({
    ok: true,
    json: async () => ({ data: snapshot, error: null, meta: { apiVersion: 1 } })
  });
});
