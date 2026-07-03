import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { SkillsPage } from "./SkillsPage.js";

const active = {
  id: "active-skill", name: "Active review", description: "Review code", path: "/skills/active-review",
  scope: "global", visibleTo: ["codex"], fingerprint: `sha256:${"a".repeat(64)}`, files: [], estimatedTokens: 120
};
const quarantine = {
  schemaVersion: 1, id: "quarantine-1", action: "quarantine", status: "quarantined", skillId: "old-skill",
  originalPath: "/skills/old-review", vaultPath: "/state/quarantine/quarantine-1/old-review",
  fingerprint: `sha256:${"b".repeat(64)}`, visibleAliases: [{ harness: "claude-code", scope: "global", rootPath: "/skills" }],
  createdAt: "2026-07-03T09:00:00.000Z"
};

beforeEach(() => vi.restoreAllMocks());

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PreferencesProvider><MemoryRouter><SkillsPage /></MemoryRouter></PreferencesProvider></QueryClientProvider>);

  const activeRegion = await screen.findByRole("region", { name: "Active Skills" });
  expect(within(activeRegion).getByText("Active review")).toBeVisible();
  expect(within(activeRegion).getByRole("button", { name: "Quarantine Active review" })).toBeVisible();
  const quarantinedRegion = screen.getByRole("region", { name: "Quarantined Skills" });
  expect(within(quarantinedRegion).getByText("old-review")).toBeVisible();
  expect(within(quarantinedRegion).getByRole("button", { name: "Restore old-review" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
});
