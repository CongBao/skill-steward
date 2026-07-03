import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { CatalogSourcesPanel } from "./CatalogSourcesPanel.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

it("shows publisher classification and explicitly enables and refreshes sources", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const data = url.endsWith("/refresh")
      ? {
          schemaVersion: 1,
          generatedAt: "2026-07-03T00:00:00.000Z",
          sources: [{ sourceId: "openai-curated", status: "ready", skillCount: 12 }],
          skills: []
        }
      : url.endsWith("/enable")
        ? {
            id: "openai-curated",
            name: "OpenAI curated Skills",
            kind: "git",
            url: "https://github.com/openai/skills.git",
            enabled: true,
            trust: "vendor",
            preset: true
          }
        : {
            sources: [{
              id: "openai-curated",
              name: "OpenAI curated Skills",
              kind: "git",
              url: "https://github.com/openai/skills.git",
              enabled: false,
              trust: "vendor",
              preset: true
            }],
            snapshot: null
          };
    return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><CatalogSourcesPanel /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByText("OpenAI curated Skills")).toBeVisible();
  expect(screen.getByText("Known publisher · not a safety guarantee")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Enable OpenAI curated Skills" }));
  await user.click(screen.getByRole("button", { name: "Refresh enabled sources" }));
  expect(confirm).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/catalog/refresh",
    expect.objectContaining({ method: "POST" })
  );
});
