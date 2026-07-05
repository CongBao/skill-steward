import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readIntegrationRecords,
  readIntegrationRecordJournal,
  readIntegrationRecoveryState,
  readLatestReport,
  restoreIntegrationFileTransaction,
  restoreIntegrationReadiness
} from "@skill-steward/store";
import { describe, expect, it, vi } from "vitest";
import {
  applyCompanionIntegrationTransaction,
  companionTransactionReceiptSchema,
  disconnectCompanionIntegrationTransaction,
  type CompanionTransactionOptions
} from "../src/companion-transaction.js";
import {
  integrationStatus,
  integrationDisconnectPlanSchema,
  planIntegration,
  planIntegrationDisconnect
} from "../src/config.js";
import { inspectCompanionTree } from "../src/companion-manifest.js";
import type { IntegrationHarness } from "../src/domain.js";

const packagedCompanion = fileURLToPath(
  new URL("../assets/skill-steward-preflight", import.meta.url)
);

type ReadinessReport = Awaited<ReturnType<CompanionTransactionOptions["generateReadiness"]>>;

function report(fingerprint = "d"): ReadinessReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-05T04:00:00.000Z",
    portfolioFingerprint: `sha256:${fingerprint.repeat(64)}`,
    skills: [],
    findings: []
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function reorderedManagedConfig(harness: "codex" | "claude-code") {
  const events = harness === "codex"
    ? ["UserPromptSubmit", "Stop"] as const
    : ["UserPromptSubmit", "Stop", "SessionEnd"] as const;
  return {
    unrelated: { retained: true },
    hooks: Object.fromEntries(events.map((event) => [event, [{
      hooks: [{
        statusMessage: event === "UserPromptSubmit"
          ? "Running Skill Steward preflight"
          : "Recording Skill Steward lifecycle evidence",
        timeout: harness === "codex" ? 0.75 : 1,
        command: `skill-steward hook ${event === "UserPromptSubmit" ? "prompt" : "lifecycle"} --harness ${harness}`,
        type: "command"
      }]
    }]]))
  };
}

async function seedV2Consumer(input: {
  home: string;
  stateDirectory: string;
  harness: IntegrationHarness;
  instant: string;
}): Promise<void> {
  const now = () => new Date(input.instant);
  const plan = await planIntegration(input.harness, {
    home: input.home,
    stateDirectory: input.stateDirectory,
    companionSourceDirectory: packagedCompanion,
    now,
    id: () => `seed-${input.harness}-${input.instant.replaceAll(/[^0-9]/g, "")}`
  });
  await applyCompanionIntegrationTransaction(plan, {
    home: input.home,
    stateDirectory: input.stateDirectory,
    companionSourceDirectory: packagedCompanion,
    now,
    generateReadiness: async () => report()
  }, {
    transactionId: randomUUID,
    recordId: randomUUID
  });
}

async function exactCompanion(home: string) {
  const path = join(home, ".agents", "skills", "skill-steward-preflight");
  return inspectCompanionTree(path, { boundary: home, platform: process.platform });
}

describe("reviewed v2 companion disconnect", () => {
  it.each([
    "codex",
    "claude-code",
    "github-copilot"
  ] as const)("removes the exact %s Hook, retains the companion, and commits v2 remove", async (harness) => {
    const home = await mkdtemp(join(tmpdir(), `steward-disconnect-${harness}-`));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness,
      instant: "2026-07-05T04:00:00.000Z"
    });
    const beforeTree = await exactCompanion(home);
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect(harness, {
      home,
      stateDirectory,
      now,
      id: () => `disconnect-${harness}`
    });

    expect(integrationDisconnectPlanSchema.parse(plan)).toMatchObject({
      lifecycleProtocolVersion: 2,
      action: "disconnect",
      id: `disconnect-${harness}`,
      harness,
      availability: { disconnectAvailable: true, reason: null },
      companion: {
        status: "retained",
        expectedConsumers: [harness],
        remainingConsumers: []
      },
      readiness: {
        trigger: {
          planId: `disconnect-${harness}`,
          harness,
          createdAt: "2026-07-05T04:01:00.000Z"
        }
      }
    });

    const treeCalls: string[] = [];
    const receipt = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      createStage: async (...args) => {
        treeCalls.push("stage");
        throw new Error(`unexpected tree stage ${String(args[0])}`);
      },
      moveTree: async (...args) => {
        treeCalls.push("move");
        throw new Error(`unexpected tree move ${String(args[1])}`);
      },
      cleanupTree: async (...args) => {
        treeCalls.push("cleanup");
        throw new Error(`unexpected tree cleanup ${String(args[0])}`);
      },
      proveTree: async () => {
        treeCalls.push("prove");
        throw new Error("unexpected tree proof");
      },
      createAncestors: async () => {
        treeCalls.push("ancestors-create");
        throw new Error("unexpected tree ancestor create");
      },
      rollbackAncestors: async () => {
        treeCalls.push("ancestors-rollback");
        throw new Error("unexpected tree ancestor rollback");
      },
      restoreUpgrade: async () => {
        treeCalls.push("upgrade-restore");
        throw new Error("unexpected tree upgrade restore");
      }
    });

    expect(companionTransactionReceiptSchema.parse(receipt)).toMatchObject({
      outcome: "ready",
      hook: "removed",
      companion: "retained",
      cleanup: "clean",
      reasonCode: "INTEGRATION_READY_FINAL_CLEANUP_PENDING",
      nextSafeAction: "review-final-cleanup"
    });
    expect(treeCalls).toEqual([]);
    const [head] = await readIntegrationRecords(stateDirectory);
    expect(head).toMatchObject({
      schemaVersion: 2,
      harness,
      action: "remove",
      status: "removed",
      beforeFingerprint: plan.configuration.before.fingerprint,
      afterFingerprint: plan.configuration.after.fingerprint,
      installedEntryFingerprint: plan.configuration.installedEntryFingerprint,
      companion: {
        action: "retain",
        path: plan.companion.path,
        before: { state: "exact", fingerprint: beforeTree.fingerprint },
        after: { state: "exact", fingerprint: beforeTree.fingerprint },
        installedFingerprint: beforeTree.fingerprint,
        consumers: []
      },
      trigger: plan.readiness.trigger,
      createdAt: plan.createdAt
    });
    expect(await exactCompanion(home)).toEqual(beforeTree);
    expect(await readLatestReport(stateDirectory)).toEqual(report());
    if (harness === "github-copilot") {
      expect(JSON.parse(await readFile(plan.configuration.path, "utf8"))).toEqual({
        version: 1,
        hooks: {}
      });
    } else {
      const config = JSON.parse(await readFile(plan.configuration.path, "utf8")) as {
        hooks?: Record<string, unknown>;
      };
      expect(config.hooks ?? {}).toEqual({});
    }
  });

  it("removes only one consumer and preserves unrelated Hook configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-multi-"));
    const stateDirectory = join(home, "state");
    const codexConfig = join(home, ".codex", "hooks.json");
    await mkdir(dirname(codexConfig), { recursive: true, mode: 0o700 });
    await writeFile(codexConfig, stableJson({
      unrelated: { retained: true }
    }), { mode: 0o600 });
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "claude-code",
      instant: "2026-07-05T04:01:00.000Z"
    });
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "disconnect-codex-multi"
    });
    const receipt = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report()
    });
    expect(receipt).toMatchObject({
      outcome: "ready",
      companion: "retained",
      reasonCode: "INTEGRATION_READY",
      nextSafeAction: "none"
    });
    expect(plan.companion.expectedConsumers).toEqual(["claude-code", "codex"]);
    expect(plan.companion.remainingConsumers).toEqual(["claude-code"]);
    expect(JSON.parse(await readFile(plan.configuration.path, "utf8"))).toMatchObject({
      unrelated: { retained: true }
    });
    expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
      companion: { action: "retain", consumers: ["claude-code"] }
    });
  });

  it.each([
    { label: "last consumer", otherHarness: undefined },
    { label: "one of multiple consumers", otherHarness: "codex" as const }
  ])("reconnects Copilot from an exactly proven retained tombstone as $label", async ({
    otherHarness
  }) => {
    const home = await mkdtemp(join(tmpdir(), "steward-copilot-reconnect-"));
    const stateDirectory = join(home, "state");
    if (otherHarness) {
      await seedV2Consumer({
        home,
        stateDirectory,
        harness: otherHarness,
        instant: "2026-07-05T04:00:00.000Z"
      });
    }
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "github-copilot",
      instant: "2026-07-05T04:01:00.000Z"
    });
    const disconnect = await planIntegrationDisconnect("github-copilot", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "disconnect-copilot-for-reconnect"
    });
    await disconnectCompanionIntegrationTransaction(disconnect.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report()
    });

    const tombstone = await readFile(disconnect.configuration.path);
    await expect(integrationStatus("github-copilot", {
      home,
      stateDirectory
    })).resolves.toMatchObject({
      status: "not-installed",
      companion: { status: "current" }
    });
    expect(await readFile(disconnect.configuration.path)).toEqual(tombstone);

    const reconnect = await planIntegration("github-copilot", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:03:00.000Z"),
      id: () => "reconnect-copilot"
    });
    expect(reconnect).toMatchObject({
      expectedBeforeFingerprint: disconnect.configuration.after.fingerprint,
      companion: { action: "none" },
      changes: [{ operation: "write", path: disconnect.configuration.path }]
    });
    await applyCompanionIntegrationTransaction(reconnect, {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:03:00.000Z"),
      generateReadiness: async () => report("e")
    }, {
      transactionId: randomUUID,
      recordId: randomUUID
    });
    await expect(integrationStatus("github-copilot", {
      home,
      stateDirectory
    })).resolves.toMatchObject({
      status: "installed",
      companion: { status: "current" }
    });
    expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
      harness: "github-copilot",
      action: "apply",
      status: "installed",
      companion: {
        action: "none",
        consumers: otherHarness ? [otherHarness, "github-copilot"] : ["github-copilot"]
      }
    });
  });

  it("requires exact current v2 remove proof before accepting a Copilot tombstone", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "steward-copilot-empty-unproved-"));
    const emptyState = join(emptyHome, "state");
    const emptyPath = join(emptyHome, ".copilot", "hooks", "skill-steward.json");
    await mkdir(dirname(emptyPath), { recursive: true, mode: 0o700 });
    await writeFile(emptyPath, stableJson({ version: 1, hooks: {} }), { mode: 0o600 });
    const arbitraryBytes = await readFile(emptyPath);
    await expect(integrationStatus("github-copilot", {
      home: emptyHome,
      stateDirectory: emptyState
    })).resolves.toMatchObject({ status: "drifted" });
    await expect(planIntegration("github-copilot", {
      home: emptyHome,
      stateDirectory: emptyState,
      companionSourceDirectory: packagedCompanion
    })).rejects.toMatchObject({ code: "INTEGRATION_DRIFTED" });
    expect(await readFile(emptyPath)).toEqual(arbitraryBytes);
    expect(await readIntegrationRecords(emptyState)).toEqual([]);

    const home = await mkdtemp(join(tmpdir(), "steward-copilot-tombstone-tamper-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "github-copilot",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const disconnect = await planIntegrationDisconnect("github-copilot", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-copilot-tamper"
    });
    await disconnectCompanionIntegrationTransaction(disconnect.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report()
    });
    await writeFile(disconnect.configuration.path, stableJson({
      version: 1,
      hooks: {},
      tampered: true
    }), { mode: 0o600 });
    const tamperedBytes = await readFile(disconnect.configuration.path);
    const recordsBefore = await readIntegrationRecords(stateDirectory);
    await expect(integrationStatus("github-copilot", {
      home,
      stateDirectory
    })).resolves.toMatchObject({ status: "drifted" });
    await expect(planIntegration("github-copilot", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion
    })).rejects.toMatchObject({ code: "INTEGRATION_DRIFTED" });
    expect(await readFile(disconnect.configuration.path)).toEqual(tamperedBytes);
    expect(await readIntegrationRecords(stateDirectory)).toEqual(recordsBefore);
  });

  it("rejects an older Copilot remove proof after reconnect advances that Harness", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-copilot-stale-remove-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "github-copilot",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const disconnect = await planIntegrationDisconnect("github-copilot", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-copilot-stale"
    });
    await disconnectCompanionIntegrationTransaction(disconnect.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report()
    });
    const reconnect = await planIntegration("github-copilot", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "reconnect-before-stale-remove"
    });
    await applyCompanionIntegrationTransaction(reconnect, {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report()
    }, { transactionId: randomUUID, recordId: randomUUID });
    await writeFile(disconnect.configuration.path, stableJson({
      version: 1,
      hooks: {}
    }), { mode: 0o600 });
    const bytesBefore = await readFile(disconnect.configuration.path);
    const recordsBefore = await readIntegrationRecords(stateDirectory);

    await expect(integrationStatus("github-copilot", {
      home,
      stateDirectory
    })).resolves.toMatchObject({ status: "drifted" });
    await expect(planIntegration("github-copilot", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion
    })).rejects.toMatchObject({ code: "INTEGRATION_DRIFTED" });
    expect(await readFile(disconnect.configuration.path)).toEqual(bytesBefore);
    expect(await readIntegrationRecords(stateDirectory)).toEqual(recordsBefore);
  });

  it("rejects a Copilot tombstone after another lifecycle record advances the global head", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-copilot-head-advance-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "github-copilot",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const disconnect = await planIntegrationDisconnect("github-copilot", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-copilot-before-head-advance"
    });
    await disconnectCompanionIntegrationTransaction(disconnect.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report()
    });
    const advancing = await planIntegration("codex", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "advance-after-copilot-remove"
    });
    await applyCompanionIntegrationTransaction(advancing, {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report()
    }, { transactionId: randomUUID, recordId: randomUUID });
    const bytesBefore = await readFile(disconnect.configuration.path);
    const recordsBefore = await readIntegrationRecords(stateDirectory);

    await expect(integrationStatus("github-copilot", {
      home,
      stateDirectory
    })).resolves.toMatchObject({ status: "drifted" });
    await expect(planIntegration("github-copilot", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion
    })).rejects.toMatchObject({ code: "INTEGRATION_DRIFTED" });
    expect(await readFile(disconnect.configuration.path)).toEqual(bytesBefore);
    expect(await readIntegrationRecords(stateDirectory)).toEqual(recordsBefore);
  });

  it.each([
    { harness: "codex" as const, encoding: "minified without newline" },
    { harness: "claude-code" as const, encoding: "alternate whitespace" }
  ])(
    "adopts reordered $harness managed JSON encoded as $encoding without publishing config",
    async ({ harness }) => {
      const home = await mkdtemp(join(tmpdir(), `steward-reordered-${harness}-`));
      const stateDirectory = join(home, "state");
      const path = harness === "codex"
        ? join(home, ".codex", "hooks.json")
        : join(home, ".claude", "settings.json");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const rawSource = harness === "codex"
        ? JSON.stringify(reorderedManagedConfig(harness))
        : ` \t${JSON.stringify(reorderedManagedConfig(harness), null, "\t")}\n\n`;
      await writeFile(path, rawSource, { mode: 0o640 });
      const exactBytes = await readFile(path);
      const identityBefore = await lstat(path, { bigint: true });
      const directoryBefore = await readdir(dirname(path));
      const plan = await planIntegration(harness, {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now: () => new Date("2026-07-05T04:00:00.000Z"),
        id: () => `adopt-reordered-${harness}`
      });
      expect(plan.changes).toEqual([]);
      expect(plan.backupPath).toBeUndefined();
      expect(plan.afterFingerprint).toBe(plan.expectedBeforeFingerprint);
      let configPublications = 0;
      const receipt = await applyCompanionIntegrationTransaction(plan, {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now: () => new Date("2026-07-05T04:00:00.000Z"),
        generateReadiness: async () => report()
      }, {
        transactionId: randomUUID,
        recordId: randomUUID,
        publishConfig: async () => {
          configPublications += 1;
          throw new Error("no-op integration must not publish configuration");
        }
      });
      expect(receipt).toMatchObject({
        outcome: "ready",
        hook: "unchanged"
      });
      expect(configPublications).toBe(0);
      expect(await readFile(path)).toEqual(exactBytes);
      expect(await readdir(dirname(path))).toEqual(directoryBefore);
      const identityAfter = await lstat(path, { bigint: true });
      expect({
        dev: identityAfter.dev,
        ino: identityAfter.ino,
        mode: identityAfter.mode,
        mtimeNs: identityAfter.mtimeNs
      }).toEqual({
        dev: identityBefore.dev,
        ino: identityBefore.ino,
        mode: identityBefore.mode,
        mtimeNs: identityBefore.mtimeNs
      });
      expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
        harness,
        action: "apply",
        status: "installed",
        beforeFingerprint: plan.expectedBeforeFingerprint,
        afterFingerprint: plan.expectedBeforeFingerprint,
        installedEntryFingerprint: plan.installedEntryFingerprint
      });
      await expect(integrationStatus(harness, {
        home,
        stateDirectory
      })).resolves.toMatchObject({
        status: harness === "codex" ? "needs-trust" : "installed",
        companion: { status: "current" }
      });
      expect(await readFile(path)).toEqual(exactBytes);

      const disconnect = await planIntegrationDisconnect(harness, {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T04:01:00.000Z"),
        id: () => `disconnect-reordered-${harness}`
      });
      expect(disconnect.configuration.before.config).toEqual(reorderedManagedConfig(harness));
      await expect(disconnectCompanionIntegrationTransaction(disconnect.id, {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T04:01:00.000Z"),
        generateReadiness: async () => report()
      })).resolves.toMatchObject({ outcome: "ready", hook: "removed" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        unrelated: { retained: true },
        hooks: {}
      });
    }
  );

  it("consumes a raw-byte no-op plan when equivalent configuration bytes drift", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-reordered-raw-drift-"));
    const stateDirectory = join(home, "state");
    const path = join(home, ".codex", "hooks.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(reorderedManagedConfig("codex")), { mode: 0o640 });
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:00:00.000Z"),
      id: () => "raw-noop-before-drift"
    });
    expect(plan.changes).toEqual([]);
    const driftedBytes = Buffer.from(
      ` ${JSON.stringify(reorderedManagedConfig("codex"))}\n`,
      "utf8"
    );
    await writeFile(path, driftedBytes, { mode: 0o640 });
    let configPublications = 0;

    await expect(applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:00:00.000Z"),
      generateReadiness: async () => report()
    }, {
      transactionId: randomUUID,
      recordId: randomUUID,
      publishConfig: async () => {
        configPublications += 1;
        throw new Error("drifted no-op must not publish configuration");
      }
    })).rejects.toMatchObject({
      code: "INTEGRATION_DRIFTED",
      receipt: { outcome: "rolled-back", hook: "unchanged" }
    });
    expect(configPublications).toBe(0);
    expect(await readFile(path)).toEqual(driftedBytes);
    expect(await readIntegrationRecords(stateDirectory)).toEqual([]);
  });

  it("publishes stable exact JSON for a genuine reviewed configuration change", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-reviewed-config-change-"));
    const stateDirectory = join(home, "state");
    const path = join(home, ".codex", "hooks.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ unrelated: { retained: true } }), { mode: 0o640 });
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:00:00.000Z"),
      id: () => "genuine-reviewed-config-change"
    });
    expect(plan.changes).toEqual([
      { operation: "backup", path },
      { operation: "write", path }
    ]);
    await applyCompanionIntegrationTransaction(plan, {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T04:00:00.000Z"),
      generateReadiness: async () => report()
    }, { transactionId: randomUUID, recordId: randomUUID });
    expect(await readFile(path, "utf8")).toBe(stableJson(plan.afterConfig));
    expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
      beforeFingerprint: plan.expectedBeforeFingerprint,
      afterFingerprint: plan.afterFingerprint
    });
  });

  it("is strict, stored, consumed on tamper, and single-use", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-reviewed-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "disconnect-strict"
    });
    expect(() => integrationDisconnectPlanSchema.parse({
      ...plan,
      callerProof: { accepted: true }
    })).toThrow();
    const storedPath = join(stateDirectory, "reviewed-plans", `${plan.id}.json`);
    const envelope = JSON.parse(await readFile(storedPath, "utf8")) as {
      payload: Record<string, unknown>;
    };
    envelope.payload.availability = {
      disconnectAvailable: true,
      reason: "CALLER_OVERRIDE"
    };
    await writeFile(storedPath, stableJson(envelope), { mode: 0o600 });

    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    })).rejects.toMatchObject({ code: "INTEGRATION_PLAN_INVALID" });
    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report()
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
    expect(await readdir(dirname(storedPath))).not.toContain(`${plan.id}.json`);
  });

  it("consumes an expired plan before mutation", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-expired-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-expired"
    });
    const configBefore = await readFile(plan.configuration.path);
    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:11:00.000Z"),
      generateReadiness: async () => report()
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_EXPIRED" });
    expect(await readFile(plan.configuration.path)).toEqual(configBefore);
    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report()
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("consumes tampered bindings and evidence without mutating configuration or tree", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-tamper-matrix-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const configPath = join(home, ".codex", "hooks.json");
    const configBefore = await readFile(configPath);
    const treeBefore = await exactCompanion(home);
    const variants: Array<{
      name: string;
      mutate(payload: Record<string, any>): void;
    }> = [
      {
        name: "lifecycle-head",
        mutate: (payload) => { payload.lifecycleHead.binding.digest = `sha256:${"1".repeat(64)}`; }
      },
      {
        name: "consumer-record",
        mutate: (payload) => { payload.consumerRecord.binding.digest = `sha256:${"2".repeat(64)}`; }
      },
      {
        name: "installed-entry",
        mutate: (payload) => {
          payload.configuration.installedEntryFingerprint = `sha256:${"3".repeat(64)}`;
        }
      },
      {
        name: "companion-fingerprint",
        mutate: (payload) => {
          payload.companion.fingerprint = `sha256:${"4".repeat(64)}`;
          payload.companion.installedFingerprint = `sha256:${"4".repeat(64)}`;
        }
      },
      {
        name: "availability",
        mutate: (payload) => { payload.availability.reason = "CALLER_OVERRIDE"; }
      }
    ];

    for (const [index, variant] of variants.entries()) {
      const now = () => new Date(`2026-07-05T04:0${index + 1}:00.000Z`);
      const plan = await planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        now,
        id: () => `disconnect-tamper-${variant.name}`
      });
      const path = join(stateDirectory, "reviewed-plans", `${plan.id}.json`);
      const envelope = JSON.parse(await readFile(path, "utf8")) as {
        payload: Record<string, any>;
      };
      variant.mutate(envelope.payload);
      await writeFile(path, stableJson(envelope), { mode: 0o600 });
      const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report("e")
      }).catch((error: unknown) => error);
      expect(
        typeof failure === "object" && failure !== null
        && (
          ("code" in failure && failure.code === "INTEGRATION_PLAN_INVALID")
          || (
            "receipt" in failure
            && (failure as { receipt?: { outcome?: string } }).receipt?.outcome === "rolled-back"
          )
        )
      ).toBe(true);
      await expect(disconnectCompanionIntegrationTransaction(plan.id, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report("e")
      })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
      expect(await readFile(configPath)).toEqual(configBefore);
      expect(await exactCompanion(home)).toEqual(treeBefore);
      expect((await readIntegrationRecords(stateDirectory)).filter(
        (record) => record.action === "remove"
      )).toEqual([]);
    }
  });

  it("consumes stale configuration and companion plans without repairing external drift", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-stale-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const configPlan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-stale-config"
    });
    const exactConfig = await readFile(configPlan.configuration.path);
    const driftedConfig = Buffer.from('{"external":"config-drift"}\n');
    await writeFile(configPlan.configuration.path, driftedConfig, { mode: 0o600 });
    await expect(disconnectCompanionIntegrationTransaction(configPlan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report("e")
    })).rejects.toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(await readFile(configPlan.configuration.path)).toEqual(driftedConfig);
    await writeFile(configPlan.configuration.path, exactConfig, { mode: 0o600 });
    await expect(disconnectCompanionIntegrationTransaction(configPlan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      generateReadiness: async () => report("e")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });

    const treePlan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "disconnect-stale-tree"
    });
    const skill = join(treePlan.companion.path, "SKILL.md");
    await writeFile(skill, "external companion drift\n", { mode: 0o600 });
    const driftedTree = await exactCompanion(home);
    await expect(disconnectCompanionIntegrationTransaction(treePlan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report("e")
    })).rejects.toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(await exactCompanion(home)).toEqual(driftedTree);
  });

  it("consumes a plan when the v2 head and consumers advance", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-stale-head-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-stale-head"
    });
    const configBefore = await readFile(plan.configuration.path);
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "claude-code",
      instant: "2026-07-05T04:02:00.000Z"
    });
    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      generateReadiness: async () => report("e")
    })).rejects.toMatchObject({ receipt: { outcome: "rolled-back" } });
    expect(await readFile(plan.configuration.path)).toEqual(configBefore);
    expect((await readIntegrationRecords(stateDirectory)).filter(
      (record) => record.action === "remove"
    )).toEqual([]);
  });

  it("stops before the binding checkpoint when the current head changes after replan", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-binding-stop-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "disconnect-binding-stop"
    });
    const configBefore = await readFile(plan.configuration.path);
    const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      readJournal: async (directory) => {
        const journal = await readIntegrationRecordJournal(directory);
        const head = journal.orderedRecords[0];
        if (head?.schemaVersion !== 2) throw new Error("Expected v2 fixture head");
        return {
          ...journal,
          orderedRecords: [{ ...head, id: "injected-new-head" }, ...journal.orderedRecords.slice(1)]
        };
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: { code: "INTEGRATION_DRIFTED" },
      receipt: { outcome: "rolled-back", hook: "unchanged" }
    });
    expect(await readFile(plan.configuration.path)).toEqual(configBefore);
    expect((await readIntegrationRecords(stateDirectory)).filter(
      (record) => record.action === "remove"
    )).toEqual([]);
  });

  it("does not plan for a non-consumer or on Windows", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-unavailable-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    await expect(planIntegrationDisconnect("claude-code", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      id: () => "disconnect-not-consumer"
    })).rejects.toMatchObject({ code: "INTEGRATION_NOT_INSTALLED" });

    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T04:01:00.000Z"),
        id: () => "disconnect-windows"
      })).rejects.toMatchObject({ code: "INTEGRATION_COMPANION_ACTION_UNAVAILABLE" });
    } finally {
      platform.mockRestore();
    }
    expect(await readdir(join(stateDirectory, "reviewed-plans")).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    )).toEqual([]);
  });

  it.each([
    { boundary: "recovery-checkpoint", hook: "unchanged" },
    { boundary: "config-publish", hook: "restored" },
    { boundary: "readiness-generate", hook: "restored" },
    { boundary: "readiness-publish", hook: "restored" }
  ] as const)("compensates exact configuration after a definite $boundary boundary failure", async ({
    boundary,
    hook
  }) => {
    const home = await mkdtemp(join(tmpdir(), `steward-disconnect-${boundary}-`));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => `disconnect-${boundary}`
    });
    const before = await readFile(plan.configuration.path);
    const cause = Object.assign(new Error(`${boundary} failed`), { code: "INJECTED_FAILURE" });
    const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      afterBoundary: async (current) => {
        if (current === boundary) throw cause;
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause,
      receipt: {
        outcome: "rolled-back",
        hook,
        companion: "retained",
        reasonCode: "INJECTED_FAILURE"
      }
    });
    expect(await readFile(plan.configuration.path)).toEqual(before);
    expect(await readIntegrationRecords(stateDirectory)).toHaveLength(1);
    expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({ status: "clear" });
  });

  it("compensates readiness before configuration and preserves the original journal cause", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-journal-rollback-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "disconnect-journal-rollback"
    });
    const before = await readFile(plan.configuration.path);
    const cause = Object.assign(new Error("definite journal rejection"), { code: "EIO" });
    const compensation: string[] = [];
    const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      appendRecord: async () => { throw cause; },
      restoreReadiness: async (...args) => {
        compensation.push("readiness");
        return restoreIntegrationReadiness(...args);
      },
      restoreConfig: async (...args) => {
        compensation.push("configuration");
        return restoreIntegrationFileTransaction(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause,
      receipt: {
        outcome: "rolled-back",
        hook: "restored",
        companion: "retained",
        reasonCode: "EIO"
      }
    });
    expect(compensation).toEqual(["readiness", "configuration"]);
    expect(await readFile(plan.configuration.path)).toEqual(before);
    await expect(disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("does not roll back journal uncertainty and requires recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-journal-uncertain-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "disconnect-journal-uncertain"
    });
    const restored: string[] = [];
    const uncertain = Object.assign(new Error("journal may be committed"), {
      code: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN"
    });
    const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      appendRecord: async () => { throw uncertain; },
      restoreReadiness: async (...args) => {
        restored.push("readiness");
        return restoreIntegrationReadiness(...args);
      },
      restoreConfig: async (...args) => {
        restored.push("configuration");
        return restoreIntegrationFileTransaction(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: uncertain,
      receipt: {
        outcome: "recovery-required",
        hook: "unknown",
        companion: "unknown",
        cleanup: "pending",
        reasonCode: "INTEGRATION_JOURNAL_COMMIT_UNCERTAIN"
      }
    });
    expect(restored).toEqual([]);
    expect(await readFile(plan.configuration.path, "utf8"))
      .toBe(stableJson(plan.configuration.after.config));
    expect(await readIntegrationRecoveryState(stateDirectory)).toMatchObject({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
    await expect(planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now: () => new Date("2026-07-05T04:02:00.000Z"),
      id: () => "disconnect-blocked-recovery"
    })).rejects.toMatchObject({ code: "INTEGRATION_COMPANION_ACTION_UNAVAILABLE" });
  });

  it("does not roll back after lease loss at a mutation boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-lease-loss-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "disconnect-lease-loss"
    });
    const restored: string[] = [];
    const lost = Object.assign(new Error("lease ownership lost"), {
      code: "INTEGRATION_LEASE_LOST"
    });
    const failure = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      afterBoundary: async (boundary) => {
        if (boundary === "config-publish") throw lost;
      },
      restoreConfig: async (...args) => {
        restored.push("configuration");
        return restoreIntegrationFileTransaction(...args);
      }
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      cause: lost,
      receipt: {
        outcome: "recovery-required",
        reasonCode: "INTEGRATION_LEASE_LOST",
        cleanup: "pending"
      }
    });
    expect(restored).toEqual([]);
    expect(await readFile(plan.configuration.path, "utf8"))
      .toBe(stableJson(plan.configuration.after.config));
  });

  it.each([
    "recovery-commit",
    "readiness-finalize",
    "config-finalize",
    "recovery-close"
  ] as const)("returns committed cleanup-pending after a %s failure", async (boundary) => {
    const home = await mkdtemp(join(tmpdir(), `steward-disconnect-${boundary}-`));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const plan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => `disconnect-postcommit-${boundary}`
    });
    const receipt = await disconnectCompanionIntegrationTransaction(plan.id, {
      home,
      stateDirectory,
      now,
      generateReadiness: async () => report("e")
    }, {
      afterBoundary: async (current) => {
        if (current === boundary) {
          throw Object.assign(new Error(`${boundary} failed`), { code: "INJECTED_CLEANUP" });
        }
      }
    });

    expect(receipt).toMatchObject({
      outcome: "ready",
      hook: "removed",
      companion: "retained",
      cleanup: "pending",
      reasonCode: "INTEGRATION_READY_CLEANUP_PENDING",
      nextSafeAction: "recover-transaction"
    });
    expect((await readIntegrationRecords(stateDirectory))[0]).toMatchObject({
      action: "remove",
      status: "removed"
    });
  });

  it("serializes two disconnects so the stale waiter cannot append another remove", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-concurrent-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const [first, second] = await Promise.all([
      planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        now,
        id: () => "disconnect-concurrent-first"
      }),
      planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        now,
        id: () => "disconnect-concurrent-second"
      })
    ]);
    const results = await Promise.all([first, second].map((plan) =>
      disconnectCompanionIntegrationTransaction(plan.id, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report("e")
      }).catch((error: unknown) => error)
    ));

    expect(results.filter((result) =>
      typeof result === "object" && result !== null
      && "outcome" in result && result.outcome === "ready"
    )).toHaveLength(1);
    const staleResults = results.filter((result) =>
      typeof result === "object" && result !== null
      && "receipt" in result
      && (result as { receipt?: { outcome?: string } }).receipt?.outcome === "rolled-back"
    );
    expect(staleResults, JSON.stringify(results)).toHaveLength(1);
    const records = await readIntegrationRecords(stateDirectory);
    expect(records.filter((record) => record.action === "remove")).toHaveLength(1);
  });

  it("serializes apply-none against disconnect and requires a fresh exact loser plan", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-disconnect-apply-race-"));
    const stateDirectory = join(home, "state");
    await seedV2Consumer({
      home,
      stateDirectory,
      harness: "codex",
      instant: "2026-07-05T04:00:00.000Z"
    });
    const now = () => new Date("2026-07-05T04:01:00.000Z");
    const applyPlan = await planIntegration("claude-code", {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now,
      id: () => "race-apply-none"
    });
    expect(applyPlan.companion.action).toBe("none");
    const disconnectPlan = await planIntegrationDisconnect("codex", {
      home,
      stateDirectory,
      now,
      id: () => "race-disconnect"
    });
    const results = await Promise.all([
      applyCompanionIntegrationTransaction(applyPlan, {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now,
        generateReadiness: async () => report("e")
      }, { transactionId: randomUUID, recordId: randomUUID })
        .catch((error: unknown) => error),
      disconnectCompanionIntegrationTransaction(disconnectPlan.id, {
        home,
        stateDirectory,
        now,
        generateReadiness: async () => report("f")
      }, { transactionId: randomUUID, recordId: randomUUID })
        .catch((error: unknown) => error)
    ]);

    expect(results.filter((result) =>
      typeof result === "object" && result !== null
      && "outcome" in result && result.outcome === "ready"
    )).toHaveLength(1);
    const head = (await readIntegrationRecords(stateDirectory))[0];
    expect(head?.schemaVersion).toBe(2);
    if (head?.harness === "claude-code" && head.action === "apply") {
      const freshDisconnect = await planIntegrationDisconnect("codex", {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T04:02:00.000Z"),
        id: () => "race-fresh-disconnect"
      });
      await expect(disconnectCompanionIntegrationTransaction(freshDisconnect.id, {
        home,
        stateDirectory,
        now: () => new Date("2026-07-05T04:02:00.000Z"),
        generateReadiness: async () => report("a")
      })).resolves.toMatchObject({ outcome: "ready" });
    } else {
      const freshApply = await planIntegration("claude-code", {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now: () => new Date("2026-07-05T04:02:00.000Z"),
        id: () => "race-fresh-apply"
      });
      await expect(applyCompanionIntegrationTransaction(freshApply, {
        home,
        stateDirectory,
        companionSourceDirectory: packagedCompanion,
        now: () => new Date("2026-07-05T04:02:00.000Z"),
        generateReadiness: async () => report("a")
      })).resolves.toMatchObject({ outcome: "ready" });
    }
  });
});
