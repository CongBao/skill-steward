import { access, chmod, cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  removeIntegration,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions
} from "@skill-steward/integrations";
import {
  readLatestReport,
  withIntegrationMutationLease,
  type IntegrationRecord
} from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import {
  integrateApplyCommand,
  integrateRemoveCommand
} from "../src/commands/integrate.js";
import { run } from "../src/main.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

const packagedCompanion = new URL(
  "../../integrations/assets/skill-steward-preflight",
  import.meta.url
);

async function applyIntegrationPlanInternal(
  plan: unknown,
  options: IntegrationConfigOptions,
  dependencyOverrides?: unknown
): Promise<IntegrationRecord> {
  const modulePath = ["../../integrations/src", "config.js"].join("/");
  const internal = await import(modulePath) as {
    applyIntegrationPlanInternal(
      input: unknown,
      config: IntegrationConfigOptions,
      dependencies?: unknown
    ): Promise<IntegrationRecord>;
  };
  return internal.applyIntegrationPlanInternal(plan, options, dependencyOverrides);
}

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
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "recommend a preflight skill",
      cwd: home
    })
  };
  return { home, stdout, stderr, context };
}

async function installCurrentCompanion(home: string): Promise<void> {
  const destination = join(home, ".agents", "skills", "skill-steward-preflight");
  await mkdir(dirname(destination), { recursive: true });
  await cp(packagedCompanion, destination, { recursive: true });
}

async function authorizeRecordedCompanion(
  stateDirectory: string,
  planId: string
): Promise<void> {
  const path = join(stateDirectory, "reviewed-plans", `${planId}.json`);
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const companion = envelope.payload.companion;
  if (
    companion.action !== "conflict"
    || companion.expectedBefore?.state !== "exact"
    || companion.expectedBefore.fingerprint !== companion.after.fingerprint
  ) return;
  envelope.payload.companion = {
    ...companion,
    action: "none",
    expectedBefore: { state: "exact", fingerprint: companion.after.fingerprint },
    proof: {
      kind: "recorded",
      recordId: "fixture-current-companion",
      installedFingerprint: companion.after.fingerprint
    }
  };
  await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

describe("integrate command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
    await installCurrentCompanion(current.home);
  });

  async function preview(harness: string) {
    const code = await run([
      "integrate", "plan", "--harness", harness, "--json"
    ], current.context);
    expect(code, current.stderr.splice(0).join("")).toBe(0);
    const plan = JSON.parse(current.stdout.splice(0).join("")) as {
      id: string;
      expiresAt: string;
      changes: Array<{ operation: string; path: string }>;
      applyCommand: string;
      companion: { action: string; proof: { kind: string } };
    };
    await authorizeRecordedCompanion(current.context.stateDir, plan.id);
    return plan;
  }

  async function apply(planId: string, json = false) {
    const code = await integrateApplyCommand({
      plan: planId,
      confirm: true,
      json
    }, current.context, { applyPlan: applyIntegrationPlanInternal });
    current.stdout.splice(0);
    return code;
  }

  it("fails closed without installing a missing companion in the read-only phase", async () => {
    const fresh = await fixture();
    expect(await run([
      "integrate", "plan", "--harness", "codex", "--json"
    ], fresh.context)).toBe(0);
    const plan = JSON.parse(fresh.stdout.splice(0).join("")) as { id: string };
    const skill = join(fresh.home, ".agents", "skills", "skill-steward-preflight");
    const config = join(fresh.home, ".codex", "hooks.json");

    expect(await run([
      "integrate", "apply", "--plan", plan.id, "--confirm"
    ], fresh.context)).toBe(1);
    expect(fresh.stderr.splice(0).join(""))
      .toContain("INTEGRATION_COMPANION_ACTION_UNAVAILABLE");
    expect(await exists(skill)).toBe(false);
    expect(await exists(config)).toBe(false);
  });

  it("keeps Phase 1 apply and remove free of legacy companion mutators", async () => {
    const source = await readFile(
      new URL("../src/commands/integrate.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("installCompanionSkill");
    expect(source).not.toContain("removeManagedCompanionSkill");
  });

  it("persists an exact plan across calls and prepares the first prompt Hook", async () => {
    const config = join(current.home, ".codex", "hooks.json");
    const skill = join(current.home, ".agents", "skills", "skill-steward-preflight", "SKILL.md");
    const plan = await preview("codex");
    expect(plan).toMatchObject({
      changes: expect.arrayContaining([expect.objectContaining({ operation: "write" })]),
      applyCommand: `skill-steward integrate apply --plan ${plan.id} --confirm`,
      companion: {
        action: "conflict",
        proof: { kind: "conflict" }
      }
    });
    expect(plan.expiresAt).toBe("2026-07-03T00:10:00.000Z");
    expect(await exists(config)).toBe(false);
    expect(await exists(skill)).toBe(true);

    expect(await run([
      "integrate", "apply", "--plan", plan.id
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("--confirm");
    expect(await apply(plan.id, true)).toBe(0);
    expect(await readFile(config, "utf8")).toContain(
      "skill-steward hook prompt --harness codex"
    );
    expect(await readFile(skill, "utf8")).toContain("name: skill-steward-preflight");
    expect(await readLatestReport(current.context.stateDir)).toBeDefined();
    current.stdout.splice(0);
    expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toHaveProperty("hookSpecificOutput");
    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_NOT_FOUND");
    current.stdout.splice(0);
    expect(await run([
      "integrate", "status", "--harness", "codex", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({ status: "needs-trust" });
  });

  it("uses shared native inventory for the initial readiness scan", async () => {
    await installNativeCodexFixture(current.home);
    const plan = await preview("codex");

    expect(await apply(plan.id, true)).toBe(0);
    expect(await readLatestReport(current.context.stateDir)).toMatchObject({
      schemaVersion: 2,
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "native-review", ownership: "native-plugin" })
      ]),
      inventory: {
        harnesses: expect.arrayContaining([
          expect.objectContaining({ harness: "codex", status: "verified" })
        ])
      }
    });
  });

  it("does not consume a reviewed plan when the integration lease is busy", async () => {
    const plan = await preview("codex");
    let release!: () => void;
    const held = withIntegrationMutationLease(current.context.stateDir, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    while (!await exists(join(current.context.stateDir, "integration-mutation.lease"))) {
      await delay(2);
    }

    const busyDependencies = {
      withLease: <T>(stateDirectory: string, operation: () => Promise<T>) =>
        withIntegrationMutationLease(stateDirectory, operation, {
          waitMs: 15,
          pollMs: 2
        })
    } as unknown as Parameters<typeof integrateApplyCommand>[2];
    expect(await integrateApplyCommand({
      plan: plan.id,
      confirm: true,
      json: false
    }, current.context, busyDependencies)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("INTEGRATION_BUSY");

    release();
    await held;
    expect(await apply(plan.id)).toBe(0);
  });

  it("retains the shared Skill after every Phase 1 Hook removal", async () => {
    for (const harness of ["codex", "claude-code", "github-copilot"]) {
      expect(await apply((await preview(harness)).id)).toBe(0);
    }
    const skillDirectory = join(current.home, ".agents", "skills", "skill-steward-preflight");
    expect(await run([
      "integrate", "remove", "--harness", "codex", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(true);
    expect(await run([
      "integrate", "remove", "--harness", "claude-code", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(true);
    expect(await run([
      "integrate", "remove", "--harness", "github-copilot", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(true);
    expect(current.stdout.splice(0).join(""))
      .toContain("retained pending reviewed consumer-aware removal");
  });

  it("retains modified and unreadable companion trees during Hook removal", async () => {
    const companion = join(current.home, ".agents", "skills", "skill-steward-preflight");
    const skill = join(companion, "SKILL.md");

    expect(await apply((await preview("codex")).id)).toBe(0);
    await writeFile(skill, "user modified\n", "utf8");
    expect(await run([
      "integrate", "remove", "--harness", "codex", "--confirm"
    ], current.context)).toBe(0);
    expect(await readFile(skill, "utf8")).toBe("user modified\n");
    current.stdout.splice(0);

    await rm(companion, { recursive: true, force: true });
    await installCurrentCompanion(current.home);
    const claudePlan = await preview("claude-code");
    expect(await apply(claudePlan.id)).toBe(0);
    await chmod(companion, 0o000);
    try {
      expect(await run([
        "integrate", "remove", "--harness", "claude-code", "--confirm"
      ], current.context)).toBe(0);
      expect(await exists(companion)).toBe(true);
    } finally {
      await chmod(companion, 0o700);
    }
  });

  it("reports all three native integration capability adapters by default", async () => {
    expect(await run(["integrate", "status", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join("")).map(({ harness }: { harness: string }) => harness))
      .toEqual(["codex", "claude-code", "github-copilot"]);
  });

  it("refuses a different existing companion Skill before changing Harness config", async () => {
    const skill = join(current.home, ".agents", "skills", "skill-steward-preflight", "SKILL.md");
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, "different", "utf8");
    const plan = await preview("codex");
    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.join("")).toContain("INTEGRATION_COMPANION_ACTION_UNAVAILABLE");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
  });

  it("refuses ambiguous raw apply inputs and confirmation without a plan", async () => {
    expect(await run([
      "integrate", "apply", "--harness", "codex", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("--plan");
    const plan = await preview("codex");
    expect(await run([
      "integrate", "apply", "--plan", plan.id, "--harness", "codex", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("ambiguous");
  });

  it("consumes drifted and expired plans without regenerating them", async () => {
    const config = join(current.home, ".codex", "hooks.json");
    const drifted = await preview("codex");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, '{"external":true}\n', "utf8");
    expect(await apply(drifted.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("consumed");
    expect(await readFile(config, "utf8")).toBe('{"external":true}\n');
    expect(await apply(drifted.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_NOT_FOUND");

    const claude = await preview("claude-code");
    current.context.now = () => new Date("2026-07-03T00:10:00.000Z");
    expect(await apply(claude.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_EXPIRED");
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses wrong-kind and tampered stored payloads without mutation", async () => {
    const wrongKind = await preview("codex");
    const wrongKindPath = join(
      current.context.stateDir, "reviewed-plans", `${wrongKind.id}.json`
    );
    const wrongEnvelope = JSON.parse(await readFile(wrongKindPath, "utf8"));
    await writeFile(wrongKindPath, `${JSON.stringify({
      ...wrongEnvelope,
      kind: "governance"
    })}\n`, "utf8");
    expect(await apply(wrongKind.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_KIND_MISMATCH");

    const tampered = await preview("codex");
    const tamperedPath = join(
      current.context.stateDir, "reviewed-plans", `${tampered.id}.json`
    );
    const tamperedEnvelope = JSON.parse(await readFile(tamperedPath, "utf8"));
    tamperedEnvelope.payload.targetPath = join(current.home, ".claude", "settings.json");
    await writeFile(tamperedPath, `${JSON.stringify(tamperedEnvelope)}\n`, "utf8");
    expect(await apply(tampered.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("consumed");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(false);
  });

  it("rolls back only artifacts created by an apply whose readiness scan fails", async () => {
    const plan = await preview("codex");
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(plan.id)).toBe(1);
    const error = current.stderr.splice(0).join("");
    expect(error).toContain("INTEGRATION_READINESS_FAILED");
    expect(error).toContain("rolled back");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("retains the pre-existing companion after a journal failure", async () => {
    const plan = await preview("codex");
    await writeFile(join(current.context.stateDir, "integration-records"), "blocked", "utf8");

    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("EEXIST");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("rolls back config while retaining the companion when the legacy journal is malformed", async () => {
    const plan = await preview("codex");
    await writeFile(join(current.context.stateDir, "integrations.json"), "not-json\n", "utf8");

    expect(await apply(plan.id)).toBe(1);
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("retains config and companion when journal commit is uncertain", async () => {
    const plan = await preview("codex");
    const uncertain = Object.assign(new Error("journal commit cannot be proven"), {
      code: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN"
    });
    expect(await integrateApplyCommand({
      plan: plan.id,
      confirm: true,
      json: false
    }, current.context, {
      applyPlan: (reviewedPlan, options) => applyIntegrationPlanInternal(reviewedPlan, options, {
        appendRecord: async () => { throw uncertain; }
      })
    })).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("INTEGRATION_ROLLBACK_FAILED");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(true);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("retains installed artifacts when readiness rollback cannot journal removal", async () => {
    const plan = await preview("codex");
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    const appendFailure = new Error("removed record was not committed");
    const external = '{"external":"during-cli-rollback"}\n';
    expect(await integrateApplyCommand({
      plan: plan.id,
      confirm: true,
      json: false
    }, current.context, {
      applyPlan: applyIntegrationPlanInternal,
      rollbackPlan: (reviewedPlan, options) => rollbackIntegrationPlan(
        reviewedPlan,
        options,
        {
          appendRecord: async () => {
            await writeFile(
              (reviewedPlan as { targetPath: string }).targetPath,
              external,
              "utf8"
            );
            throw appendFailure;
          }
        }
      )
    })).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("INTEGRATION_ROLLBACK_FAILED");
    expect(await readFile(join(current.home, ".codex", "hooks.json"), "utf8"))
      .toBe(external);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("preserves external drift and companion when removal journaling fails", async () => {
    expect(await apply((await preview("codex")).id)).toBe(0);
    const external = '{"external":"during-cli-remove"}\n';
    const appendFailure = new Error("removed record was not committed");

    expect(await integrateRemoveCommand("codex", true, current.context, {
      remove: (harness, options) => removeIntegration(harness, options, {
        appendRecord: async () => {
          await writeFile(join(current.home, ".codex", "hooks.json"), external, "utf8");
          throw appendFailure;
        }
      })
    })).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("INTEGRATION_ROLLBACK_FAILED");
    expect(await readFile(join(current.home, ".codex", "hooks.json"), "utf8")).toBe(external);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("preserves a pre-existing companion and integration during failed readiness", async () => {
    const claude = await preview("claude-code");
    expect(await apply(claude.id)).toBe(0);
    current.stdout.splice(0);
    const companion = join(current.home, ".agents", "skills", "skill-steward-preflight");
    const codex = await preview("codex");
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(codex.id)).toBe(1);
    expect(await exists(companion)).toBe(true);
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(true);
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
  });

  it("preserves a no-op pre-existing integration when readiness fails", async () => {
    const first = await preview("codex");
    expect(await apply(first.id)).toBe(0);
    current.stdout.splice(0);
    const config = join(current.home, ".codex", "hooks.json");
    const before = await readFile(config, "utf8");
    const noop = await preview("codex");
    expect(noop.changes).toEqual([]);
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(noop.id)).toBe(1);
    expect(await readFile(config, "utf8")).toBe(before);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });
});
