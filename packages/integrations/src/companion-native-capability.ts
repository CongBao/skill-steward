import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { IntegrationPlan } from "./config.js";
import { assertOwnedTreeNativeCapability } from "./companion-owned-tree-native.js";

export async function companionPlanRequiresNativeCapability(
  plan: IntegrationPlan
): Promise<boolean> {
  if (plan.companion.action === "create" || plan.companion.action === "upgrade") {
    return true;
  }
  if (plan.companion.action === "conflict" || plan.changes.length === 0) return false;
  try {
    const parent = await lstat(dirname(plan.targetPath), { bigint: true });
    return !parent.isDirectory() || parent.isSymbolicLink();
  } catch {
    return true;
  }
}

export async function assertCompanionPlanNativeCapability(
  plan: IntegrationPlan,
  probe: () => void = assertOwnedTreeNativeCapability
): Promise<void> {
  if (await companionPlanRequiresNativeCapability(plan)) {
    probe();
  }
}
