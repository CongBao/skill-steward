import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../../theme/preferences.js";
import { InstallSkillFlow } from "./InstallSkillFlow.js";

function response(data: unknown) {
  return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/inspect")) {
      return response({
        previewId: "preview-1",
        expiresAt: Date.now() + 60_000,
        source: { kind: "git", url: "https://github.com/example/skills" },
        candidates: [
          {
            id: "candidate-1",
            relativePath: "skills/review",
            name: "review",
            description: "Review code changes",
            fingerprint: `sha256:${"a".repeat(64)}`,
            files: [{ relativePath: "SKILL.md", bytes: 100 }],
            estimatedTokens: 250,
            scripts: [],
            executables: [],
            findings: []
          }
        ]
      });
    }
    if (url.endsWith("/plan")) {
      return response({
        id: "plan-1",
        status: "ready",
        action: "create",
        destination: "/home/.claude/skills/review",
        changes: [{ operation: "create", path: "/home/.claude/skills/review" }]
      });
    }
    if (url.endsWith("/commit")) return response({ id: "tx-1", status: "installed" });
    throw new Error(`Unexpected URL ${url}`);
  }));
});

it("reviews and explicitly confirms a public Git installation", async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><InstallSkillFlow onClose={vi.fn()} /></PreferencesProvider>
    </QueryClientProvider>
  );

  await user.click(screen.getByRole("button", { name: "Public Git" }));
  await user.type(screen.getByLabelText("Repository URL"), "https://github.com/example/skills");
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  expect(await screen.findByText("Review code changes")).toBeVisible();

  await user.click(screen.getByRole("radio", { name: /review/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.selectOptions(screen.getByLabelText("Target harness"), "claude");
  await user.selectOptions(screen.getByLabelText("Installation scope"), "global");
  await user.click(screen.getByRole("button", { name: "Review plan" }));
  expect(await screen.findAllByText("/home/.claude/skills/review")).toHaveLength(2);

  const install = screen.getByRole("button", { name: "Install Skill" });
  expect(install).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /reviewed the source/ }));
  await user.click(install);
  expect(await screen.findByText("Skill installed")).toBeVisible();
});
