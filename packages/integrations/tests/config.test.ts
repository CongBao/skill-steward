import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIntegrationRecords } from "@skill-steward/store";
import { describe, expect, it } from "vitest";
import {
  applyIntegrationPlan,
  integrationPlanSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  rethrowAfterIntegrationApplyFailure,
  rollbackIntegrationPlan
} from "../src/config.js";

const applyFixture = fileURLToPath(
  new URL("./fixtures/integration-apply.mjs", import.meta.url)
);

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function integrationWorker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [applyFixture, ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`integration worker exited ${code}: ${stderr}`)));
  });
}

function target(home: string, harness: "codex" | "claude-code"): string {
  return harness === "codex"
    ? join(home, ".codex", "hooks.json")
    : join(home, ".claude", "settings.json");
}

async function seed(home: string, harness: "codex" | "claude-code") {
  const path = target(home, harness);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    unrelated: true,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }]
    }
  }, null, 2)}\n`, "utf8");
  return path;
}

describe.each(["codex", "claude-code"] as const)("%s integration config", (harness) => {
  it("plans, backs up, applies, reports status, and removes without replacing unrelated settings", async () => {
    const home = await mkdtemp(join(tmpdir(), `steward-${harness}-home-`));
    const stateDirectory = join(home, "state");
    const path = await seed(home, harness);
    const options = {
      home,
      stateDirectory,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
      id: () => `integration-${harness}`
    };

    const plan = await planIntegration(harness, options);
    expect(plan.changes).toEqual([
      expect.objectContaining({ operation: "backup", path }),
      expect.objectContaining({ operation: "write", path })
    ]);
    const record = await applyIntegrationPlan(plan, options);
    expect(record.status).toBe("installed");
    const applied = JSON.parse(await readFile(path, "utf8"));
    expect(applied).toMatchObject({ unrelated: true });
    expect(JSON.stringify(applied)).toContain(
      `skill-steward hook prompt --harness ${harness}`
    );
    expect(applied.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(applied.hooks.Stop)).toContain(
      `skill-steward hook lifecycle --harness ${harness}`
    );
    if (harness === "claude-code") {
      expect(applied.hooks.SessionEnd).toHaveLength(1);
    } else {
      expect(applied.hooks.SessionEnd).toBeUndefined();
    }
    expect(JSON.stringify(applied)).toContain("keep-me");
    expect(await readFile(plan.backupPath!, "utf8")).toContain("keep-me");
    expect(await integrationStatus(harness, options)).toMatchObject({
      status: harness === "codex" ? "needs-trust" : "installed",
      targetPath: path
    });

    const removed = await removeIntegration(harness, options);
    expect(removed.status).toBe("removed");
    const afterRemoval = JSON.parse(await readFile(path, "utf8"));
    expect(afterRemoval).toMatchObject({ unrelated: true });
    expect(JSON.stringify(afterRemoval)).toContain("keep-me");
    expect(JSON.stringify(afterRemoval)).not.toContain("skill-steward hook prompt");
    expect(JSON.stringify(afterRemoval)).not.toContain("skill-steward hook lifecycle");
  });
});

it("refuses malformed configuration without changing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-invalid-config-"));
  const stateDirectory = join(home, "state");
  const path = target(home, "codex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not-json", "utf8");
  await expect(planIntegration("codex", { home, stateDirectory })).rejects.toMatchObject({
    code: "INTEGRATION_CONFIG_INVALID"
  });
  expect(await readFile(path, "utf8")).toBe("not-json");
});

it("refuses drifted removal without writing", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-drift-config-"));
  const stateDirectory = join(home, "state");
  const path = await seed(home, "codex");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  const plan = await planIntegration("codex", options);
  await applyIntegrationPlan(plan, options);
  const drifted = (await readFile(path, "utf8")).replace(
    "skill-steward hook prompt --harness codex",
    "skill-steward hook prompt --harness codex --changed"
  );
  await writeFile(path, drifted, "utf8");
  await expect(removeIntegration("codex", options)).rejects.toMatchObject({
    code: "INTEGRATION_DRIFTED"
  });
  expect(await readFile(path, "utf8")).toBe(drifted);
});

it("produces an idempotent plan without a phantom backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-idempotent-config-"));
  const stateDirectory = join(home, "state");
  await seed(home, "claude-code");
  const options = { home, stateDirectory };
  await applyIntegrationPlan(await planIntegration("claude-code", options), options);
  const second = await planIntegration("claude-code", options);
  expect(second.changes).toEqual([]);
  expect(second.backupPath).toBeUndefined();
  await applyIntegrationPlan(second, options);
  await expect(integrationStatus("claude-code", options)).resolves.toMatchObject({
    status: "installed"
  });
  await expect(removeIntegration("claude-code", options)).resolves.toMatchObject({
    status: "removed"
  });
});

it("refuses non-canonical managed Hook groups in full and partial bundles", async () => {
  for (const partial of [false, true]) {
    const home = await mkdtemp(join(tmpdir(), `steward-noncanonical-${partial}-`));
    const stateDirectory = join(home, "state");
    const path = target(home, "codex");
    const options = {
      home,
      stateDirectory,
      now: () => new Date("2026-07-03T00:00:00.000Z")
    };
    await applyIntegrationPlan(await planIntegration("codex", options), options);
    const config = JSON.parse(await readFile(path, "utf8"));
    config.hooks.UserPromptSubmit[0].hooks[0].timeout = 99;
    config.hooks.UserPromptSubmit[0].extra = "not managed";
    if (partial) delete config.hooks.Stop;
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await expect(planIntegration("codex", options)).rejects.toMatchObject({
      code: "INTEGRATION_DRIFTED"
    });
  }
});

it("rolls back an applied plan to exact reviewed bytes or a missing target", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-exact-rollback-"));
  const stateDirectory = join(home, "state");
  const path = await seed(home, "codex");
  const original = await readFile(path, "utf8");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  const plan = await planIntegration("codex", options);
  await applyIntegrationPlan(plan, options);
  await rollbackIntegrationPlan(plan, options);
  expect(await readFile(path, "utf8")).toBe(original);

  const cleanHome = await mkdtemp(join(tmpdir(), "steward-delete-rollback-"));
  const cleanOptions = { ...options, home: cleanHome, stateDirectory: join(cleanHome, "state") };
  const cleanPlan = await planIntegration("codex", cleanOptions);
  await applyIntegrationPlan(cleanPlan, cleanOptions);
  await rollbackIntegrationPlan(cleanPlan, cleanOptions);
  await expect(access(target(cleanHome, "codex"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("restores configuration when the post-apply journal cannot commit", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-journal-rollback-"));
  const stateDirectory = join(home, "state");
  const plan = await planIntegration("codex", {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, "integration-records"), "blocked", "utf8");

  await expect(applyIntegrationPlan(plan, {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  })).rejects.toBeDefined();
  await expect(access(target(home, "codex"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("restores configuration when the legacy journal is malformed", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-legacy-journal-rollback-"));
  const stateDirectory = join(home, "state");
  const path = await seed(home, "codex");
  const before = await readFile(path, "utf8");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  const plan = await planIntegration("codex", options);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, "integrations.json"), "not-json\n", "utf8");

  await expect(applyIntegrationPlan(plan, options)).rejects.toBeDefined();
  expect(await readFile(path, "utf8")).toBe(before);
  await expect(access(join(stateDirectory, "integration-records")))
    .rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves journal and rollback failures in one cause chain", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-journal-cause-"));
  const stateDirectory = join(home, "state");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  const plan = await planIntegration("codex", options);
  const journalFailure = new Error("journal failed");
  const failure = await applyIntegrationPlan(plan, options, {
    appendRecord: async () => {
      const applied = JSON.parse(await readFile(plan.targetPath, "utf8"));
      await writeFile(
        plan.targetPath,
        `${JSON.stringify({ ...applied, changedDuringJournal: true })}\n`,
        "utf8"
      );
      throw journalFailure;
    }
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: "INTEGRATION_ROLLBACK_FAILED" });
  expect((failure as Error).cause).toBeInstanceOf(AggregateError);
  const causes = ((failure as Error).cause as AggregateError).errors;
  expect(causes[0]).toBe(journalFailure);
  expect(causes[1]).toMatchObject({ code: "INTEGRATION_DRIFTED" });
  expect(await readFile(plan.targetPath, "utf8")).toContain("changedDuringJournal");
});

it("cleans companions only when the domain proves configuration rollback", async () => {
  const journalFailure = Object.assign(new Error("journal is unreadable"), { code: "EISDIR" });
  const cleaned = await rethrowAfterIntegrationApplyFailure({
    error: journalFailure,
    companionCreated: true,
    removeCompanion: async () => true
  }).catch((error: unknown) => error);
  expect(cleaned).toBe(journalFailure);

  const cleanupFailure = await rethrowAfterIntegrationApplyFailure({
    error: journalFailure,
    companionCreated: true,
    removeCompanion: async () => false
  }).catch((error: unknown) => error);
  expect(cleanupFailure).toMatchObject({
    code: "INTEGRATION_ROLLBACK_FAILED",
    cause: journalFailure
  });
  expect((cleanupFailure as Error).message).toContain("companion Skill");

  const thrownCleanup = await rethrowAfterIntegrationApplyFailure({
    error: journalFailure,
    companionCreated: true,
    removeCompanion: async () => {
      throw new Error("permission denied");
    }
  }).catch((error: unknown) => error);
  expect(thrownCleanup).toMatchObject({
    code: "INTEGRATION_ROLLBACK_FAILED",
    cause: journalFailure
  });
  expect((thrownCleanup as Error).message).toContain("permission denied");

  const incompleteRollback = new Error("configuration may still be active");
  Object.defineProperty(incompleteRollback, "code", {
    value: "INTEGRATION_ROLLBACK_FAILED",
    enumerable: true
  });
  let cleanupCalled = false;
  const preserved = await rethrowAfterIntegrationApplyFailure({
    error: incompleteRollback,
    companionCreated: true,
    removeCompanion: async () => {
      cleanupCalled = true;
      return true;
    }
  }).catch((error: unknown) => error);
  expect(preserved).toBe(incompleteRollback);
  expect(cleanupCalled).toBe(false);
});

it.each([
  { harness: "codex" as const, ancestor: ".codex", outsideTarget: "hooks.json" },
  {
    harness: "github-copilot" as const,
    ancestor: ".copilot",
    outsideTarget: join("hooks", "skill-steward.json")
  }
])("refuses a static symlinked ancestor for $harness", async ({
  harness,
  ancestor,
  outsideTarget
}) => {
  const home = await mkdtemp(join(tmpdir(), `steward-${harness}-ancestor-`));
  const outside = await mkdtemp(join(tmpdir(), "steward-outside-"));
  await symlink(outside, join(home, ancestor), "dir");

  await expect(planIntegration(harness, {
    home,
    stateDirectory: join(home, "state")
  })).rejects.toMatchObject({ code: "INTEGRATION_UNSAFE_PATH" });
  await expect(access(join(outside, outsideTarget))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rechecks a newly symlinked missing Copilot ancestor before apply", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-copilot-race-"));
  const outside = await mkdtemp(join(tmpdir(), "steward-outside-race-"));
  const options = { home, stateDirectory: join(home, "state") };
  const plan = await planIntegration("github-copilot", options);
  await symlink(outside, join(home, ".copilot"), "dir");

  await expect(applyIntegrationPlan(plan, options)).rejects.toMatchObject({
    code: "INTEGRATION_UNSAFE_PATH"
  });
  await expect(access(join(outside, "hooks", "skill-steward.json")))
    .rejects.toMatchObject({ code: "ENOENT" });
});

it("creates normal missing Copilot ancestor directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-copilot-missing-"));
  const options = { home, stateDirectory: join(home, "state") };
  await applyIntegrationPlan(await planIntegration("github-copilot", options), options);
  await expect(access(join(home, ".copilot", "hooks", "skill-steward.json")))
    .resolves.toBeUndefined();
});

it("keeps concurrent cross-Harness apply journals removable", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-concurrent-apply-"));
  const stateDirectory = join(home, "state");
  const barrier = join(home, "barrier");
  const readyCodex = join(home, "ready-codex");
  const readyClaude = join(home, "ready-claude");
  const count = 10;
  const workers = [
    integrationWorker([
      home, stateDirectory, "codex", readyCodex, barrier, String(count)
    ]),
    integrationWorker([
      home, stateDirectory, "claude-code", readyClaude, barrier, String(count)
    ])
  ];
  await Promise.all([waitForFile(readyCodex), waitForFile(readyClaude)]);
  await writeFile(barrier, "go\n", "utf8");
  await Promise.all(workers);

  const records = await readIntegrationRecords(stateDirectory);
  expect(records.filter(({ harness }) => harness === "codex")).toHaveLength(count);
  expect(records.filter(({ harness }) => harness === "claude-code")).toHaveLength(count);
  await expect(removeIntegration("codex", { home, stateDirectory }))
    .resolves.toMatchObject({ status: "removed" });
  await expect(removeIntegration("claude-code", { home, stateDirectory }))
    .resolves.toMatchObject({ status: "removed" });
}, 15_000);

it("creates a strict ten-minute plan and refuses expired plans before writing", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-expired-config-"));
  const stateDirectory = join(home, "state");
  const path = await seed(home, "codex");
  const before = await readFile(path, "utf8");
  const plan = await planIntegration("codex", {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    id: () => "integration-expiry"
  });

  expect(plan.expiresAt).toBe("2026-07-03T00:10:00.000Z");
  expect(integrationPlanSchema.safeParse({ ...plan, unexpected: true }).success).toBe(false);
  await expect(applyIntegrationPlan(plan, {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:10:00.000Z")
  })).rejects.toMatchObject({ code: "INTEGRATION_PLAN_EXPIRED" });
  expect(await readFile(path, "utf8")).toBe(before);
});

it("rejects tampered plan paths, changes, fingerprints, and non-JSON config", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-strict-plan-"));
  const stateDirectory = join(home, "state");
  await seed(home, "codex");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    id: () => "integration-strict"
  };
  const plan = await planIntegration("codex", options);
  const accessorConfig = Object.defineProperty({}, "computed", {
    enumerable: true,
    get: () => "not plain JSON"
  });
  expect(integrationPlanSchema.safeParse({
    ...plan,
    afterConfig: accessorConfig
  }).success).toBe(false);
  const wrongTarget = join(home, ".claude", "settings.json");
  const wrongTargetPlan = {
    ...plan,
    targetPath: wrongTarget,
    backupPath: plan.backupPath!.replace(plan.targetPath, wrongTarget),
    changes: [
      { operation: "backup" as const, path: wrongTarget },
      { operation: "write" as const, path: wrongTarget }
    ]
  };
  expect(integrationPlanSchema.safeParse(wrongTargetPlan).success).toBe(true);
  await expect(applyIntegrationPlan(wrongTargetPlan, options)).rejects.toMatchObject({
    code: "INTEGRATION_UNSAFE_PATH"
  });

  for (const tampered of [
    { ...plan, changes: [{ operation: "write", path: join(home, "elsewhere.json") }] },
    { ...plan, afterFingerprint: "sha256:not-a-fingerprint" },
    { ...plan, installedEntryFingerprint: plan.afterFingerprint },
    { ...plan, afterConfig: { invalid: undefined } }
  ]) {
    await expect(applyIntegrationPlan(tampered, options)).rejects.toMatchObject({
      code: expect.stringMatching(/^INTEGRATION_/)
    });
  }

  const cleanHome = await mkdtemp(join(tmpdir(), "steward-strict-clean-"));
  const cleanOptions = { ...options, home: cleanHome, stateDirectory: join(cleanHome, "state") };
  const cleanPlan = await planIntegration("codex", cleanOptions);
  const hiddenWrite = { ...cleanPlan, changes: [] };
  expect(integrationPlanSchema.safeParse(hiddenWrite).success).toBe(true);
  await expect(applyIntegrationPlan(hiddenWrite, cleanOptions)).rejects.toMatchObject({
    code: "INTEGRATION_DRIFTED"
  });
});

it("manages only the dedicated Copilot Hook file and removes it only without drift", async () => {
  const home = await mkdtemp(join(tmpdir(), "steward-copilot-home-"));
  const stateDirectory = join(home, "state");
  const hookDirectory = join(home, ".copilot", "hooks");
  const unrelatedPath = join(hookDirectory, "keep-me.json");
  const targetPath = join(hookDirectory, "skill-steward.json");
  await mkdir(hookDirectory, { recursive: true });
  await writeFile(unrelatedPath, "UNRELATED-BYTES\n", "utf8");
  const options = {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    id: () => "integration-github-copilot"
  };

  const plan = await planIntegration("github-copilot", options);
  expect(plan.targetPath).toBe(targetPath);
  expect(plan.changes).toEqual([{ operation: "write", path: targetPath }]);
  await applyIntegrationPlan(plan, options);
  const config = JSON.parse(await readFile(targetPath, "utf8"));
  expect(config).toEqual({
    version: 1,
    hooks: {
      userPromptSubmitted: [expect.objectContaining({
        type: "command",
        bash: "skill-steward hook observe --harness github-copilot --event userPromptSubmitted"
      })],
      sessionEnd: [expect.objectContaining({
        type: "command",
        bash: "skill-steward hook observe --harness github-copilot --event sessionEnd"
      })]
    }
  });
  expect(await readFile(unrelatedPath, "utf8")).toBe("UNRELATED-BYTES\n");
  expect(await integrationStatus("github-copilot", options)).toMatchObject({ status: "installed" });

  await writeFile(targetPath, `${JSON.stringify({ ...config, changed: true })}\n`, "utf8");
  await expect(removeIntegration("github-copilot", options)).rejects.toMatchObject({
    code: "INTEGRATION_DRIFTED"
  });
  expect(await readFile(unrelatedPath, "utf8")).toBe("UNRELATED-BYTES\n");

  await writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await removeIntegration("github-copilot", options);
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(unrelatedPath, "utf8")).toBe("UNRELATED-BYTES\n");
});
