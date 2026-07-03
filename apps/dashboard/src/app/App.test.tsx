import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { enUS } from "../i18n/en-US.js";
import { zhCN } from "../i18n/zh-CN.js";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  resolveTheme
} from "../theme/preferences.js";

beforeEach(() => {
  localStorage.clear();
  history.replaceState({}, "", "/");
});

describe("dashboard application shell", () => {
  it("keeps Chinese and English catalogs structurally identical", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
  });

  it("switches all shell navigation to Chinese and persists the choice", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "中文" }));

    expect(screen.getByRole("link", { name: "概览" })).toBeInTheDocument();
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
});

describe("preferences", () => {
  it("recovers invalid data to recommended defaults", () => {
    expect(parsePreferences({ version: 99, theme: "neon" })).toEqual(DEFAULT_PREFERENCES);
  });

  it("resolves system, light, and dark modes", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
