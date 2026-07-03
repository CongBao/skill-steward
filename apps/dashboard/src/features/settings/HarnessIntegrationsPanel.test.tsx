import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
    const data = url.endsWith("/capabilities")
      ? [
          { harness: "codex", displayName: "Codex", mode: "recommend-and-observe", promptInjection: true, observation: true, turnLifecycle: true, sessionLifecycle: false, events: ["UserPromptSubmit", "Stop"], installScopes: ["global", "project"], validationStatus: "fixture-tested" },
          { harness: "claude-code", displayName: "Claude Code", mode: "recommend-and-observe", promptInjection: true, observation: true, turnLifecycle: true, sessionLifecycle: true, events: ["UserPromptSubmit", "Stop", "SessionEnd"], installScopes: ["global", "project"], validationStatus: "fixture-tested" },
          { harness: "github-copilot", displayName: "GitHub Copilot CLI", mode: "observe-only", promptInjection: false, observation: true, turnLifecycle: false, sessionLifecycle: true, events: ["userPromptSubmitted", "sessionEnd"], installScopes: ["global", "project"], validationStatus: "fixture-tested" }
        ]
      : url.endsWith("/plan")
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
            { harness: "claude-code", status: "installed", targetPath: "/home/.claude/settings.json" },
            { harness: "github-copilot", status: "not-installed", targetPath: "/home/.copilot/hooks/skill-steward.json" }
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
  const codex = screen.getByRole("article", { name: "Codex integration" });
  expect(await within(codex).findByText("Recommend + observe")).toBeVisible();
  const copilot = screen.getByRole("article", { name: "GitHub Copilot CLI integration" });
  expect(await within(copilot).findByText("Observe only")).toBeVisible();
  expect(await within(copilot).findByText("Recommendations via companion Skill")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review Codex integration" }));
  expect(await screen.findByText("/home/.codex/hooks.json")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Apply Codex integration" }));
  expect(confirm).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/integrations/codex/apply",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ planId: "plan-1" })
    })
  );
});
