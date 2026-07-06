import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendIntegrationRecoveryTransition,
  createIntegrationRecoveryIntent,
  readIntegrationRecoveryInspection,
  withIntegrationMutationLease
} from "@skill-steward/store";
import { describe, expect, it } from "vitest";
import {
  applyIntegrationRecoveryPlan,
  planIntegrationRecovery
} from "../src/integration-recovery.js";

const exact = `sha256:${"a".repeat(64)}`;

async function preparedFixture() {
  const root = await mkdtemp(join(tmpdir(), "steward-integration-recover-"));
  const home = join(root, "home");
  const stateDirectory = join(root, "state");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const transactionId = "11111111-1111-4111-8111-111111111111";
  await withIntegrationMutationLease(stateDirectory, (leaseContext) =>
    createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId: "interrupted-integration-plan",
      harness: "codex",
      action: "none",
      companionPath: join(home, ".agents", "skills", "skill-steward-preflight"),
      configPath: join(home, ".codex", "hooks.json"),
      beforeFingerprint: exact,
      afterFingerprint: exact,
      createdAt: "2026-07-06T04:00:00.000Z",
      artifactHints: []
    }, { leaseContext })
  );
  return { home, stateDirectory, transactionId };
}

describe("reviewed integration recovery coordinator", () => {
  it("reviews and closes a prepared non-mutating transaction exactly once", async () => {
    const fixture = await preparedFixture();
    const plan = await planIntegrationRecovery({
      stateDirectory: fixture.stateDirectory,
      id: () => "prepared-rollback-plan",
      now: () => new Date("2026-07-06T04:01:00.000Z"),
      platform: "darwin"
    });
    expect(plan).toMatchObject({
      action: "rollback",
      transaction: { phase: "prepared", sequence: 0 }
    });

    await expect(applyIntegrationRecoveryPlan(plan.planId, {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      now: () => new Date("2026-07-06T04:02:00.000Z"),
      platform: "darwin"
    })).resolves.toEqual({
      schemaVersion: 1,
      transactionId: fixture.transactionId,
      planId: plan.planId,
      action: "rollback",
      outcome: "recovered",
      finalState: "closed",
      reasonCode: "INTEGRATION_RECOVERY_ROLLED_BACK",
      nextSafeAction: "create-new-plan"
    });
    await expect(readIntegrationRecoveryInspection(fixture.stateDirectory))
      .resolves.toEqual({ status: "clear" });
    await expect(applyIntegrationRecoveryPlan(plan.planId, {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      now: () => new Date("2026-07-06T04:03:00.000Z"),
      platform: "darwin"
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("consumes a stale recovery plan before mutation", async () => {
    const fixture = await preparedFixture();
    const plan = await planIntegrationRecovery({
      stateDirectory: fixture.stateDirectory,
      id: () => "stale-recovery-plan",
      now: () => new Date("2026-07-06T04:01:00.000Z"),
      platform: "darwin"
    });
    await withIntegrationMutationLease(fixture.stateDirectory, async (leaseContext) => {
      await appendIntegrationRecoveryTransition(fixture.stateDirectory, {
        transactionId: fixture.transactionId,
        expectedSequence: 0,
        expectedState: "prepared",
        state: "rolled-back",
        transitionedAt: "2026-07-06T04:01:30.000Z"
      }, { leaseContext });
    });

    await expect(applyIntegrationRecoveryPlan(plan.planId, {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      now: () => new Date("2026-07-06T04:02:00.000Z"),
      platform: "darwin"
    })).rejects.toMatchObject({ code: "INTEGRATION_RECOVERY_PLAN_STALE" });
    await expect(readIntegrationRecoveryInspection(fixture.stateDirectory))
      .resolves.toEqual({ status: "clear" });
  });

  it("returns a sanitized retryable receipt when exact recovery cannot finish", async () => {
    const fixture = await preparedFixture();
    const plan = await planIntegrationRecovery({
      stateDirectory: fixture.stateDirectory,
      id: () => "incomplete-recovery-plan",
      now: () => new Date("2026-07-06T04:01:00.000Z"),
      platform: "darwin"
    });
    const privateFailure = new Error(`failed inside ${fixture.home}`);

    await expect(applyIntegrationRecoveryPlan(plan.planId, {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      now: () => new Date("2026-07-06T04:02:00.000Z"),
      platform: "darwin"
    }, {
      appendRecovery: async () => { throw privateFailure; }
    })).resolves.toEqual({
      schemaVersion: 1,
      transactionId: fixture.transactionId,
      planId: plan.planId,
      action: "rollback",
      outcome: "recovery-required",
      finalState: "recovery-required",
      reasonCode: "INTEGRATION_RECOVERY_INCOMPLETE",
      nextSafeAction: "review-recovery"
    });
    await expect(readIntegrationRecoveryInspection(fixture.stateDirectory))
      .resolves.toMatchObject({ status: "unresolved" });
    await expect(applyIntegrationRecoveryPlan(plan.planId, {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      platform: "darwin"
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });
});
