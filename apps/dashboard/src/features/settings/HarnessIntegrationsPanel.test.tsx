import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { HarnessIntegrationsPanel } from "./HarnessIntegrationsPanel.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

it("reviews a Harness plan before applying it", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const data = url.endsWith("/plan")
      ? {
          id: "plan-1",
          harness: "codex",
          targetPath: "/home/.codex/hooks.json",
          changes: [{ operation: "write", path: "/home/.codex/hooks.json" }]
        }
      : url.endsWith("/apply")
        ? { harness: "codex", status: "needs-trust", targetPath: "/home/.codex/hooks.json" }
        : [
            { harness: "codex", status: "not-installed", targetPath: "/home/.codex/hooks.json" },
            { harness: "claude-code", status: "installed", targetPath: "/home/.claude/settings.json" }
          ];
    return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><HarnessIntegrationsPanel /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByText("Claude Code")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review Codex integration" }));
  expect(await screen.findByText("/home/.codex/hooks.json")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Apply Codex integration" }));
  expect(confirm).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/integrations/codex/apply",
    expect.objectContaining({ method: "POST" })
  );
});
