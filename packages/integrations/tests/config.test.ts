import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyIntegrationPlan,
  integrationStatus,
  planIntegration,
  removeIntegration
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
