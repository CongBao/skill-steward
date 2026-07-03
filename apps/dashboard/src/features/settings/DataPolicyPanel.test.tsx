import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DataPolicyPanel } from "./DataPolicyPanel.js";

const policy = { schemaVersion: 1, mode: "minimal", retentionDays: 30, maxEvents: 5000 };
const planned = {
  schemaVersion: 1,
  id: "policy-plan-1",
  before: policy,
  beforeFingerprint: `sha256:${"a".repeat(64)}`,
  after: { ...policy, mode: "learning", retentionDays: 45, maxEvents: 3000 },
  afterFingerprint: `sha256:${"b".repeat(64)}`,
  createdAt: "2026-07-03T10:00:00.000Z",
  expiresAt: "2026-07-03T10:10:00.000Z"
};
const erasePlan = {
  schemaVersion: 1,
  id: "erase-plan-1",
  createdAt: "2026-07-03T10:00:00.000Z",
  expiresAt: "2026-07-03T10:10:00.000Z",
  paths: [
    { kind: "preflights", path: "/state/preflights.json", exists: true, fingerprint: `sha256:${"a".repeat(64)}` },
    { kind: "events", path: "/state/evidence-events.jsonl", exists: true, fingerprint: `sha256:${"b".repeat(64)}` },
    { kind: "salt", path: "/state/evidence-salt", exists: false, fingerprint: null }
  ]
};

function respond(data: unknown) {
  return { ok: true, json: async () => ({ data, error: null, meta: { apiVersion: 1 } }) };
}

beforeEach(() => vi.restoreAllMocks());

it("previews policy changes, compacts, and erases only after explicit confirmation", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/policy/plan")) return respond(planned);
    if (path.endsWith("/policy/apply")) return respond(planned.after);
    if (path.endsWith("/compact")) return respond({ before: 25, kept: 20, removed: 5 });
    if (path.endsWith("/erase/plan")) return respond(erasePlan);
    if (path.endsWith("/erase/apply")) return respond({ erased: true });
    if (path.endsWith("/policy") && (!init?.method || init.method === "GET")) return respond(policy);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><DataPolicyPanel /></QueryClientProvider>);

  expect(await screen.findByRole("combobox", { name: "Collection mode" })).toHaveValue("minimal");
  await user.selectOptions(screen.getByRole("combobox", { name: "Collection mode" }), "learning");
  await user.clear(screen.getByRole("spinbutton", { name: "Retention days" }));
  await user.type(screen.getByRole("spinbutton", { name: "Retention days" }), "45");
  await user.clear(screen.getByRole("spinbutton", { name: "Maximum lifecycle events" }));
  await user.type(screen.getByRole("spinbutton", { name: "Maximum lifecycle events" }), "3000");
  await user.click(screen.getByRole("button", { name: "Review policy change" }));

  expect(await screen.findByText("Policy change preview")).toBeVisible();
  expect(screen.getByText("minimal → learning")).toBeVisible();
  expect(screen.getByText("30 → 45 days")).toBeVisible();
  expect(screen.getByText("5,000 → 3,000 events")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Apply reviewed policy" }));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/evidence/policy/apply", expect.objectContaining({ body: JSON.stringify({ planId: "policy-plan-1" }) })));

  await user.click(screen.getByRole("button", { name: "Compact now" }));
  expect(await screen.findByText("Removed 5 of 25 lifecycle events.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Review evidence erase" }));
  expect(await screen.findByText("Evidence erase preview")).toBeVisible();
  expect(screen.getByText("/state/preflights.json")).toBeVisible();
  expect(screen.getByText("/state/evidence-events.jsonl")).toBeVisible();
  expect(screen.getByText("/state/evidence-salt")).toBeVisible();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/erase/apply"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Erase reviewed evidence" }));
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/erase/apply"))).toBe(true));
});
