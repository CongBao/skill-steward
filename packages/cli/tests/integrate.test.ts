import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLatestReport } from "@skill-steward/store";
import type { IntegrationTransactionOptions } from "@skill-steward/integrations";
import {
  createDashboardApp,
  createIntegrationServices
} from "@skill-steward/dashboard-server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/context.js";
import {
  integrateApplyCommand,
  integrateRemoveCommand
} from "../src/commands/integrate.js";
import { run } from "../src/main.js";

const packagedCompanion = new URL(
  "../../integrations/assets/skill-steward-preflight",
  import.meta.url
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "steward-integrate-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: home,
    home,
    stateDir: join(home, "state"),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    stdin: async () => "{}"
  };
  return { home, stdout, stderr, context };
}

describe("integrate command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  async function plan(harness: string) {
    expect(await run([
      "integrate", "plan", "--harness", harness, "--json"
    ], current.context), current.stderr.splice(0).join("")) .toBe(0);
    return JSON.parse(current.stdout.splice(0).join("")) as {
      planId: string;
      harness: string;
      action: string;
      status: string;
      availability: { available: boolean; reason: string | null };
      targets: { hook: string; companion: string };
      fingerprintCategory: string;
      artifacts: Array<{ role: string; operation: string }>;
      applyCommand: string | null;
    };
  }

  async function apply(planId: string) {
    const code = await run([
      "integrate", "apply", "--plan", planId, "--confirm", "--json"
    ], current.context);
    const output = current.stdout.splice(0).join("");
    return { code, output: output ? JSON.parse(output) : undefined };
  }

  it("delegates apply and reviewed disconnect to one high-level domain mutation", async () => {
    const source = await readFile(
      new URL("../src/commands/integrate.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("installCompanionSkill");
    expect(source).not.toContain("removeManagedCompanionSkill");
    expect(source).not.toContain("claimReviewedPlan");
    expect(source).not.toContain("withIntegrationMutationLease");
    expect(source).not.toContain("writeLatestReport");
    expect(source).not.toContain("rollbackIntegrationPlan");
    expect(source).not.toContain("removeIntegration");
    expect(source).toContain("planIntegrationDisconnect");
    expect(source).toContain("applyIntegrationDisconnect");
    expect(source).not.toContain("disconnectCompanionIntegrationTransaction");
  });

  it("creates the companion through one strict reviewed plan ID", async () => {
    const reviewed = await plan("codex");
    expect(reviewed).toMatchObject({
      harness: "codex",
      action: "create",
      status: "missing",
      availability: { available: process.platform !== "win32", reason: null },
      fingerprintCategory: "new",
      artifacts: [
        { role: "companion-skill", operation: "create" },
        { role: "harness-configuration", operation: "connect" }
      ],
      applyCommand: `skill-steward integrate apply --plan ${reviewed.planId} --confirm`
    });
    expect(JSON.stringify(reviewed)).not.toMatch(
      /backupPath|stagePath|recoveryPath|sourceDirectory|expectedBefore|proof|identity/u
    );
    expect(await exists(reviewed.targets.hook)).toBe(false);
    expect(await exists(reviewed.targets.companion)).toBe(false);

    expect(await run([
      "integrate", "apply", "--plan", reviewed.planId, "--json"
    ], current.context)).toBe(1);
    expect(JSON.parse(current.stderr.splice(0).join("")).error.code)
      .toBe("REVIEWED_PLAN_CONFIRMATION_REQUIRED");

    const applied = await apply(reviewed.planId);
    expect(applied).toMatchObject({
      code: 0,
      output: {
        planId: reviewed.planId,
        action: "create",
        receipt: {
          outcome: "ready",
          hook: "installed",
          companion: "created",
          reasonCode: "INTEGRATION_READY"
        }
      }
    });
    expect(await exists(reviewed.targets.hook)).toBe(true);
    expect(await exists(reviewed.targets.companion)).toBe(true);
    expect(await readLatestReport(current.context.stateDir)).toBeDefined();
    expect(await apply(reviewed.planId)).toMatchObject({ code: 1 });
    expect(JSON.parse(current.stderr.splice(0).join("")).error.code)
      .toBe("REVIEWED_PLAN_NOT_FOUND");
  });

  it("uses connect wording for a second exact consumer", async () => {
    expect((await apply((await plan("codex")).planId)).code).toBe(0);
    const reviewed = await plan("claude-code");
    expect(reviewed).toMatchObject({
      action: "connect",
      status: "current",
      availability: { available: true, reason: null },
      artifacts: [{ role: "harness-configuration", operation: "connect" }]
    });
    const applied = await apply(reviewed.planId);
    expect(applied).toMatchObject({
      code: 0,
      output: {
        action: "connect",
        receipt: { companion: "unchanged", hook: "installed" }
      }
    });
  });

  it("reviews and confirms a v2 disconnect while retaining the last companion", async () => {
    expect((await apply((await plan("codex")).planId)).code).toBe(0);
    const hook = join(current.home, ".codex", "hooks.json");
    const companion = join(current.home, ".agents", "skills", "skill-steward-preflight");
    const before = await readFile(hook, "utf8");

    expect(await run([
      "integrate", "remove", "--harness", "codex", "--json"
    ], current.context)).toBe(0);
    const reviewed = JSON.parse(current.stdout.splice(0).join("")) as {
      planId: string;
      action: string;
      lastConsumer: boolean;
      companionRetained: boolean;
      applyCommand: string;
    };
    expect(reviewed).toMatchObject({
      action: "disconnect",
      lastConsumer: true,
      companionRetained: true,
      applyCommand: `skill-steward integrate remove --plan ${reviewed.planId} --confirm`
    });
    expect(await readFile(hook, "utf8")).toBe(before);

    expect(await integrateRemoveCommand({
      plan: reviewed.planId,
      confirm: true,
      json: true
    }, current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      action: "disconnect",
      receipt: {
        hook: "removed",
        companion: "retained",
        reasonCode: "INTEGRATION_READY_FINAL_CLEANUP_PENDING",
        nextSafeAction: "review-final-cleanup"
      }
    });
    expect(await exists(companion)).toBe(true);
  });

  it("does not offer apply for conflict state", async () => {
    const companion = join(current.home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(dirname(companion), { recursive: true });
    await cp(packagedCompanion, companion, { recursive: true });
    await writeFile(join(companion, "extra.txt"), "unmanaged\n", "utf8");

    const reviewed = await plan("codex");
    expect(reviewed).toMatchObject({
      action: "blocked",
      status: "conflict",
      availability: { available: false }
    });
    expect(reviewed.applyCommand).toBeNull();
  });

  it("passes only a strict plan ID and readiness generator to the domain", async () => {
    const applyPlan = vi.fn(async (_planId: string, options: IntegrationTransactionOptions) => {
      await options.generateReadiness({
        transactionId: "00000000-0000-4000-8000-000000000001",
        recordId: "record-1",
        planId: "strict-plan-id",
        harness: "codex",
        action: "create"
      });
      return {
        transactionId: "00000000-0000-4000-8000-000000000001",
        outcome: "ready" as const,
        hook: "installed" as const,
        companion: "created" as const,
        recordId: "record-1",
        cleanup: "clean" as const,
        reasonCode: "INTEGRATION_READY",
        nextSafeAction: "none" as const
      };
    });
    expect(await integrateApplyCommand({
      plan: "strict-plan-id",
      confirm: true,
      json: true
    }, current.context, { applyPlan })).toBe(0);
    expect(applyPlan).toHaveBeenCalledTimes(1);
    expect(applyPlan.mock.calls[0]?.[0]).toBe("strict-plan-id");
    expect(applyPlan.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      home: current.home,
      stateDirectory: current.context.stateDir,
      generateReadiness: expect.any(Function)
    }));
    expect(applyPlan.mock.calls[0]?.[1]).not.toHaveProperty("proof");
    expect(applyPlan.mock.calls[0]?.[1]).not.toHaveProperty("leaseContext");
  });

  it("keeps CLI JSON and loopback API action, receipt, and error contracts identical", async () => {
    const receipt = {
      transactionId: "00000000-0000-4000-8000-000000000001",
      outcome: "ready" as const,
      hook: "installed" as const,
      companion: "upgraded" as const,
      recordId: "record-parity",
      cleanup: "clean" as const,
      reasonCode: "INTEGRATION_READY",
      nextSafeAction: "none" as const
    };
    const applyPlan = vi.fn(async () => receipt);
    expect(await integrateApplyCommand({
      plan: "parity-plan",
      confirm: true,
      json: true
    }, current.context, { applyPlan })).toBe(0);
    const cli = JSON.parse(current.stdout.splice(0).join(""));

    const services = createIntegrationServices({
      home: current.home,
      stateDirectory: current.context.stateDir,
      companionSkillDirectory: fileURLToPath(packagedCompanion),
      generateReadiness: async () => ({})
    }, { applyPlan });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices: services });
    try {
      const apiResponse = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/codex/apply",
        headers: { "x-skill-steward-token": "token" },
        payload: { planId: "parity-plan" }
      });
      expect(apiResponse.statusCode).toBe(200);
      expect(apiResponse.json().data).toEqual(cli);

      const failure = Object.assign(new Error("reviewed state changed"), {
        code: "INTEGRATION_DRIFTED"
      });
      const failingApply = vi.fn(async () => { throw failure; });
      expect(await integrateApplyCommand({
        plan: "error-plan",
        confirm: true,
        json: true
      }, current.context, { applyPlan: failingApply })).toBe(1);
      const cliError = JSON.parse(current.stderr.splice(0).join("")).error;
      const failingServices = createIntegrationServices({
        home: current.home,
        stateDirectory: current.context.stateDir,
        companionSkillDirectory: fileURLToPath(packagedCompanion),
        generateReadiness: async () => ({})
      }, { applyPlan: failingApply });
      const { app: failingApp } = createDashboardApp({
        mutationToken: "token",
        integrationServices: failingServices
      });
      try {
        const failed = await failingApp.inject({
          method: "POST",
          url: "/api/v1/integrations/codex/apply",
          headers: { "x-skill-steward-token": "token" },
          payload: { planId: "error-plan" }
        });
        expect(failed.statusCode).toBe(409);
        expect(failed.json().error).toMatchObject(cliError);
      } finally {
        await failingApp.close();
      }
    } finally {
      await app.close();
    }
  });

  it("normalizes unknown system errors without exposing private CLI details", async () => {
    const canary = join(current.home, ".codex", "cli-canary");
    const applyPlan = vi.fn(async () => {
      throw Object.assign(new Error(`EACCES: lstat '${canary}' cli-canary`), {
        code: "EACCES",
        path: canary,
        syscall: "lstat",
        stack: "cli-canary-stack"
      });
    });

    expect(await integrateApplyCommand({
      plan: "private-error-plan",
      confirm: true,
      json: true
    }, current.context, { applyPlan })).toBe(1);

    const output = current.stderr.splice(0).join("");
    expect(JSON.parse(output).error).toEqual({
      code: "INTEGRATION_OPERATION_FAILED",
      message: "Integration operation could not be completed safely."
    });
    expect(output).not.toMatch(/EACCES|lstat|cli-canary|\.codex|stack|cause/u);
    expect(output).not.toContain(current.home);
  });
});
