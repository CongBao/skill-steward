import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  PreferencesProvider
} from "../../theme/preferences.js";
import { HarnessIntegrationsPanel } from "./HarnessIntegrationsPanel.js";

const capabilities = [
  { harness: "codex", displayName: "Codex", mode: "recommend-and-observe", promptInjection: true, observation: true, turnLifecycle: true, sessionLifecycle: false, events: ["UserPromptSubmit", "Stop"], installScopes: ["global", "project"], validationStatus: "fixture-tested" },
  { harness: "claude-code", displayName: "Claude Code", mode: "recommend-and-observe", promptInjection: true, observation: true, turnLifecycle: true, sessionLifecycle: true, events: ["UserPromptSubmit", "Stop", "SessionEnd"], installScopes: ["global", "project"], validationStatus: "fixture-tested" },
  { harness: "github-copilot", displayName: "GitHub Copilot CLI", mode: "observe-only", promptInjection: false, observation: true, turnLifecycle: false, sessionLifecycle: true, events: ["userPromptSubmitted", "sessionEnd"], installScopes: ["global", "project"], validationStatus: "fixture-tested" }
];

function envelope(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 409,
    json: async () => ok
      ? { data, error: null, meta: { apiVersion: 1 } }
      : { data: null, error: data, meta: { apiVersion: 1 } }
  };
}

function status(
  harness: "codex" | "claude-code" | "github-copilot",
  companion: "current" | "upgrade-available" | "missing" | "conflict" | "unknown",
  hookStatus: "not-installed" | "installed" | "needs-trust" | "drifted" | "invalid" = "not-installed"
) {
  const reason = `COMPANION_${companion.replaceAll("-", "_").toUpperCase()}`;
  const companionAvailable = companion !== "conflict" && companion !== "unknown";
  const hookAvailable = hookStatus !== "drifted" && hookStatus !== "invalid";
  const availability = hookAvailable && companionAvailable
    ? { state: "available", available: true, reason: null }
    : {
        state: "unavailable",
        available: false,
        reason: hookAvailable ? reason : `HOOK_${hookStatus.replaceAll("-", "_").toUpperCase()}`
      };
  return {
    schemaVersion: 3,
    harness,
    hook: {
      status: hookStatus,
      reason: `HOOK_${hookStatus.replaceAll("-", "_").toUpperCase()}`,
      target: `/home/.${harness}/hooks.json`,
      availability: hookAvailable
        ? { state: "available", available: true, reason: null }
        : availability
    },
    companion: {
      status: companion,
      reason,
      target: "/home/.agents/skills/skill-steward-preflight",
      proofCategory: companion === "missing"
        ? "new"
        : companion === "conflict"
          ? "conflict"
          : companion === "unknown"
            ? "unknown"
            : "recorded",
      availability: companionAvailable
        ? { state: "available", available: true, reason: null }
        : availability
    },
    availability
  };
}

function availablePlan(
  planId: string,
  harness: "codex" | "claude-code" | "github-copilot" = "codex"
) {
  return {
    schemaVersion: 1,
    planId,
    harness,
    action: "connect",
    status: "current",
    availability: { state: "available", available: true, reason: null },
    targets: { hook: `/hook/${planId}`, companion: `/companion/${planId}` },
    fingerprintCategory: "recorded",
    artifacts: [{ role: "harness-configuration", operation: "connect" }],
    createdAt: "2026-07-05T00:00:00.000Z",
    expiresAt: "2026-07-05T00:10:00.000Z",
    applyCommand: `apply ${planId}`
  };
}

function readyResult(planId: string) {
  return {
    planId,
    action: "connect",
    receipt: {
      transactionId: "00000000-0000-4000-8000-000000000099",
      outcome: "ready",
      hook: "unchanged",
      companion: "unchanged",
      recordId: `record-${planId}`,
      cleanup: "clean",
      reasonCode: "INTEGRATION_READY",
      nextSafeAction: "none"
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPanel(locale: "en-US" | "zh-CN" = "en-US") {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    ...DEFAULT_PREFERENCES,
    locale
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider><HarnessIntegrationsPanel /></PreferencesProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reviews and confirms the domain-derived global recovery without direction controls", async () => {
  const user = userEvent.setup();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let recovered = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/recovery/plan")) return envelope({
      schemaVersion: 1,
      planId: "recovery-plan",
      action: "finalize",
      recoveryState: "finalize-required",
      availability: { state: "available", available: true, reason: null },
      transaction: {
        transactionId: "00000000-0000-4000-8000-000000000088",
        harness: "codex",
        action: "upgrade",
        phase: "cleanup-pending",
        sequence: 7
      },
      evidenceDigest: `sha256:${"a".repeat(64)}`,
      artifacts: { configuration: true, readiness: true, companionRoles: ["cleanup"] },
      createdAt: "2026-07-06T00:00:00.000Z",
      expiresAt: "2026-07-06T00:10:00.000Z",
      applyCommand: "skill-steward integrate recovery apply --plan recovery-plan --confirm"
    });
    if (url.endsWith("/recovery/apply")) {
      recovered = true;
      return envelope({
        schemaVersion: 1,
        transactionId: "00000000-0000-4000-8000-000000000088",
        planId: "recovery-plan",
        action: "finalize",
        outcome: "recovered",
        finalState: "closed",
        reasonCode: "INTEGRATION_RECOVERY_FINALIZED",
        nextSafeAction: "create-new-plan"
      });
    }
    if (url.endsWith("/recovery")) return envelope(recovered ? {
      state: "clear",
      reasonCode: "INTEGRATION_RECOVERY_CLEAR",
      recoverable: false
    } : {
      state: "finalize-required",
      reasonCode: "INTEGRATION_RECOVERY_FINALIZE_REQUIRED",
      recoverable: true,
      direction: "finalize",
      transaction: {
        transactionId: "00000000-0000-4000-8000-000000000088",
        harness: "codex",
        action: "upgrade",
        phase: "cleanup-pending",
        sequence: 7
      }
    });
    return envelope([
      status("codex", "unknown"),
      status("claude-code", "unknown"),
      status("github-copilot", "unknown")
    ]);
  }));
  renderPanel();

  expect(await screen.findByText(
    "The integration record committed, but finalization did not finish. Skill Steward can safely continue the full committed path."
  )).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /force|rollback/i })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review recovery" }));
  const confirm = await screen.findByRole("button", { name: "Confirm recovery" });
  expect(confirm).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(
    "Recovery completed. Create a fresh integration plan before the next change."
  )).toBeVisible();
  expect(await screen.findByText(
    "No interrupted integration transaction is blocking changes."
  )).toBeVisible();
  const applyCall = calls.find(({ url }) => url.endsWith("/recovery/apply"));
  expect(applyCall?.init?.body).toBe(JSON.stringify({ planId: "recovery-plan" }));
});

it("explains unknown recovery naturally in Chinese and offers no mutation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/recovery")) return envelope({
      state: "unknown",
      reasonCode: "INTEGRATION_RECOVERY_UNAVAILABLE",
      recoverable: false
    });
    return envelope([
      status("codex", "unknown"),
      status("claude-code", "unknown"),
      status("github-copilot", "unknown")
    ]);
  }));
  renderPanel("zh-CN");

  expect(await screen.findByText(
    "现有本地证据不足以判断安全的恢复方向，因此暂不提供恢复操作。"
  )).toBeVisible();
  expect(screen.queryByRole("button", { name: /恢复|强制|重试/u })).not.toBeInTheDocument();
});

it("reviews and keyboard-confirms Create companion with one exact planId", async () => {
  const user = userEvent.setup();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope({
      schemaVersion: 1,
      planId: "create-plan",
      harness: "codex",
      action: "create",
      status: "missing",
      availability: { state: "available", available: true, reason: null },
      targets: {
        hook: "/home/.codex/hooks.json",
        companion: "/home/.agents/skills/skill-steward-preflight"
      },
      fingerprintCategory: "new",
      artifacts: [
        { role: "companion-skill", operation: "create" },
        { role: "harness-configuration", operation: "connect" }
      ],
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "skill-steward integrate apply --plan create-plan --confirm"
    });
    if (url.endsWith("/codex/apply")) return envelope({
      planId: "create-plan",
      action: "create",
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000001",
        outcome: "ready",
        hook: "installed",
        companion: "created",
        recordId: "record-1",
        cleanup: "clean",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none"
      }
    });
    return envelope([
      status("codex", "missing"),
      status("claude-code", "current", "installed"),
      status("github-copilot", "upgrade-available")
    ]);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel();

  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  expect(await within(codex).findByText("Companion Skill: Missing")).toBeVisible();
  await user.click(within(codex).getByRole("button", { name: "Review Codex integration" }));
  expect(await screen.findByRole("heading", { name: "Create companion" })).toBeVisible();
  expect(screen.getByText("/home/.codex/hooks.json")).toBeVisible();
  expect(screen.getByText("/home/.agents/skills/skill-steward-preflight")).toBeVisible();
  const confirm = screen.getByRole("button", { name: "Confirm Create companion for Codex" });
  confirm.focus();
  await user.keyboard("{Enter}");

  expect(await screen.findByText(
    "Transaction ready · companion created · Hook installed · Cleanup complete · No further action is needed."
  )).toBeVisible();
  const applyCall = calls.find(({ url }) => url.endsWith("/codex/apply"));
  expect(applyCall?.init?.body).toBe(JSON.stringify({ planId: "create-plan" }));
});

it("reviews and confirms Disconnect Harness with exact last-consumer removal", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/disconnect/plan")) return envelope({
      schemaVersion: 1,
      planId: "disconnect-plan",
      harness: "codex",
      action: "disconnect",
      status: "current",
      availability: { state: "available", available: true, reason: null },
      targets: {
        hook: "/home/.codex/hooks.json",
        companion: "/home/.agents/skills/skill-steward-preflight"
      },
      fingerprintCategory: "recorded",
      artifacts: [{ role: "harness-configuration", operation: "disconnect" }],
      companion: "removed",
      companionRetained: false,
      lastConsumer: true,
      remainingConsumers: 0,
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "skill-steward integrate remove --plan disconnect-plan --confirm"
    });
    if (url.endsWith("/codex/disconnect")) return envelope({
      planId: "disconnect-plan",
      action: "disconnect",
      receipt: {
        outcome: "ready",
        hook: "removed",
        companion: "removed",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none",
        transactionId: "00000000-0000-4000-8000-000000000001",
        recordId: "record-2",
        cleanup: "clean"
      }
    });
    return envelope([
      status("codex", "current", "installed"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel();

  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  expect(await within(codex).findByText("Companion Skill: Current")).toBeVisible();
  await user.click(within(codex).getByRole("button", { name: "Review disconnect for Codex" }));
  expect(await screen.findByRole("heading", { name: "Disconnect Harness" })).toBeVisible();
  expect(screen.getByText("The last consumer will disconnect. The exact unchanged managed companion Skill will be removed.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Confirm Disconnect Harness for Codex" }));
  expect(await screen.findByText(
    "Transaction ready · companion removed · Hook removed · Cleanup complete · No further action is needed."
  )).toBeVisible();
});

it.each([
  ["conflict", "COMPANION_CONFLICT", "The companion Skill conflicts with unmanaged or changed content.", "配套 Skill 与未托管或已变更的内容冲突。"],
  ["unknown", "COMPANION_SOURCE_UNPROVABLE", "The packaged companion Skill source could not be verified.", "无法验证软件包中的配套 Skill 来源。"],
  ["unknown", "COMPANION_RECOVERY_REQUIRED", "Resolve the pending integration recovery before making another change.", "请先处理待完成的集成恢复，再进行其他变更。"],
  ["unknown", "INTEGRATION_PLATFORM_UNSUPPORTED", "Managed integration changes are unavailable on this platform.", "当前平台不支持托管集成变更。"],
  ["unknown", "INTEGRATION_NATIVE_CAPABILITY_UNAVAILABLE", "The required atomic filesystem helper is unavailable.", "所需的原子文件系统组件不可用。"],
  ["unknown", "INTEGRATION_PLAN_PROTOCOL_UNSUPPORTED", "This integration plan uses an unsupported lifecycle protocol.", "此集成计划使用了不受支持的生命周期协议。"]
] as const)("localizes blocked %s/%s without raw codes or mutation controls", async (
  companionStatus,
  reason,
  english,
  chinese
) => {
  for (const [locale, expected, articleName, reviewName] of [
    ["en-US", english, "Codex Harness integration", "Review Codex integration"],
    ["zh-CN", chinese, "Codex Harness 集成", "检查 Codex 集成"]
  ] as const) {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/capabilities")) return envelope(capabilities);
      if (url.endsWith("/codex/plan")) return envelope({
        schemaVersion: 1,
        planId: "blocked-plan",
        harness: "codex",
        action: "blocked",
        status: companionStatus,
        availability: { state: "unavailable", available: false, reason },
        targets: {
          hook: "/home/.codex/hooks.json",
          companion: "/home/.agents/skills/skill-steward-preflight"
        },
        fingerprintCategory: companionStatus,
        artifacts: [],
        createdAt: "2026-07-05T00:00:00.000Z",
        expiresAt: "2026-07-05T00:10:00.000Z",
        applyCommand: null
      });
      return envelope([
        status("codex", companionStatus),
        status("claude-code", "missing"),
        status("github-copilot", "missing")
      ]);
    }));
    renderPanel(locale);
    const codex = await screen.findByRole("article", { name: articleName });
    await user.click(within(codex).getByRole("button", { name: reviewName }));
    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm|apply|retry|force|确认|应用|重试|强制/i }))
      .not.toBeInTheDocument();
    cleanup();
    localStorage.clear();
  }
});

it("reviews and keyboard-confirms Upgrade with localized artifacts and a pending receipt", async () => {
  const user = userEvent.setup();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope({
      schemaVersion: 1,
      planId: "upgrade-plan",
      harness: "codex",
      action: "upgrade",
      status: "upgrade-available",
      availability: { state: "available", available: true, reason: null },
      targets: { hook: "/home/.codex/hooks.json", companion: "/home/.agents/skills/skill-steward-preflight" },
      fingerprintCategory: "recorded",
      artifacts: [
        { role: "companion-skill", operation: "upgrade" },
        { role: "harness-configuration", operation: "connect" }
      ],
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "skill-steward integrate apply --plan upgrade-plan --confirm"
    });
    if (url.endsWith("/codex/apply")) return envelope({
      planId: "upgrade-plan",
      action: "upgrade",
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000003",
        outcome: "ready",
        hook: "installed",
        companion: "upgraded",
        recordId: "record-3",
        cleanup: "pending",
        reasonCode: "INTEGRATION_READY_CLEANUP_PENDING",
        nextSafeAction: "recover-transaction"
      }
    });
    return envelope([
      status("codex", "upgrade-available"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel("zh-CN");
  const codex = await screen.findByRole("article", { name: "Codex Harness 集成" });
  expect(await within(codex).findByText("配套 Skill: 有可用升级")).toBeVisible();
  await user.click(within(codex).getByRole("button", { name: "检查 Codex 集成" }));
  const heading = await screen.findByRole("heading", { name: "升级配套 Skill" });
  const review = heading.closest("section");
  if (!review) throw new Error("Expected integration review section");
  expect(within(review).getByText("升级", { selector: "li span" })).toBeVisible();
  expect(within(review).getByText("配套 Skill", { selector: "li span" })).toBeVisible();
  expect(within(review).getByText("连接", { selector: "li span" })).toBeVisible();
  expect(within(review).getByText("Harness 配置", { selector: "li span" })).toBeVisible();
  expect(within(review).queryByText(/companion-skill|harness-configuration|upgrade|connect/))
    .not.toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "确认为 Codex 升级配套 Skill" });
  confirm.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(
    "事务已就绪 · 配套 Skill 已升级 · Hook 已安装 · 清理待完成 · 请先恢复此事务，再进行其他变更。"
  )).toBeVisible();
  const applyCall = calls.find(({ url }) => url.endsWith("/codex/apply"));
  expect(applyCall?.init?.body).toBe(JSON.stringify({ planId: "upgrade-plan" }));
});

it("reviews and keyboard-confirms an exact config no-op Connect receipt", async () => {
  const user = userEvent.setup();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope({
      schemaVersion: 1,
      planId: "connect-plan",
      harness: "codex",
      action: "connect",
      status: "current",
      availability: { state: "available", available: true, reason: null },
      targets: { hook: "/home/.codex/hooks.json", companion: "/home/.agents/skills/skill-steward-preflight" },
      fingerprintCategory: "recorded",
      artifacts: [{ role: "harness-configuration", operation: "connect" }],
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "skill-steward integrate apply --plan connect-plan --confirm"
    });
    if (url.endsWith("/codex/apply")) return envelope({
      planId: "connect-plan",
      action: "connect",
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000004",
        outcome: "ready",
        hook: "unchanged",
        companion: "unchanged",
        recordId: "record-4",
        cleanup: "clean",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none"
      }
    });
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel();
  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  await user.click(within(codex).getByRole("button", { name: "Review Codex integration" }));
  const heading = await screen.findByRole("heading", { name: "Connect Harness" });
  const review = heading.closest("section");
  if (!review) throw new Error("Expected integration review section");
  expect(within(review).getByText("Connect", { selector: "li span" })).toBeVisible();
  expect(within(review).getByText("Harness configuration", { selector: "li span" }))
    .toBeVisible();
  const confirm = screen.getByRole("button", { name: "Confirm Connect Harness for Codex" });
  confirm.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(
    "Transaction ready · companion unchanged · Hook unchanged · Cleanup complete · No further action is needed."
  )).toBeVisible();
  const applyCall = calls.find(({ url }) => url.endsWith("/codex/apply"));
  expect(applyCall?.init?.body).toBe(JSON.stringify({ planId: "connect-plan" }));
});

it("renders restored receipt truth distinctly", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope({
      schemaVersion: 1,
      planId: "restored-plan",
      harness: "codex",
      action: "connect",
      status: "current",
      availability: { state: "available", available: true, reason: null },
      targets: { hook: "/hook", companion: "/companion" },
      fingerprintCategory: "recorded",
      artifacts: [{ role: "harness-configuration", operation: "connect" }],
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "apply"
    });
    if (url.endsWith("/codex/apply")) return envelope({
      planId: "restored-plan",
      action: "connect",
      receipt: {
        transactionId: "00000000-0000-4000-8000-000000000005",
        outcome: "ready",
        hook: "restored",
        companion: "restored",
        recordId: "record-5",
        cleanup: "clean",
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none"
      }
    });
    return envelope([status("codex", "current"), status("claude-code", "missing"), status("github-copilot", "missing")]);
  }));
  renderPanel();
  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  await user.click(within(codex).getByRole("button", { name: "Review Codex integration" }));
  await user.click(screen.getByRole("button", { name: "Confirm Connect Harness for Codex" }));
  expect(await screen.findByText(
    "Transaction ready · companion restored · Hook restored · Cleanup complete · No further action is needed."
  )).toBeVisible();
});

it("renders a localized recovery-required error receipt without Retry or Force", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope({
      schemaVersion: 1,
      planId: "recovery-plan",
      harness: "codex",
      action: "connect",
      status: "current",
      availability: { state: "available", available: true, reason: null },
      targets: { hook: "/hook", companion: "/companion" },
      fingerprintCategory: "recorded",
      artifacts: [{ role: "harness-configuration", operation: "connect" }],
      createdAt: "2026-07-05T00:00:00.000Z",
      expiresAt: "2026-07-05T00:10:00.000Z",
      applyCommand: "apply"
    });
    if (url.endsWith("/codex/apply")) return envelope({
      code: "INTEGRATION_TRANSACTION_FAILED",
      message: "Companion transaction requires recovery",
      data: {
        receipt: {
          transactionId: "00000000-0000-4000-8000-000000000006",
          outcome: "recovery-required",
          hook: "unknown",
          companion: "unknown",
          recordId: "record-6",
          cleanup: "pending",
          reasonCode: "INTEGRATION_RECOVERY_REQUIRED",
          nextSafeAction: "recover-transaction"
        }
      }
    }, false);
    return envelope([status("codex", "current"), status("claude-code", "missing"), status("github-copilot", "missing")]);
  }));
  renderPanel("zh-CN");
  const codex = await screen.findByRole("article", { name: "Codex Harness 集成" });
  await user.click(within(codex).getByRole("button", { name: "检查 Codex 集成" }));
  await user.click(screen.getByRole("button", { name: "确认为 Codex 连接 Harness" }));
  expect(await screen.findByText(
    "需要恢复 · 配套 Skill 状态未知 · Hook 状态未知 · 清理待完成 · 请先恢复此事务，再进行其他变更。"
  )).toBeVisible();
  expect(screen.queryByRole("button", { name: /retry|force|重试|强制/i })).not.toBeInTheDocument();
});

it("synchronously blocks review, confirm, and cancel conflicts while a review is pending", async () => {
  const user = userEvent.setup();
  const pendingReview = deferred<ReturnType<typeof availablePlan>>();
  let claudeReviewRequests = 0;
  let applyRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope(availablePlan("old-plan"));
    if (url.endsWith("/claude-code/plan")) {
      claudeReviewRequests += 1;
      return envelope(await pendingReview.promise);
    }
    if (url.endsWith("/codex/apply")) {
      applyRequests += 1;
      return envelope(readyResult("old-plan"));
    }
    return envelope([
      status("codex", "current"),
      status("claude-code", "current"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel();

  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  await user.click(within(codex).getByRole("button", { name: "Review Codex integration" }));
  expect(await screen.findByText("/hook/old-plan")).toBeVisible();
  const claude = screen.getByRole("article", { name: "Claude Code Harness integration" });
  const reviewClaude = within(claude).getByRole("button", {
    name: "Review Claude Code integration"
  });
  fireEvent.click(reviewClaude);
  fireEvent.click(reviewClaude);

  await waitFor(() => expect(claudeReviewRequests).toBe(1));
  const confirm = screen.getByRole("button", { name: "Confirm Connect Harness for Codex" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(confirm).toBeDisabled();
  expect(cancel).toBeDisabled();
  expect(within(codex).getByRole("button", { name: "Review Codex integration" })).toBeDisabled();
  fireEvent.click(confirm);
  fireEvent.click(cancel);
  expect(applyRequests).toBe(0);
  expect(screen.getByText("/hook/old-plan")).toBeVisible();

  await act(async () => pendingReview.resolve(availablePlan("new-plan", "claude-code")));
  expect(await screen.findByText("/hook/new-plan")).toBeVisible();
});

it("synchronously sends exactly one apply request on a double click", async () => {
  const user = userEvent.setup();
  const pendingApply = deferred<ReturnType<typeof readyResult>>();
  let applyRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope(availablePlan("double-apply"));
    if (url.endsWith("/codex/apply")) {
      applyRequests += 1;
      return envelope(await pendingApply.promise);
    }
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel();

  const codex = await screen.findByRole("article", { name: "Codex Harness integration" });
  await user.click(within(codex).getByRole("button", { name: "Review Codex integration" }));
  const confirm = await screen.findByRole("button", {
    name: "Confirm Connect Harness for Codex"
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  await waitFor(() => expect(applyRequests).toBe(1));
  expect(confirm).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => pendingApply.resolve(readyResult("double-apply")));
  expect(await screen.findByText(
    "Transaction ready · companion unchanged · Hook unchanged · Cleanup complete · No further action is needed."
  )).toBeVisible();
});

it("clears an expired server-rejected plan, refreshes status, and never renders raw English", async () => {
  const user = userEvent.setup();
  let statusRequests = 0;
  const rawMessage = "Reviewed plan expired at /Users/private server-canary";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope(availablePlan("expired-plan"));
    if (url.endsWith("/codex/apply")) return envelope({
      code: "REVIEWED_PLAN_EXPIRED",
      message: rawMessage
    }, false);
    statusRequests += 1;
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel("zh-CN");

  const codex = await screen.findByRole("article", { name: "Codex Harness 集成" });
  await user.click(within(codex).getByRole("button", { name: "检查 Codex 集成" }));
  await user.click(screen.getByRole("button", { name: "确认为 Codex 连接 Harness" }));

  expect(await screen.findByText("已检查的集成计划已过期。请创建新计划。")).toBeVisible();
  await waitFor(() => expect(statusRequests).toBeGreaterThanOrEqual(2));
  expect(screen.queryByText("/hook/expired-plan")).not.toBeInTheDocument();
  expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Reviewed plan|Users|server-canary/u);
});

it("retains a plan only for transport-before-response failure and permits deliberate confirm retry", async () => {
  const user = userEvent.setup();
  let applyRequests = 0;
  const rawTransportMessage = "fetch EACCES /Users/private transport-canary";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope(availablePlan("transport-plan"));
    if (url.endsWith("/codex/apply")) {
      applyRequests += 1;
      if (applyRequests === 1) throw new TypeError(rawTransportMessage);
      return envelope(readyResult("transport-plan"));
    }
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel("zh-CN");

  const codex = await screen.findByRole("article", { name: "Codex Harness 集成" });
  await user.click(within(codex).getByRole("button", { name: "检查 Codex 集成" }));
  const confirm = await screen.findByRole("button", { name: "确认为 Codex 连接 Harness" });
  await user.click(confirm);

  expect(await screen.findByText("无法连接到本地 Skill Steward 服务。计划已保留，可再次确认。")).toBeVisible();
  expect(screen.getByText("/hook/transport-plan")).toBeVisible();
  expect(screen.queryByText(rawTransportMessage)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /retry|force|重试|强制/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "确认为 Codex 连接 Harness" }));
  expect(await screen.findByText(
    "事务已就绪 · 配套 Skill 未改变 · Hook 未改变 · 清理已完成 · 无需进一步操作。"
  )).toBeVisible();
  expect(applyRequests).toBe(2);
});

it.each([
  ["en-US", "list", "Could not load Harness integration data from the local Skill Steward service."],
  ["en-US", "capabilities", "Could not load Harness integration data from the local Skill Steward service."],
  ["zh-CN", "list", "无法从本地 Skill Steward 服务读取 Harness 集成数据。"],
  ["zh-CN", "capabilities", "无法从本地 Skill Steward 服务读取 Harness 集成数据。"]
] as const)("uses query-load copy for initial %s %s transport failure", async (
  locale,
  failingQuery,
  expected
) => {
  const rawMessage = `${failingQuery} EACCES /Users/private query-transport-canary`;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (
      (failingQuery === "list" && url === "/api/v1/integrations")
      || (failingQuery === "capabilities" && url.endsWith("/capabilities"))
    ) {
      throw new TypeError(rawMessage);
    }
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));

  renderPanel(locale);

  expect(await screen.findByText(expected)).toBeVisible();
  expect(document.body.textContent).not.toContain(rawMessage);
  expect(document.body.textContent).not.toMatch(
    /plan was retained|confirmed again|计划已保留|再次确认/u
  );
  expect(screen.queryByRole("button", {
    name: /confirm|retry|force|确认|重试|强制/i
  })).not.toBeInTheDocument();
});

it.each([
  ["en-US", "Could not load Harness integration data from the local Skill Steward service."],
  ["zh-CN", "无法从本地 Skill Steward 服务读取 Harness 集成数据。"]
] as const)("uses query-load copy for %s read-only refresh transport failure", async (
  locale,
  expected
) => {
  const user = userEvent.setup();
  const rawMessage = "refresh EACCES /Users/private query-refresh-canary";
  let statusRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return envelope(capabilities);
    if (url.endsWith("/codex/plan")) return envelope(availablePlan("refresh-plan"));
    if (url.endsWith("/codex/apply")) return envelope({
      code: "REVIEWED_PLAN_EXPIRED",
      message: "private expired response"
    }, false);
    statusRequests += 1;
    if (statusRequests > 1) throw new TypeError(rawMessage);
    return envelope([
      status("codex", "current"),
      status("claude-code", "missing"),
      status("github-copilot", "missing")
    ]);
  }));
  renderPanel(locale);

  const articleName = locale === "zh-CN"
    ? "Codex Harness 集成"
    : "Codex Harness integration";
  const reviewName = locale === "zh-CN"
    ? "检查 Codex 集成"
    : "Review Codex integration";
  const confirmName = locale === "zh-CN"
    ? "确认为 Codex 连接 Harness"
    : "Confirm Connect Harness for Codex";
  const codex = await screen.findByRole("article", { name: articleName });
  await user.click(within(codex).getByRole("button", { name: reviewName }));
  await user.click(await screen.findByRole("button", { name: confirmName }));

  expect(await screen.findByText(expected)).toBeVisible();
  expect(statusRequests).toBeGreaterThanOrEqual(2);
  expect(document.body.textContent).not.toContain(rawMessage);
  expect(document.body.textContent).not.toMatch(
    /plan was retained|confirmed again|计划已保留|再次确认/u
  );
  expect(screen.queryByRole("button", {
    name: /confirm|retry|force|确认|重试|强制/i
  })).not.toBeInTheDocument();
});
