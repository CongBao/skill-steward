import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PreferencesProvider } from "../theme/preferences.js";
import { Sidebar } from "./Sidebar.js";

function setNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 900px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

beforeEach(() => {
  localStorage.clear();
  setNarrow(false);
});

it("defaults wide layouts to expanded and persists manual collapse", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter><PreferencesProvider><Sidebar /></PreferencesProvider></MemoryRouter>
  );
  const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Overview")).toBeVisible();

  await user.click(toggle);
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(JSON.parse(localStorage.getItem("skill-steward:preferences") ?? "{}").sidebar).toBe(
    "collapsed"
  );
});

it("defaults narrow layouts to an icon rail and closes overlay with Escape", async () => {
  setNarrow(true);
  const user = userEvent.setup();
  render(
    <MemoryRouter><PreferencesProvider><Sidebar /></PreferencesProvider></MemoryRouter>
  );
  await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getByRole("navigation", { name: "Primary navigation" })).toHaveAttribute(
    "data-overlay",
    "true"
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
});
