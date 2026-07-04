import { afterEach, expect, it, vi } from "vitest";
import { fetchDashboard, fetchGovernanceTransactions } from "./client.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

it("serves deterministic local inventory state for browser QA without contacting an API", async () => {
  window.history.replaceState({}, "", "/settings?fixture=inventory-coverage");
  const fetch = vi.fn(() => Promise.reject(new Error("fixture must stay offline")));
  vi.stubGlobal("fetch", fetch);

  const dashboard = await fetchDashboard();

  expect(dashboard.inventory?.sources.length).toBeGreaterThan(6);
  expect(dashboard.inventory?.harnesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ harness: "codex", status: "partial" }),
    expect.objectContaining({ harness: "agents", status: "convention-only" })
  ]));
  expect(dashboard.skills).toEqual(expect.arrayContaining([
    expect.objectContaining({ ownership: "direct" }),
    expect.objectContaining({ ownership: "native-plugin" })
  ]));
  expect(await fetchGovernanceTransactions()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
