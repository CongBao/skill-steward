import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { SettingsPage } from "./SettingsPage.js";

const codexSources = Array.from({ length: 8 }, (_, index) => ({
  id: `codex-source-${index}`,
  harness: "codex",
  scope: index === 0 ? "project" : "global",
  kind: index === 7 ? "native-plugin" : "direct-root",
  path: `/local/codex/source-${index}`,
  ...(index === 7 ? { plugin: { id: "quality@team", version: "2.1.0" } } : {}),
  status: index === 6 ? "invalid" : "scanned",
  skillCount: index === 7 ? 2 : 0,
  effectiveSkillCount: index === 7 ? 1 : 0,
  ...(index === 6 ? { diagnostic: { code: "METADATA_INVALID_TOML", message: "Private local detail that must not become generic guidance: /Users/private/config.toml" } } : {})
}));

const dashboard = {
  status: "ready",
  latest: { generatedAt: "2026-07-04T00:00:00.000Z", portfolioFingerprint: `sha256:${"a".repeat(64)}`, skillCount: 2, findingCount: 0 },
  kpis: [{ id: "inventory-coverage", value: { verified: 2, total: 3 }, status: "attention" }],
  skills: [],
  priorityFindings: [],
  history: [],
  roots: [],
  inventory: {
    sources: [
      ...codexSources,
      { id: "claude-source", harness: "claude", scope: "global", kind: "direct-root", path: "/local/claude", status: "missing", skillCount: 0, effectiveSkillCount: 0 },
      { id: "copilot-source", harness: "github-copilot", scope: "global", kind: "direct-root", path: "/local/copilot", status: "scanned", skillCount: 1, effectiveSkillCount: 1 },
      { id: "agents-source", harness: "agents", scope: "global", kind: "convention-root", path: "/local/agents", status: "scanned", skillCount: 3, effectiveSkillCount: 0 }
    ],
    harnesses: [
      { harness: "codex", status: "partial", sourceIds: codexSources.map(({ id }) => id), skillCount: 2, effectiveSkillCount: 1 },
      { harness: "claude", status: "unavailable", sourceIds: ["claude-source"], skillCount: 0, effectiveSkillCount: 0 },
      { harness: "github-copilot", status: "verified", sourceIds: ["copilot-source"], skillCount: 1, effectiveSkillCount: 1 },
      { harness: "agents", status: "convention-only", sourceIds: ["agents-source"], skillCount: 3, effectiveSkillCount: 0 }
    ]
  }
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
    ok: true,
    json: async () => ({
      data: String(input).endsWith("/api/v1/dashboard")
        ? dashboard
        : String(input).endsWith("/api/v1/evidence/policy")
          ? { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
          : [],
      error: null,
      meta: { apiVersion: 1 }
    })
  })));
});

it("groups truthful native and convention coverage and discloses every source", async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  const panel = await screen.findByRole("region", { name: "Inventory coverage" });
  const core = await within(panel).findByRole("region", { name: "Core native adapters" });
  const conventions = within(panel).getByRole("region", { name: "Convention-only roots" });
  expect(core.compareDocumentPosition(conventions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(core).getByRole("article", { name: "Codex: Partial" })).toHaveTextContent("8 sources2 Skills1 effective");
  expect(within(core).getByRole("article", { name: "Claude Code: Unavailable" })).toBeVisible();
  expect(within(core).getByRole("article", { name: "GitHub Copilot CLI: Verified" })).toBeVisible();
  expect(within(conventions).getByRole("article", { name: "Agent Skills: Convention only" })).toBeVisible();

  const disclosure = within(core).getByText("Inspect all 8 local sources");
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  await user.click(disclosure);
  for (const source of codexSources) {
    expect(within(core).getByText(source.path)).toBeVisible();
  }
  expect(within(core).getByText("METADATA_INVALID_TOML")).toBeVisible();
  expect(within(core).getByText("Review this Harness's local configuration or manifest, then scan again.")).toBeVisible();
  expect(within(core).queryByText(/Users\/private\/config\.toml/)).not.toBeInTheDocument();
});

it("uses natural Chinese coverage labels and diagnostic guidance", async () => {
  localStorage.setItem("skill-steward:preferences", JSON.stringify({
    version: 1,
    locale: "zh-CN",
    theme: "system",
    sidebar: "auto",
    kpiCount: 5,
    kpiOrder: ["inventory-coverage"],
    enabledKpis: ["inventory-coverage"]
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  const panel = await screen.findByRole("region", { name: "清单覆盖情况" });
  expect(await within(panel).findByRole("region", { name: "核心原生适配器" })).toBeVisible();
  expect(within(panel).getByRole("region", { name: "仅按目录约定检查" })).toBeVisible();
  expect(within(panel).getByRole("article", { name: "Codex：部分覆盖" })).toBeVisible();
});

it("does not mislabel an API failure as legacy coverage", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/v1/dashboard")) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ data: null, error: { message: "unavailable" }, meta: { apiVersion: 1 } })
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: String(input).endsWith("/api/v1/evidence/policy")
          ? { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5_000 }
          : [],
        error: null,
        meta: { apiVersion: 1 }
      })
    };
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PreferencesProvider><SettingsPage /></PreferencesProvider>
    </QueryClientProvider>
  );

  const panel = await screen.findByRole("region", { name: "Inventory coverage" });
  expect(await within(panel).findByText("Inventory coverage data could not be read. No coverage conclusion has been made.")).toBeVisible();
  expect(within(panel).queryByText(/schema-v2/)).not.toBeInTheDocument();
});
