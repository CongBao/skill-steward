import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
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

function renderSkillsPage(initialEntries: ComponentProps<typeof MemoryRouter>["initialEntries"] = ["/"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PreferencesProvider><MemoryRouter initialEntries={initialEntries}><SkillsPage /></MemoryRouter></PreferencesProvider></QueryClientProvider>);
}

function routeInstallationFetch(compatibleHarnesses: string[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const data = url.endsWith("/governance/transactions")
      ? []
      : url.endsWith("/catalog/sources")
        ? {
            sources: [],
            snapshot: {
              schemaVersion: 1,
              generatedAt: "2026-07-06T00:00:00.000Z",
              sources: [],
              skills: [{ id: "testing", compatibleHarnesses, compatibility: "declared" }]
            }
          }
        : url.includes("/catalog/candidates/testing/inspect-installation")
          ? {
              catalogCandidateId: "testing",
              previewId: "preview-reload",
              expiresAt: Date.now() + 60_000,
              source: { kind: "git" },
              candidates: [{
                id: "root",
                relativePath: ".",
                name: "recommended-review",
                description: "Recommended after reload",
                fingerprint: `sha256:${"d".repeat(64)}`,
                files: [], estimatedTokens: 180, scripts: [], executables: [], findings: []
              }]
            }
          : {
              status: "ready", latest: null, kpis: [], skills: [], priorityFindings: [], history: [], roots: []
            };
    return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
  });
}

it.each(["codex", "claude", "github-copilot"])(
  "restores the %s Preflight candidate and target after a route reload",
  async (harness) => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routeInstallationFetch([harness]));

    renderSkillsPage([`/skills?installCandidate=testing&harness=${harness}`]);

    const inspect = await screen.findByRole("button", { name: "Inspect recommendation" });
    const mockedFetch = vi.mocked(fetch);
    expect(mockedFetch.mock.calls.some(([input]) => String(input).includes("inspect-installation"))).toBe(false);
    await user.click(inspect);
    expect(await screen.findByText("Recommended after reload")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Target harness")).toHaveValue(harness);
  }
);

it.each([
  ["unsupported target", "forged", ["codex"]],
  ["incompatible pair", "claude", ["codex"]]
])("uses a neutral target for an %s and orders compatible targets first", async (_case, harness, compatibleHarnesses) => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", routeInstallationFetch(compatibleHarnesses));

  renderSkillsPage([`/skills?installCandidate=testing&harness=${harness}`]);

  await user.click(await screen.findByRole("button", { name: "Inspect recommendation" }));
  expect(await screen.findByText("Recommended after reload")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const target = screen.getByLabelText<HTMLSelectElement>("Target harness");
  expect(target).toHaveValue("");
  expect([...target.options].filter(({ value }) => value).map(({ value }) => value).slice(0, 2))
    .toEqual(["codex", "agents"]);
});

it("uses the local Catalog as compatibility authority instead of router state", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", routeInstallationFetch(["codex"]));
  const installationPreview = {
    catalogCandidateId: "testing",
    previewId: "preview-navigation",
    expiresAt: Date.now() + 60_000,
    source: { kind: "git" },
    candidates: [{
      id: "root", relativePath: ".", name: "recommended-review",
      description: "Recommended in the same navigation", fingerprint: `sha256:${"e".repeat(64)}`,
      files: [], estimatedTokens: 180, scripts: [], executables: [], findings: []
    }]
  };

  renderSkillsPage([{
    pathname: "/skills",
    search: "?installCandidate=testing&harness=claude",
    state: {
      installationPreview,
      installationContext: { candidateId: "testing", compatibleHarnesses: ["claude"] }
    }
  }]);

  expect(await screen.findByText("Recommended in the same navigation")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("Target harness")).toHaveValue("");
});

it("shows a sanitized retry when the local recommendation cannot be restored", async () => {
  const user = userEvent.setup();
  let catalogAttempts = 0;
  const baseFetch = routeInstallationFetch(["codex"]);
  const mockedFetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/catalog/sources") && ++catalogAttempts === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ data: null, error: { message: "/Users/private/catalog failed" }, meta: { apiVersion: 1 } })
      };
    }
    return baseFetch(input);
  });
  vi.stubGlobal("fetch", mockedFetch);

  renderSkillsPage(["/skills?installCandidate=testing&harness=codex"]);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Recommendation could not be restored");
  expect(alert).not.toHaveTextContent("/Users/private");
  expect(screen.queryByRole("dialog", { name: "Install a Skill" })).not.toBeInTheDocument();
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Inspect recommendation" })).toBeVisible();
});

it("keeps inspection explicit and retryable after a Catalog staging failure", async () => {
  const user = userEvent.setup();
  let inspectionAttempts = 0;
  const baseFetch = routeInstallationFetch(["codex"]);
  const mockedFetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes("inspect-installation") && ++inspectionAttempts === 1) {
      return {
        ok: false,
        status: 502,
        json: async () => ({ data: null, error: { message: "git credential: secret" }, meta: { apiVersion: 1 } })
      };
    }
    return baseFetch(input);
  });
  vi.stubGlobal("fetch", mockedFetch);

  renderSkillsPage(["/skills?installCandidate=testing&harness=codex"]);
  await user.click(await screen.findByRole("button", { name: "Inspect recommendation" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Recommendation inspection did not finish");
  expect(alert).not.toHaveTextContent("secret");
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Recommended after reload")).toBeVisible();
});

it("rejects a malformed candidate route without inspecting it", async () => {
  const mockedFetch = routeInstallationFetch(["codex"]);
  vi.stubGlobal("fetch", mockedFetch);

  renderSkillsPage(["/skills?installCandidate=%3Cscript%3E&harness=codex"]);

  expect(await screen.findByRole("dialog", { name: "Install a Skill" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Local folder" })).toBeVisible();
  expect(mockedFetch.mock.calls.some(([input]) => String(input).includes("inspect-installation")))
    .toBe(false);
});

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
