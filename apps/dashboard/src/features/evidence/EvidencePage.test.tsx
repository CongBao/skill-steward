import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, PreferencesProvider } from "../../theme/preferences.js";
import { EvidencePage } from "./EvidencePage.js";

const emptyMetric = { numerator: 0, denominator: 0, value: null };
const metrics = {
  feedbackRate: { numerator: 12, denominator: 20, value: 0.6 },
  usefulRate: { numerator: 9, denominator: 12, value: 0.75 },
  incompleteRate: { numerator: 2, denominator: 12, value: 2 / 12 },
  incorrectRate: { numerator: 1, denominator: 12, value: 1 / 12 },
  correctionPrecision: { numerator: 4, denominator: 6, value: 4 / 6 },
  correctionRecall: { numerator: 4, denominator: 8, value: 0.5 },
  correctionF1: { numerator: 8, denominator: 14, value: 8 / 14 },
  installConversion: { numerator: 3, denominator: 10, value: 0.3 }
};
const totals = { preflights: 20, labeled: 12, portfolios: 4, events: 30 };
const summary = {
  schemaVersion: 1,
  generatedAt: "2026-07-03T10:00:00.000Z",
  period: { from: "2026-06-01T10:00:00.000Z", to: "2026-07-03T09:00:00.000Z" },
  totals,
  metrics,
  lifecycleReasons: { complete: 18, error: 2, abort: 1 },
  harnesses: [{ key: "codex", totals, metrics }],
  algorithms: [{ key: "2", totals, metrics }],
  windows: {
    last7Days: { key: "7d", totals: { preflights: 7, labeled: 5, portfolios: 2, events: 8 }, metrics: { ...metrics, usefulRate: { numerator: 4, denominator: 5, value: 0.8 } } },
    last30Days: { key: "30d", totals, metrics }
  },
  readiness: { status: "insufficient-evidence", reasons: ["Need 100 labeled preflights"] }
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><PreferencesProvider>{children}</PreferencesProvider></QueryClientProvider>;
}

function respond(data: unknown) {
  return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("shows a useful empty state before any preflight evidence exists", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond({
    ...summary,
    totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 },
    metrics: Object.fromEntries(Object.keys(metrics).map((key) => [key, emptyMetric])),
    harnesses: [],
    algorithms: [],
    lifecycleReasons: {},
    windows: {
      last7Days: { ...summary.windows.last7Days, totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 }, metrics: Object.fromEntries(Object.keys(metrics).map((key) => [key, emptyMetric])) },
      last30Days: { ...summary.windows.last30Days, totals: { preflights: 0, labeled: 0, portfolios: 0, events: 0 }, metrics: Object.fromEntries(Object.keys(metrics).map((key) => [key, emptyMetric])) }
    }
  })));

  render(<EvidencePage />, { wrapper });
  expect(await screen.findByRole("heading", { name: "No evidence yet" })).toBeVisible();
  expect(screen.getByText(/Run task preflight here in the dashboard or from a connected Harness/)).toBeVisible();
});

it("shows explicit-label KPIs, proxy signals, and transparent denominators", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond(summary)));
  const { container } = render(<EvidencePage />, { wrapper });

  expect(await screen.findByText("More evidence needed")).toBeVisible();
  expect(screen.getByRole("article", { name: /Feedback rate: 60%\. 12 of 20 preflights/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Useful label rate: 75%\. 9 of 12 labels/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Correction F1: 57%\. 8 of 14 set decisions/ })).toBeVisible();
  expect(screen.getByRole("article", { name: /Install conversion: 30%\. 3 of 10 recommendations/ })).toBeVisible();
  expect(screen.getByRole("img", { name: "7 and 30 day useful-label comparison" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Lifecycle signals" })).toBeVisible();
  expect(container.querySelector(".lifecycle-panel header > span")).toHaveTextContent("21");
  expect(screen.getByText("Complete")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Harness breakdown" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Algorithm breakdown" })).toBeVisible();
  expect(screen.getByText(/Lifecycle events are weak operational proxies/)).toBeVisible();
  expect(screen.getByText(/do not prove task success/)).toBeVisible();
});

it("marks a sufficiently diverse labeled dataset ready for calibration", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond({
    ...summary,
    readiness: { status: "ready-for-calibration", reasons: [] }
  })));
  render(<EvidencePage />, { wrapper });
  expect(await screen.findByText("Ready for calibration review")).toBeVisible();
  expect(screen.getByText(/No thresholds are changed automatically/)).toBeVisible();
});

it("localizes every supported lifecycle reason", async () => {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    ...DEFAULT_PREFERENCES,
    locale: "zh-CN"
  }));
  vi.stubGlobal("fetch", vi.fn(async () => respond({
    ...summary,
    lifecycleReasons: { complete: 18, error: 2, abort: 1, timeout: 3, other: 4 }
  })));

  render(<EvidencePage />, { wrapper });

  expect(await screen.findByText("超时")).toBeVisible();
  expect(screen.getByText("其他")).toBeVisible();
});

it("does not render content-shaped fields even if a contaminated transport fixture adds them", async () => {
  const canaries = [
    "CANARY_RAW_PROMPT_UI_94721",
    "CANARY_TRANSCRIPT_UI_94721",
    "CANARY_RAW_ID_UI_94721",
    "/CANARY/WORKING/PATH/UI/94721",
    "CANARY_TOOL_OUTPUT_UI_94721",
    "CANARY_PRIVATE_SALT_UI_94721"
  ];
  vi.stubGlobal("fetch", vi.fn(async () => respond({
    ...summary,
    rawPrompt: canaries[0],
    transcript: canaries[1],
    rawSessionId: canaries[2],
    cwd: canaries[3],
    toolOutput: canaries[4],
    salt: canaries[5]
  })));
  const { container } = render(<EvidencePage />, { wrapper });
  expect(await screen.findByText("More evidence needed")).toBeVisible();
  for (const canary of canaries) expect(container.textContent).not.toContain(canary);
});
