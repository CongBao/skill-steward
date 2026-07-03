import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyIntegrationPlan,
  integrationPlanSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  rollbackIntegrationPlan
} from "../src/config.js";

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
  await mkdir(join(stateDirectory, "integrations.json"), { recursive: true });

  await expect(applyIntegrationPlan(plan, {
    home,
    stateDirectory,
    now: () => new Date("2026-07-03T00:00:00.000Z")
  })).rejects.toBeDefined();
  await expect(access(target(home, "codex"))).rejects.toMatchObject({ code: "ENOENT" });
});

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
