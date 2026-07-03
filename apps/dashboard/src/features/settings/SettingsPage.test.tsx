import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/api/v1/evidence/policy")
        ? { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
        : [],
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
