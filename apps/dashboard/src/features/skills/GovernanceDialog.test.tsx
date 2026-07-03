import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { GovernanceDialog } from "./GovernanceDialog.js";

const skill = {
  id: "skill-review",
  name: "review",
  description: "Review code",
  path: "/home/.agents/skills/review",
  scope: "global" as const,
  visibleTo: ["codex", "claude-code"],
  fingerprint: `sha256:${"a".repeat(64)}`,
  files: [],
  estimatedTokens: 180
};
const plan = {
  schemaVersion: 1,
  id: "govern-plan-1",
  kind: "quarantine",
  skillId: skill.id,
  activePath: skill.path,
  vaultPath: "/state/quarantine/govern-plan-1/review",
  stagingPath: "/state/quarantine/govern-plan-1/.review.staging",
  rollbackPath: "/home/.agents/skills/.review.rollback",
  sourceFingerprint: skill.fingerprint,
  expectedDestinationFingerprint: null,
  visibleAliases: [{ harness: "codex", scope: "global", rootPath: "/home/.agents/skills" }],
  operations: [
    { operation: "copy-to-staging", from: skill.path, to: "/state/quarantine/govern-plan-1/.review.staging" },
    { operation: "verify-staging", path: "/state/quarantine/govern-plan-1/.review.staging", fingerprint: skill.fingerprint },
    { operation: "move-active-to-rollback", from: skill.path, to: "/home/.agents/skills/.review.rollback" },
    { operation: "commit-vault", from: "/state/quarantine/govern-plan-1/.review.staging", to: "/state/quarantine/govern-plan-1/review" },
    { operation: "append-journal", transactionId: "govern-plan-1" },
    { operation: "cleanup-rollback", path: "/home/.agents/skills/.review.rollback" }
  ],
  createdAt: "2026-07-03T10:00:00.000Z",
  expiresAt: "2026-07-03T10:10:00.000Z"
};

function respond(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 409, json: async () => ({ data: ok ? data : null, error: ok ? null : data, meta: { apiVersion: 1 } }) };
}

beforeEach(() => vi.restoreAllMocks());

it("reviews every quarantine operation before applying a recoverable action", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/apply")
    ? respond({ transaction: { id: plan.id, action: "quarantine", status: "quarantined", skillId: skill.id }, rescanRequired: true, cleanupPending: false })
    : respond(plan));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onComplete = vi.fn();
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><GovernanceDialog action={{ kind: "quarantine", skill }} onComplete={onComplete} /></QueryClientProvider>);

  expect(screen.getByText(/moves the Skill out of every active alias/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review quarantine plan" }));
  expect(await screen.findByText("Exact operation plan")).toBeVisible();
  expect(screen.getAllByText(skill.path).length).toBeGreaterThan(1);
  expect(screen.getAllByText("/state/quarantine/govern-plan-1/review").length).toBeGreaterThan(1);
  expect(screen.getByText("copy to staging")).toBeVisible();
  expect(screen.getByText("verify staging")).toBeVisible();
  expect(screen.getByText("commit vault")).toBeVisible();
  expect(screen.getByText("codex · global")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Apply reviewed quarantine" }));
  await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/governance/plans/govern-plan-1/apply",
    expect.objectContaining({ method: "POST" })
  );
});

it("surfaces a drift refusal and never converts it into a destructive fallback", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/apply")
    ? respond({ code: "SOURCE_DRIFT", message: "Active Skill changed after planning" }, false)
    : respond(plan));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><GovernanceDialog action={{ kind: "quarantine", skill }} onComplete={vi.fn()} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Review quarantine plan" }));
  await user.click(await screen.findByRole("button", { name: "Apply reviewed quarantine" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Active Skill changed after planning");
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
});

it("reviews the exact restore destination and source quarantine", async () => {
  const transaction = {
    schemaVersion: 1 as const,
    id: "quarantine-1",
    action: "quarantine" as const,
    status: "quarantined" as const,
    skillId: skill.id,
    originalPath: skill.path,
    vaultPath: "/state/quarantine/quarantine-1/review",
    fingerprint: skill.fingerprint,
    visibleAliases: [{ harness: "codex", scope: "global" as const, rootPath: "/home/.agents/skills" }],
    createdAt: "2026-07-03T09:00:00.000Z"
  };
  const restorePlan = {
    ...plan,
    id: "restore-plan-1",
    kind: "restore" as const,
    sourceTransactionId: transaction.id,
    vaultPath: transaction.vaultPath,
    stagingPath: "/home/.agents/skills/.review.restore.tmp",
    rollbackPath: undefined,
    operations: [
      { operation: "copy-to-staging" as const, from: transaction.vaultPath, to: "/home/.agents/skills/.review.restore.tmp" },
      { operation: "verify-staging" as const, path: "/home/.agents/skills/.review.restore.tmp", fingerprint: skill.fingerprint },
      { operation: "restore-active" as const, from: "/home/.agents/skills/.review.restore.tmp", to: skill.path },
      { operation: "append-journal" as const, transactionId: "restore-plan-1" },
      { operation: "cleanup-vault" as const, path: transaction.vaultPath }
    ]
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/apply")
    ? respond({ transaction: { ...transaction, id: restorePlan.id, action: "restore", status: "restored", sourceTransactionId: transaction.id }, rescanRequired: true, cleanupPending: false })
    : respond(restorePlan)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><GovernanceDialog action={{ kind: "restore", transaction }} onComplete={vi.fn()} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Review restore plan" }));
  expect(await screen.findByText("restore active")).toBeVisible();
  expect(screen.getAllByText(skill.path).length).toBeGreaterThan(1);
  expect(screen.getByRole("button", { name: "Apply reviewed restore" })).toBeVisible();
});
