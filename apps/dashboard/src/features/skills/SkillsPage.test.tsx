import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { SkillsPage } from "./SkillsPage.js";

const active = {
  id: "active-skill", name: "Active review", description: "Review code", path: "/skills/active-review",
  scope: "global", visibleTo: ["codex"], fingerprint: `sha256:${"a".repeat(64)}`, files: [], estimatedTokens: 120
};
const directWinner = {
  ...active,
  id: "direct-winner",
  name: "Project review",
  ownership: "direct",
  sourceIds: ["copilot:project:source"],
  exposures: [{ harness: "github-copilot", effectiveName: "review", state: "effective", sourceId: "copilot:project:source", reason: "COPILOT_FIRST_FOUND" }]
};
const nativePlugin = {
  ...active,
  id: "plugin-shadowed",
  name: "Plugin review",
  visibleTo: [],
  ownership: "native-plugin",
  plugin: { harness: "github-copilot", id: "quality@team", version: "2.1.0" },
  sourceIds: ["copilot:plugin:source"],
  exposures: [{ harness: "github-copilot", effectiveName: "review", state: "shadowed", sourceId: "copilot:plugin:source", shadowedBy: "direct-winner", reason: "COPILOT_FIRST_FOUND_SHADOWED" }]
};
const quarantine = {
  schemaVersion: 1, id: "quarantine-1", action: "quarantine", status: "quarantined", skillId: "old-skill",
  skillName: "Archived reviewer",
  originalPath: "/skills/old-review", vaultPath: "/state/quarantine/quarantine-1/old-review",
  fingerprint: `sha256:${"b".repeat(64)}`, visibleAliases: [{ harness: "claude-code", scope: "global", rootPath: "/skills" }],
  createdAt: "2026-07-03T09:00:00.000Z"
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderSkillsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PreferencesProvider><MemoryRouter><SkillsPage /></MemoryRouter></PreferencesProvider></QueryClientProvider>);
}

it("separates active and quarantined Skills with only reversible governance actions", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [quarantine] : {
        status: "ready", latest: null, kpis: [], skills: [active], priorityFindings: [], history: [], roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
  renderSkillsPage();

  const activeRegion = await screen.findByRole("region", { name: "Inventoried Skills" });
  expect(within(activeRegion).getByText("Active review")).toBeVisible();
  expect(within(activeRegion).getByRole("button", { name: "Quarantine Active review" })).toBeVisible();
  const quarantinedRegion = screen.getByRole("region", { name: "Quarantined Skills" });
  expect(within(quarantinedRegion).getByText("Archived reviewer")).toBeVisible();
  expect(within(quarantinedRegion).getByRole("button", { name: "Restore Archived reviewer" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
});

it("localizes active and quarantined Skill scopes", async () => {
  localStorage.setItem("skill-steward:preferences", JSON.stringify({
    version: 1,
    locale: "zh-CN",
    theme: "system",
    sidebar: "auto",
    kpiCount: 5,
    kpiOrder: ["health-score", "open-findings", "installed-skills", "estimated-context", "harness-coverage"],
    enabledKpis: ["health-score", "open-findings", "installed-skills", "estimated-context", "harness-coverage"]
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [quarantine] : {
        status: "ready", latest: null, kpis: [], skills: [active], priorityFindings: [], history: [], roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  renderSkillsPage();

  expect(await screen.findByText("Archived reviewer")).toBeVisible();
  expect(screen.getByText("claude-code · 全局")).toBeVisible();
  expect(screen.getAllByText("全局").length).toBeGreaterThan(0);
});

it("explains when discovery has found no Skills", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [] : {
        status: "ready", latest: null, kpis: [], skills: [], priorityFindings: [], history: [], roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  renderSkillsPage();

  expect(await screen.findByRole("heading", { name: "No Skills found" })).toBeVisible();
  expect(screen.getByText(/No Skills are available in the known roots/)).toBeVisible();
});

it("shows a load error instead of claiming there are no Skills", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/governance/transactions")) {
      return { ok: true, json: async () => ({ data: [], error: null, meta: { apiVersion: 1 } }) };
    }
    return {
      ok: false,
      status: 500,
      json: async () => ({ data: null, error: { message: "failed" }, meta: { apiVersion: 1 } })
    };
  }));

  renderSkillsPage();

  expect(await screen.findByRole("heading", { name: "Local data unavailable" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "No Skills found" })).not.toBeInTheDocument();
});

it("uses a search-specific empty state when existing Skills do not match", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [] : {
        status: "ready", latest: null, kpis: [], skills: [active], priorityFindings: [], history: [], roots: []
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  renderSkillsPage();
  await screen.findByText("Active review");
  await user.type(screen.getByRole("textbox", { name: "Search Skills" }), "no-result");

  expect(screen.getByText("No inventoried Skills match your search.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "No Skills found" })).not.toBeInTheDocument();
});

it("shows local provenance and exposure while keeping native plugin caches read-only", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [] : {
        status: "ready", latest: null, kpis: [], skills: [directWinner, nativePlugin], priorityFindings: [], history: [], roots: [], inventory: null
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
  renderSkillsPage();

  const activeRegion = await screen.findByRole("region", { name: "Inventoried Skills" });
  const winnerRow = within(activeRegion).getByRole("row", { name: /Project review/ });
  expect(within(winnerRow).getByText("Direct source")).toBeVisible();
  expect(within(winnerRow).getByText("Effective in GitHub Copilot CLI")).toBeVisible();
  expect(within(winnerRow).getByRole("button", { name: "Quarantine Project review" })).toBeVisible();

  const pluginRow = within(activeRegion).getByRole("row", { name: /Plugin review/ });
  expect(within(pluginRow).getByText("Native plugin")).toBeVisible();
  expect(within(pluginRow).getByText("quality@team · v2.1.0")).toBeVisible();
  expect(within(pluginRow).getByText("Shadowed in GitHub Copilot CLI by Project review")).toBeVisible();
  expect(within(pluginRow).getByText("Manage this Skill with the GitHub Copilot CLI plugin manager.")).toBeVisible();
  expect(within(pluginRow).queryByRole("button", { name: /Quarantine/ })).not.toBeInTheDocument();
  expect(within(pluginRow).queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
});

it("uses the complete validated exposure identity for React keys", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const multipleExposures = {
    ...directWinner,
    exposures: [
      directWinner.exposures[0]!,
      {
        ...directWinner.exposures[0]!,
        effectiveName: "review-alternate",
        state: "ambiguous"
      }
    ]
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/governance/transactions") ? [] : {
        status: "ready", latest: null, kpis: [], skills: [multipleExposures], priorityFindings: [], history: [], roots: [], inventory: null
      },
      error: null,
      meta: { apiVersion: 1 }
    })
  })));

  renderSkillsPage();

  const row = await screen.findByRole("row", { name: /Project review/ });
  expect(within(row).getByText("Effective in GitHub Copilot CLI")).toBeVisible();
  expect(within(row).getByText("Ambiguous in GitHub Copilot CLI")).toBeVisible();
  expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
});
