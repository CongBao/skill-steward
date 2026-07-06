import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertCompanionPlanNativeCapability,
  companionPlanRequiresNativeCapability
} from "../src/companion-native-capability.js";
import { assertOwnedTreeNativeCapability } from "../src/companion-owned-tree-native.js";
import type { IntegrationPlan } from "../src/config.js";

const release = JSON.parse(
  await readFile(new URL("../../../release-contract.json", import.meta.url), "utf8")
) as { version: string };

function plan(input: {
  action: "create" | "upgrade" | "none";
  targetPath: string;
  changes?: unknown[];
}): IntegrationPlan {
  return {
    companion: { action: input.action },
    targetPath: input.targetPath,
    changes: input.changes ?? [{ operation: "write", path: input.targetPath }]
  } as IntegrationPlan;
}

describe("companion native capability planning", () => {
  it.each(["create", "upgrade"] as const)("requires the native helper for %s", async (action) => {
    const probe = vi.fn(() => {
      throw new Error("helper unavailable");
    });
    const candidate = plan({ action, targetPath: "/tmp/config.json" });

    await expect(companionPlanRequiresNativeCapability(candidate)).resolves.toBe(true);
    await expect(assertCompanionPlanNativeCapability(candidate, probe))
      .rejects.toThrow("helper unavailable");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("requires the helper for none only when config ancestors may need rollback", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-native-plan-none-"));
    const existingParent = join(home, "existing");
    await mkdir(existingParent);
    const probe = vi.fn();
    const existing = plan({
      action: "none",
      targetPath: join(existingParent, "config.json")
    });
    const missing = plan({
      action: "none",
      targetPath: join(home, "missing", "config.json")
    });

    await expect(companionPlanRequiresNativeCapability(existing)).resolves.toBe(false);
    await assertCompanionPlanNativeCapability(existing, probe);
    expect(probe).not.toHaveBeenCalled();
    await expect(companionPlanRequiresNativeCapability(missing)).resolves.toBe(true);
    await assertCompanionPlanNativeCapability(missing, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not require tree-native operations for an exact config no-op", async () => {
    const candidate = plan({
      action: "none",
      targetPath: "/missing/config.json",
      changes: []
    });
    await expect(companionPlanRequiresNativeCapability(candidate)).resolves.toBe(false);
  });

  it("loads the production current-platform helper", () => {
    if (process.platform === "win32") return;
    expect(() => assertOwnedTreeNativeCapability(release.version)).not.toThrow();
  });
});
