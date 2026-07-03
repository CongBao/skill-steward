import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { SettingsPage } from "./SettingsPage.js";

const dashboard = {
  status: "ready",
  latest: { generatedAt: "2026-07-03T10:00:00.000Z", portfolioFingerprint: `sha256:${"a".repeat(64)}`, skillCount: 4, findingCount: 1 },
  kpis: [
    { id: "health-score", value: 81, status: "attention" },
    { id: "installed-skills", value: 4, status: "neutral" },
    { id: "estimated-context", value: 1_500, status: "neutral" },
    { id: "harness-coverage", value: 2, status: "positive" }
  ],
  skills: [],
  priorityFindings: [],
  history: [],
  roots: []
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/api/v1/dashboard")
        ? dashboard
        : String(input).endsWith("/api/v1/evidence/policy")
          ? { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
          : [],
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
});

it("previews live dashboard KPI values with the Overview formatting", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByRole("article", { name: "Health score: 81" })).toBeVisible();
  expect(screen.getByRole("article", { name: "Open findings: —" })).toBeVisible();
  expect(screen.getByRole("article", { name: "Estimated context: 1.5K" })).toBeVisible();
  expect(screen.getByRole("article", { name: "Active Harnesses: 2" })).toBeVisible();
});

it("treats health as unscored when the latest scan found no Skills", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/api/v1/dashboard")
        ? {
            ...dashboard,
            latest: { ...dashboard.latest, skillCount: 0, findingCount: 0 },
            kpis: [
              ...dashboard.kpis.map((kpi) =>
                kpi.id === "health-score"
                  ? { ...kpi, value: 100 }
                  : kpi.id === "installed-skills"
                    ? { ...kpi, value: 0 }
                    : kpi
              ),
              {
                id: "health-trend",
                value: [
                  { generatedAt: "2026-07-03T10:00:00.000Z", value: 100 },
                  { generatedAt: "2026-07-02T10:00:00.000Z", value: 81 },
                  { generatedAt: "2026-07-01T10:00:00.000Z", value: 75 }
                ],
                status: "neutral"
              }
            ],
            history: [
              { generatedAt: "2026-07-03T10:00:00.000Z", healthScore: 100, skillCount: 0, findingCount: 0, estimatedTokens: 0 },
              { generatedAt: "2026-07-02T10:00:00.000Z", healthScore: 81, skillCount: 4, findingCount: 1, estimatedTokens: 1_500 },
              { generatedAt: "2026-07-01T10:00:00.000Z", healthScore: 75, skillCount: 3, findingCount: 2, estimatedTokens: 1_200 }
            ]
          }
        : String(input).endsWith("/api/v1/evidence/policy")
          ? { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
          : [],
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByRole("article", { name: "Installed Skills: 0" })).toBeVisible();
  expect(screen.getByRole("article", { name: "Health score: —" })).toBeVisible();
  expect(screen.queryByRole("article", { name: "Health score: 100" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Health trend" }));
  await user.clear(screen.getByRole("spinbutton", { name: "Visible KPI count" }));
  await user.type(screen.getByRole("spinbutton", { name: "Visible KPI count" }), "6");
  expect(screen.getByRole("article", { name: "Health trend: 81" })).toBeVisible();
  expect(screen.queryByRole("article", { name: "Health trend: 100" })).not.toBeInTheDocument();
});

it("configures KPI count and catalog, then restores recommendations", async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(screen.getByRole("spinbutton", { name: "Visible KPI count" })).toHaveValue(5);
  expect(screen.getByRole("checkbox", { name: "Bundle size" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Bundle size" }));
  await user.clear(screen.getByRole("spinbutton", { name: "Visible KPI count" }));
  await user.type(screen.getByRole("spinbutton", { name: "Visible KPI count" }), "6");
  expect(screen.getByRole("checkbox", { name: "Bundle size" })).toBeChecked();

  await user.click(screen.getByRole("button", { name: "Restore recommended" }));
  expect(screen.getByRole("spinbutton", { name: "Visible KPI count" })).toHaveValue(5);
  expect(screen.getByRole("checkbox", { name: "Bundle size" })).not.toBeChecked();
});
