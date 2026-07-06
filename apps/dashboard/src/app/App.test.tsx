import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { AppRoutes } from "./routes.js";
import { enUS } from "../i18n/en-US.js";
import { zhCN } from "../i18n/zh-CN.js";
import {
  DEFAULT_PREFERENCES,
  PreferencesProvider,
  parsePreferences,
  resolveTheme
} from "../theme/preferences.js";

beforeEach(() => {
  localStorage.clear();
  history.replaceState({}, "", "/");
});

function renderIsolatedApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

describe("dashboard application shell", () => {
  it("keeps Chinese and English catalogs structurally identical", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
  });

  it("switches all shell navigation to Chinese and persists the choice", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preflight" })).toHaveAttribute(
      "href",
      "/preflight"
    );

    await user.click(screen.getByRole("button", { name: "中文" }));

    expect(screen.getByRole("link", { name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "任务预检" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("skill-steward:preferences") ?? "{}").locale).toBe(
      "zh-CN"
    );
  });

  it("keeps the compact topbar scan accessible and runs a real scan mutation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      json: async () => ({
        data: {
          status: "first-run",
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
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const topbar = screen.getByRole("banner");
    const scan = within(topbar).getByRole("button", { name: "Scan now" });
    expect(scan).toHaveAttribute("aria-label", "Scan now");
    await user.click(scan);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/scans"))).toBe(true)
    );
  });

  it("shows a sanitized retryable scan failure and preserves the last portfolio until retry succeeds", async () => {
    const user = userEvent.setup();
    let scanAttempts = 0;
    const snapshot = {
      status: "ready",
      latest: {
        generatedAt: "2026-07-06T08:00:00.000Z",
        portfolioFingerprint: `sha256:${"a".repeat(64)}`,
        skillCount: 4,
        findingCount: 0
      },
      kpis: [
        { id: "health-score", value: 83, status: "attention" },
        { id: "installed-skills", value: 4, status: "neutral" }
      ],
      skills: [],
      priorityFindings: [],
      history: [],
      roots: [],
      inventory: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/scans")) {
        scanAttempts += 1;
        if (scanAttempts === 1) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              data: null,
              error: { code: "SCAN_FAILED", message: "Could not read /Users/private/Skills" },
              meta: { apiVersion: 1 }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              ...snapshot,
              latest: { ...snapshot.latest, skillCount: 5 },
              kpis: [
                { id: "health-score", value: 91, status: "positive" },
                { id: "installed-skills", value: 5, status: "neutral" }
              ]
            },
            error: null,
            meta: { apiVersion: 1 }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: snapshot, error: null, meta: { apiVersion: 1 } })
      };
    }));

    renderIsolatedApp();
    expect(await screen.findByRole("article", { name: /Health score: 83/ })).toBeVisible();

    const topbar = screen.getAllByRole("banner")[0];
    expect(topbar).toBeDefined();
    await user.click(within(topbar as HTMLElement).getByRole("button", { name: "Scan now" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Scan did not finish")).toBeVisible();
    expect(alert).toHaveTextContent("Your last successful portfolio is still visible");
    expect(alert).not.toHaveTextContent("/Users/private/Skills");
    expect(screen.getByRole("article", { name: /Health score: 83/ })).toBeVisible();

    await user.click(within(alert).getByRole("button", { name: "Retry scan" }));

    expect(await screen.findByRole("article", { name: /Health score: 91/ })).toBeVisible();
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps first-run guidance visible when the Overview scan fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/scans")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            data: null,
            error: { code: "SCAN_FAILED", message: "Scan failed" },
            meta: { apiVersion: 1 }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            status: "first-run",
            latest: null,
            kpis: [],
            skills: [],
            priorityFindings: [],
            history: [],
            roots: [],
            inventory: null
          },
          error: null,
          meta: { apiVersion: 1 }
        })
      };
    }));

    renderIsolatedApp();
    const main = screen.getByRole("main");
    await user.click(await within(main).findByRole("button", { name: "Run first scan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Scan did not finish");
    expect(within(main).getByRole("heading", { name: "See the health of your local Skills" })).toBeVisible();
    expect(within(main).queryByRole("heading", { name: "No Skills found" })).not.toBeInTheDocument();
  });
});

describe("preferences", () => {
  it("recovers invalid data to recommended defaults", () => {
    expect(parsePreferences({ version: 99, theme: "neon" })).toEqual(DEFAULT_PREFERENCES);
  });

  it("preserves existing KPI selections and visible-count preferences", () => {
    const stored = {
      ...DEFAULT_PREFERENCES,
      kpiCount: 5,
      kpiOrder: ["health-score", "open-findings", "harness-coverage"],
      enabledKpis: ["health-score", "harness-coverage"]
    };

    expect(parsePreferences(stored)).toEqual(stored);
  });

  it("backfills the first-value guide preference without losing legacy settings", () => {
    const { showFirstValueGuide: _omitted, ...legacy } = DEFAULT_PREFERENCES;
    const parsed = parsePreferences({
      ...legacy,
      kpiCount: 5,
      enabledKpis: ["health-score", "installed-skills"]
    });

    expect(parsed.showFirstValueGuide).toBe(true);
    expect(parsed.kpiCount).toBe(5);
    expect(parsed.enabledKpis).toEqual(["health-score", "installed-skills"]);
    expect(parsePreferences({ ...DEFAULT_PREFERENCES, showFirstValueGuide: false }).showFirstValueGuide).toBe(false);
  });

  it("resolves system, light, and dark modes", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
