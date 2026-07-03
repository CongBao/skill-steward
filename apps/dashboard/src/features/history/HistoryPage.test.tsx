import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HistoryPage } from "./HistoryPage.js";

const history = [
  { generatedAt: "2026-07-03T10:00:00.000Z", healthScore: 100, skillCount: 0, findingCount: 0, estimatedTokens: 0 },
  { generatedAt: "2026-07-02T10:00:00.000Z", healthScore: 80, skillCount: 2, findingCount: 1, estimatedTokens: 800 },
  { generatedAt: "2026-07-01T10:00:00.000Z", healthScore: 60, skillCount: 1, findingCount: 3, estimatedTokens: 500 }
];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

it("renders zero-skill health as an em dash and excludes it from the health trend", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: history, error: null, meta: { apiVersion: 1 } })
  })));

  const { container } = render(<HistoryPage />, { wrapper });

  expect(await screen.findByText(/Jul 3, 2026/)).toBeVisible();
  const rows = screen.getAllByRole("listitem");
  expect(within(rows[0]!).getByText("—")).toBeVisible();
  expect(within(rows[1]!).getByText("80")).toBeVisible();
  expect(screen.getByRole("img", { name: "Health" })).toBeVisible();
  expect(container.querySelector(".sparkline polyline")).toHaveAttribute("points", "0,30 100,2");
});

it("shows a load error instead of an empty history state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ data: null, error: { message: "failed" }, meta: { apiVersion: 1 } })
  })));

  render(<HistoryPage />, { wrapper });

  expect(await screen.findByRole("heading", { name: "Local data unavailable" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Run more than one distinct scan to build a local trend." })).not.toBeInTheDocument();
});
