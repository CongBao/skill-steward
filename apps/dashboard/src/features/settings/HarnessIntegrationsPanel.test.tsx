import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { HarnessIntegrationsPanel } from "./HarnessIntegrationsPanel.js";

beforeEach(() => {
  localStorage.clear();
});

it("shows Hook and companion state while keeping integration plans read-only", async () => {
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
          changes: [{ operation: "write", path: "/home/.codex/hooks.json" }],
          companion: {
            action: "create",
            path: "/home/.agents/skills/skill-steward-preflight"
          },
          applyAvailable: false,
          applyCommand: null,
          applyUnavailableReason: "COMPANION_TRANSACTION_NOT_ENABLED"
        }
      : [
          {
            harness: "codex",
            status: "not-installed",
            targetPath: "/home/.codex/hooks.json",
            companion: {
              status: "missing",
              reason: "COMPANION_NOT_INSTALLED",
              path: "/home/.agents/skills/skill-steward-preflight"
            }
          },
          {
            harness: "claude-code",
            status: "installed",
            targetPath: "/home/.claude/settings.json",
            companion: {
              status: "current",
              reason: "COMPANION_CURRENT",
              path: "/home/.agents/skills/skill-steward-preflight"
            }
          },
          {
            harness: "github-copilot",
            status: "not-installed",
            targetPath: "/home/.copilot/hooks/skill-steward.json",
            companion: {
              status: "upgrade-available",
              reason: "COMPANION_UPGRADE_AVAILABLE",
              path: "/home/.agents/skills/skill-steward-preflight"
            }
          }
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
  expect(await within(codex).findByText("Hook: Not connected")).toBeVisible();
  expect(await within(codex).findByText("Companion Skill: Missing")).toBeVisible();
  const claude = screen.getByRole("article", { name: "Claude Code integration" });
  expect(await within(claude).findByText("Companion Skill: Current")).toBeVisible();
  expect(within(claude).queryByRole("button", { name: "Remove Claude Code integration" })).not.toBeInTheDocument();
  const copilot = screen.getByRole("article", { name: "GitHub Copilot CLI integration" });
  expect(await within(copilot).findByText("Observe only")).toBeVisible();
  expect(await within(copilot).findByText("Recommendations via companion Skill")).toBeVisible();
  expect(await within(copilot).findByText("Companion Skill: Upgrade available")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Review Codex integration" }));
  expect(await screen.findByText("/home/.codex/hooks.json")).toBeVisible();
  expect(await screen.findByText("Companion action: Create")).toBeVisible();
  expect(await screen.findByText("Applying integration plans is not available yet. This preview does not change your Harness configuration or companion Skill.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Apply Codex integration" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/apply"))).toBe(false);
});

it("does not infer not-installed state when integration status is unavailable", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { harness: "codex", displayName: "Codex", mode: "recommend-and-observe", promptInjection: true, observation: true, turnLifecycle: true, sessionLifecycle: false, events: ["UserPromptSubmit", "Stop"], installScopes: ["global", "project"], validationStatus: "fixture-tested" }
          ],
          error: null,
          meta: { apiVersion: 1 }
        })
      };
    }
    return {
      ok: false,
      status: 503,
      json: async () => ({
        data: null,
        error: { code: "STATUS_UNAVAILABLE", message: "Integration status unavailable" },
        meta: { apiVersion: 1 }
      })
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><HarnessIntegrationsPanel /></PreferencesProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Integration status unavailable");
  const codex = screen.getByRole("article", { name: "Codex integration" });
  expect(within(codex).getByText("Hook: Unavailable")).toBeVisible();
  expect(within(codex).getByText("Companion Skill: Unavailable")).toBeVisible();
  expect(within(codex).queryByText("Hook: Not connected")).not.toBeInTheDocument();
});
