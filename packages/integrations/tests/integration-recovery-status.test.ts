import { describe, expect, it, vi } from "vitest";
import {
  bindIntegrationRecordV2,
  integrationRecoveryStateSchema,
  type IntegrationRecordJournal,
  type IntegrationRecordV2,
  type IntegrationRecoveryInspection,
  type IntegrationRecoveryState
} from "@skill-steward/store";
import {
  classifyIntegrationRecoveryEvidence,
  inspectIntegrationRecoveryStatus,
  integrationRecoveryPlanSchema,
  planIntegrationRecovery
} from "../src/integration-recovery.js";

const fingerprint = (value: string): string => `sha256:${value.repeat(64)}`;

const record: IntegrationRecordV2 = {
  schemaVersion: 2,
  id: "phase-six-record",
  harness: "codex",
  action: "apply",
  status: "installed",
  targetPath: "/tmp/home/.codex/hooks.json",
  beforeFingerprint: fingerprint("b"),
  afterFingerprint: fingerprint("c"),
  installedEntryFingerprint: fingerprint("d"),
  companion: {
    action: "create",
    path: "/tmp/home/.agents/skills/skill-steward-preflight",
    before: { state: "absent" },
    after: { state: "exact", fingerprint: fingerprint("a") },
    source: { fingerprint: fingerprint("a") },
    proof: { category: "new" },
    installedFingerprint: fingerprint("a"),
    consumers: ["codex"]
  },
  trigger: {
    planId: "reviewed-plan",
    harness: "codex",
    createdAt: "2026-07-06T02:00:00.000Z"
  },
  createdAt: "2026-07-06T02:00:00.000Z"
};

const binding = bindIntegrationRecordV2(record);

function recoveryState(
  state: IntegrationRecoveryState["state"],
  options: { binding?: boolean } = { binding: true }
): IntegrationRecoveryState {
  return integrationRecoveryStateSchema.parse({
    schemaVersion: 1,
    transactionId: "11111111-1111-4111-8111-111111111111",
    planId: record.trigger.planId,
    harness: record.harness,
    action: "create",
    companionPath: record.companion.path,
    configPath: record.targetPath,
    beforeFingerprint: null,
    afterFingerprint: record.companion.installedFingerprint,
    createdAt: record.createdAt,
    ...(options.binding ? { lifecycleRecordBinding: binding } : {}),
    artifactHints: [],
    sequence: state === "prepared" ? 0 : 1,
    state,
    transitionedAt: record.createdAt,
    artifactProofs: []
  });
}

function journal(
  orderedRecords: IntegrationRecordV2[],
  changedDuringRead = false
): IntegrationRecordJournal {
  return { changedDuringRead, orderedRecords, records: orderedRecords };
}

describe("integration recovery evidence classification", () => {
  it("keeps clear recovery non-actionable", () => {
    expect(classifyIntegrationRecoveryEvidence({ status: "clear" }, journal([]))).toEqual({
      state: "clear",
      reasonCode: "INTEGRATION_RECOVERY_CLEAR",
      recoverable: false
    });
  });

  it("selects rollback for a prepared transaction and stable nonpublication", () => {
    const prepared: IntegrationRecoveryInspection = {
      status: "unresolved",
      transaction: recoveryState("prepared", { binding: false })
    };
    expect(classifyIntegrationRecoveryEvidence(prepared, journal([]))).toMatchObject({
      state: "rollback-required",
      direction: "rollback",
      recoverable: true,
      transaction: { harness: "codex", action: "create", phase: "prepared" }
    });

    const interrupted: IntegrationRecoveryInspection = {
      status: "unresolved",
      transaction: recoveryState("recovery-required")
    };
    expect(classifyIntegrationRecoveryEvidence(interrupted, journal([]))).toMatchObject({
      state: "rollback-required",
      direction: "rollback",
      recoverable: true
    });
  });

  it.each(["mutating", "recovery-required", "committed", "cleanup-pending"] as const)(
    "selects the full finalize path for exact current evidence in %s",
    (phase) => {
      const inspection: IntegrationRecoveryInspection = {
        status: "unresolved",
        transaction: recoveryState(phase)
      };
      expect(classifyIntegrationRecoveryEvidence(inspection, journal([record]))).toMatchObject({
        state: "finalize-required",
        direction: "finalize",
        recoverable: true,
        transaction: { phase }
      });
    }
  );

  it("never narrows cleanup-pending to a cleanup-only direction", () => {
    const result = classifyIntegrationRecoveryEvidence({
      status: "unresolved",
      transaction: recoveryState("cleanup-pending")
    }, journal([record]));
    expect(result).not.toHaveProperty("direction", "cleanup");
    expect(result).toHaveProperty("direction", "finalize");
  });

  it("returns unknown for unavailable, unstable, contradictory, or postcommit missing records", () => {
    expect(classifyIntegrationRecoveryEvidence({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    }, journal([]))).toMatchObject({ state: "unknown", recoverable: false });

    const interrupted: IntegrationRecoveryInspection = {
      status: "unresolved",
      transaction: recoveryState("recovery-required")
    };
    expect(classifyIntegrationRecoveryEvidence(interrupted, journal([], true)))
      .toMatchObject({ state: "unknown", recoverable: false });
    expect(classifyIntegrationRecoveryEvidence(interrupted, journal([{
      ...record,
      id: "later-record",
      trigger: { ...record.trigger, planId: "later-plan" }
    }, record]))).toMatchObject({ state: "unknown", recoverable: false });

    const committed: IntegrationRecoveryInspection = {
      status: "unresolved",
      transaction: recoveryState("committed")
    };
    expect(classifyIntegrationRecoveryEvidence(committed, journal([])))
      .toMatchObject({ state: "unknown", recoverable: false });
  });

  it("returns unknown when a non-head record already claims the interrupted plan", () => {
    const later: IntegrationRecordV2 = {
      ...record,
      id: "later-record",
      trigger: {
        ...record.trigger,
        planId: "later-plan",
        createdAt: "2026-07-06T02:01:00.000Z"
      },
      createdAt: "2026-07-06T02:01:00.000Z"
    };
    const inspection: IntegrationRecoveryInspection = {
      status: "unresolved",
      transaction: recoveryState("recovery-required")
    };
    expect(classifyIntegrationRecoveryEvidence(inspection, journal([later, record])))
      .toMatchObject({ state: "unknown", recoverable: false });
  });

  it("reads the journal only for an unresolved transaction and sanitizes read failure", async () => {
    let journalReads = 0;
    await expect(inspectIntegrationRecoveryStatus("/tmp/state", {
      readInspection: async () => ({ status: "clear" }),
      readJournal: async () => {
        journalReads += 1;
        return journal([]);
      }
    })).resolves.toMatchObject({ state: "clear" });
    expect(journalReads).toBe(0);

    await expect(inspectIntegrationRecoveryStatus("/tmp/state", {
      readInspection: async () => ({
        status: "unresolved",
        transaction: recoveryState("recovery-required")
      }),
      readJournal: async () => {
        journalReads += 1;
        throw new Error("private journal path");
      }
    })).resolves.toEqual({
      state: "unknown",
      reasonCode: "INTEGRATION_RECOVERY_UNAVAILABLE",
      recoverable: false,
      transaction: {
        transactionId: "11111111-1111-4111-8111-111111111111",
        harness: "codex",
        action: "create",
        phase: "recovery-required",
        sequence: 1
      }
    });
    expect(journalReads).toBe(1);
  });

  it("persists one strict exact finalize plan without exposing private paths or fingerprints", async () => {
    const transaction = recoveryState("recovery-required");
    const writePlan = vi.fn(async () => undefined);
    const plan = await planIntegrationRecovery({
      stateDirectory: "/tmp/private-state",
      now: () => new Date("2026-07-06T03:00:00.000Z"),
      id: () => "phase-six-recovery-plan",
      platform: "darwin"
    }, {
      readInspection: async () => ({ status: "unresolved", transaction }),
      readJournal: async () => journal([record]),
      writePlan
    });

    expect(plan).toEqual({
      schemaVersion: 1,
      planId: "phase-six-recovery-plan",
      action: "finalize",
      recoveryState: "finalize-required",
      availability: { state: "available", available: true, reason: null },
      transaction: {
        transactionId: transaction.transactionId,
        harness: "codex",
        action: "create",
        phase: "recovery-required",
        sequence: 1
      },
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      artifacts: {
        configuration: false,
        readiness: false,
        companionRoles: []
      },
      createdAt: "2026-07-06T03:00:00.000Z",
      expiresAt: "2026-07-06T03:10:00.000Z"
    });
    expect(writePlan).toHaveBeenCalledWith("/tmp/private-state", {
      schemaVersion: 1,
      id: plan.planId,
      kind: "integration-recovery",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      payload: plan
    });
    expect(JSON.stringify(plan)).not.toMatch(/private-state|\.agents|fingerprint/i);
  });

  it("keeps a Windows recovery plan reviewable but unavailable to apply", async () => {
    const transaction = recoveryState("recovery-required");
    const plan = await planIntegrationRecovery({
      stateDirectory: "/tmp/state",
      now: () => new Date("2026-07-06T03:00:00.000Z"),
      id: () => "windows-recovery-plan",
      platform: "win32"
    }, {
      readInspection: async () => ({ status: "unresolved", transaction }),
      readJournal: async () => journal([]),
      writePlan: async () => undefined
    });
    expect(plan).toMatchObject({
      action: "rollback",
      availability: {
        state: "unavailable",
        available: false,
        reason: "INTEGRATION_PLATFORM_UNSUPPORTED"
      }
    });
  });

  it("does not create a recovery plan from clear or unknown evidence", async () => {
    const writePlan = vi.fn(async () => undefined);
    await expect(planIntegrationRecovery({
      stateDirectory: "/tmp/state",
      platform: "darwin"
    }, {
      readInspection: async () => ({ status: "clear" }),
      readJournal: async () => journal([]),
      writePlan
    })).rejects.toMatchObject({ code: "INTEGRATION_RECOVERY_NOT_REQUIRED" });
    await expect(planIntegrationRecovery({
      stateDirectory: "/tmp/state",
      platform: "darwin"
    }, {
      readInspection: async () => ({
        status: "unavailable",
        reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
      }),
      readJournal: async () => journal([]),
      writePlan
    })).rejects.toMatchObject({ code: "INTEGRATION_RECOVERY_UNAVAILABLE" });
    expect(writePlan).not.toHaveBeenCalled();
  });

  it("strictly rejects recovery plan direction and status contradictions", () => {
    const transaction = recoveryState("recovery-required");
    const valid = {
      schemaVersion: 1,
      planId: "strict-recovery-plan",
      action: "rollback",
      recoveryState: "rollback-required",
      availability: { state: "available", available: true, reason: null },
      transaction: {
        transactionId: transaction.transactionId,
        harness: transaction.harness,
        action: transaction.action,
        phase: transaction.state,
        sequence: transaction.sequence
      },
      evidenceDigest: fingerprint("a"),
      artifacts: { configuration: false, readiness: false, companionRoles: [] },
      createdAt: "2026-07-06T03:00:00.000Z",
      expiresAt: "2026-07-06T03:10:00.000Z"
    };
    expect(integrationRecoveryPlanSchema.safeParse(valid).success).toBe(true);
    expect(integrationRecoveryPlanSchema.safeParse({
      ...valid,
      action: "finalize"
    }).success).toBe(false);
    expect(integrationRecoveryPlanSchema.safeParse({
      ...valid,
      extra: true
    }).success).toBe(false);
  });
});
