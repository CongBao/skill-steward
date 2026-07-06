import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendIntegrationRecoveryTransition as appendIntegrationRecoveryTransitionRaw,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent as createIntegrationRecoveryIntentRaw,
  createIntegrationRecoveryStore,
  fingerprintIntegrationFileBytes,
  publishIntegrationFileTransaction,
  publishIntegrationReadiness,
  readIntegrationRecoveryState,
  withIntegrationMutationLease,
  type IntegrationMutationLeaseContext,
  type IntegrationRecoveryArtifactProof,
  type IntegrationRecoveryAppendOptions,
  type IntegrationRecoveryIntentInput,
  type IntegrationRecoveryState
} from "../src/index.js";

type RecoveryTestOptions = Omit<IntegrationRecoveryAppendOptions, "leaseContext">;
type RecoveryTransitionTestInput = Parameters<typeof appendIntegrationRecoveryTransitionRaw>[1] & {
  artifactProofAdditions?: IntegrationRecoveryArtifactProof[];
};

async function createIntegrationRecoveryIntent(
  stateDirectory: string,
  input: IntegrationRecoveryIntentInput,
  options: RecoveryTestOptions = {}
): Promise<IntegrationRecoveryState> {
  return withIntegrationMutationLease(stateDirectory, (leaseContext) =>
    createIntegrationRecoveryIntentRaw(stateDirectory, input, {
      ...options,
      leaseContext
    })
  );
}

async function appendIntegrationRecoveryTransition(
  stateDirectory: string,
  input: RecoveryTransitionTestInput,
  options: RecoveryTestOptions = {}
): Promise<IntegrationRecoveryState> {
  return withIntegrationMutationLease(stateDirectory, (leaseContext) =>
    appendIntegrationRecoveryTransitionRaw(stateDirectory, input, {
      ...options,
      leaseContext
    })
  );
}

const raceGate = vi.hoisted(() => ({
  cleanupUnlinkFailure: false,
  linkFault: null as
    | "remove-temp-then-throw"
    | "replace-storage-then-throw"
    | "throw-before-link"
    | null,
  linkThenThrow: false,
  replacement: null as Uint8Array | null,
  recoveryTemporaryOpens: 0,
  target: null as string | null,
  triggered: false,
  mode: null as "same-name" | "parent" | null
}));

const durabilityGate = vi.hoisted(() => ({
  events: [] as string[],
  failAt: null as "state" | "recovery-first" | "recovery-second" | null,
  recoveryDirectory: null as string | null,
  recoverySyncs: 0,
  stateDirectory: null as string | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async mkdir(...args: Parameters<typeof original.mkdir>) {
      const result = await original.mkdir(...args);
      if (String(args[0]) === durabilityGate.recoveryDirectory) {
        durabilityGate.events.push("mkdir-recovery");
      }
      return result;
    },
    async link(...args: Parameters<typeof original.link>) {
      const destinationParent = dirname(String(args[1]));
      if (
        raceGate.linkFault === "throw-before-link"
        && destinationParent.endsWith("integration-recovery")
      ) {
        raceGate.linkFault = null;
        throw Object.assign(new Error("injected definite link nonpublication"), { code: "EIO" });
      }
      const result = await original.link(...args);
      if (destinationParent === durabilityGate.recoveryDirectory) {
        durabilityGate.events.push("link-fragment");
      }
      if (raceGate.linkFault && destinationParent.endsWith("integration-recovery")) {
        const fault = raceGate.linkFault;
        raceGate.linkFault = null;
        if (fault === "remove-temp-then-throw") {
          await original.unlink(args[0]);
        } else {
          await original.rename(destinationParent, `${destinationParent}.publication-replaced`);
          await original.mkdir(destinationParent, { mode: 0o700 });
        }
        throw new Error(`injected ${fault}`);
      }
      if (raceGate.linkThenThrow && destinationParent.endsWith("integration-recovery")) {
        raceGate.linkThenThrow = false;
        throw new Error("injected failure after recovery publication");
      }
      return result;
    },
    async open(...args: Parameters<typeof original.open>) {
      const path = String(args[0]);
      if (dirname(path).endsWith("integration-recovery") && path.endsWith(".tmp")) {
        raceGate.recoveryTemporaryOpens += 1;
      }
      if (!raceGate.triggered && raceGate.mode && path === raceGate.target) {
        raceGate.triggered = true;
        if (raceGate.mode === "same-name") {
          await original.rename(path, `${path}.original`);
          await original.unlink(`${path}.original`);
          await original.writeFile(path, raceGate.replacement!, { mode: 0o600 });
        } else {
          const parent = dirname(path);
          await original.rename(parent, `${parent}.original`);
          await original.mkdir(parent, { mode: 0o700 });
          await original.writeFile(path, raceGate.replacement!, { mode: 0o600 });
        }
      }
      const handle = await original.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async () => {
              if (path === durabilityGate.stateDirectory) {
                durabilityGate.events.push("sync-state");
                if (durabilityGate.failAt === "state") {
                  durabilityGate.failAt = null;
                  throw new Error("injected state directory sync failure");
                }
              } else if (path === durabilityGate.recoveryDirectory) {
                durabilityGate.recoverySyncs += 1;
                const label = durabilityGate.recoverySyncs === 1
                  ? "recovery-first"
                  : "recovery-second";
                durabilityGate.events.push(`sync-${label}`);
                if (durabilityGate.failAt === label) {
                  durabilityGate.failAt = null;
                  throw new Error(`injected ${label} sync failure`);
                }
              } else if (dirname(path) === durabilityGate.recoveryDirectory && path.endsWith(".tmp")) {
                durabilityGate.events.push("sync-temp");
              }
              return target.sync();
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    async unlink(...args: Parameters<typeof original.unlink>) {
      const path = String(args[0]);
      if (
        raceGate.cleanupUnlinkFailure
        && dirname(path).endsWith("integration-recovery")
        && path.endsWith(".tmp")
      ) {
        raceGate.cleanupUnlinkFailure = false;
        throw Object.assign(new Error("injected owned temp cleanup failure"), { code: "EACCES" });
      }
      const result = await original.unlink(...args);
      if (dirname(path) === durabilityGate.recoveryDirectory && path.endsWith(".tmp")) {
        durabilityGate.events.push("unlink-temp");
      }
      return result;
    }
  };
});

afterEach(() => {
  raceGate.cleanupUnlinkFailure = false;
  raceGate.linkFault = null;
  raceGate.linkThenThrow = false;
  raceGate.replacement = null;
  raceGate.recoveryTemporaryOpens = 0;
  raceGate.target = null;
  raceGate.triggered = false;
  raceGate.mode = null;
  durabilityGate.events = [];
  durabilityGate.failAt = null;
  durabilityGate.recoveryDirectory = null;
  durabilityGate.recoverySyncs = 0;
  durabilityGate.stateDirectory = null;
});

const fingerprint = (value: string): string => `sha256:${value.repeat(64)}`;

async function fixture(): Promise<{
  stateDirectory: string;
  input: IntegrationRecoveryIntentInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "steward-recovery-store-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const companionPath = join(root, "home", ".agents", "skills", "skill-steward-preflight");
  const configPath = join(root, "home", ".codex", "hooks.json");
  const input = {
    schemaVersion: 1 as const,
    transactionId: "11111111-1111-4111-8111-111111111111",
    planId: "reviewed-plan",
    harness: "codex" as const,
    action: "create" as const,
    companionPath,
    configPath,
    beforeFingerprint: null,
    afterFingerprint: fingerprint("a"),
    createdAt: "2026-07-05T00:00:00.000Z",
    artifactHints: [{
      role: "stage" as const,
      path: join(dirname(companionPath), ".skill-steward-stage-11111111")
    }]
  };
  const lifecycleRecordBinding = bindIntegrationRecordV2({
    schemaVersion: 2,
    id: "fixture-lifecycle-record",
    harness: input.harness,
    action: "apply",
    status: "installed",
    targetPath: input.configPath,
    beforeFingerprint: fingerprint("b"),
    afterFingerprint: fingerprint("c"),
    installedEntryFingerprint: fingerprint("d"),
    companion: {
      action: "create",
      path: input.companionPath,
      before: { state: "absent" },
      after: { state: "exact", fingerprint: input.afterFingerprint },
      source: { fingerprint: input.afterFingerprint },
      proof: { category: "new" },
      installedFingerprint: input.afterFingerprint,
      consumers: [input.harness]
    },
    trigger: {
      planId: input.planId,
      harness: input.harness,
      createdAt: input.createdAt
    },
    createdAt: input.createdAt
  });
  return {
    stateDirectory,
    input: { ...input, lifecycleRecordBinding }
  };
}

function withoutLifecycleBinding(
  input: IntegrationRecoveryIntentInput
): IntegrationRecoveryIntentInput {
  const { lifecycleRecordBinding: _binding, ...unbound } = input;
  return unbound;
}

async function append(
  stateDirectory: string,
  current: IntegrationRecoveryState,
  state: IntegrationRecoveryState["state"]
): Promise<IntegrationRecoveryState> {
  return appendIntegrationRecoveryTransition(stateDirectory, {
    transactionId: current.transactionId,
    expectedSequence: current.sequence,
    expectedState: current.state,
    state,
    transitionedAt: new Date(Date.parse(current.transitionedAt) + 1_000).toISOString()
  });
}

const recoveryStates = [
  "prepared",
  "mutating",
  "recovery-required",
  "rolled-back",
  "committed",
  "cleanup-pending",
  "closed"
] as const;

const allowedTransitionPairs = [
  ["prepared", "mutating"],
  ["prepared", "rolled-back"],
  ["mutating", "mutating"],
  ["mutating", "recovery-required"],
  ["mutating", "rolled-back"],
  ["mutating", "committed"],
  ["recovery-required", "rolled-back"],
  ["recovery-required", "committed"],
  ["rolled-back", "closed"],
  ["committed", "cleanup-pending"],
  ["committed", "closed"],
  ["cleanup-pending", "closed"]
] as const;

const allowedTransitionKeys = new Set(
  allowedTransitionPairs.map(([before, after]) => `${before}->${after}`)
);

const rejectedTransitionPairs = recoveryStates.flatMap((before) =>
  recoveryStates
    .filter((after) => !allowedTransitionKeys.has(`${before}->${after}`))
    .map((after) => [before, after] as const)
);

const pathToState: Readonly<Record<IntegrationRecoveryState["state"], readonly IntegrationRecoveryState["state"][]>> = {
  prepared: [],
  mutating: ["mutating"],
  "recovery-required": ["mutating", "recovery-required"],
  "rolled-back": ["mutating", "rolled-back"],
  committed: ["mutating", "committed"],
  "cleanup-pending": ["mutating", "committed", "cleanup-pending"],
  closed: ["mutating", "rolled-back", "closed"]
};

async function stateFixture(
  target: IntegrationRecoveryState["state"]
): Promise<{ stateDirectory: string; current: IntegrationRecoveryState }> {
  const { stateDirectory, input } = await fixture();
  let current = await createIntegrationRecoveryIntent(stateDirectory, input);
  for (const state of pathToState[target]) current = await append(stateDirectory, current, state);
  return { stateDirectory, current };
}

async function artifactProof(
  role: IntegrationRecoveryArtifactProof["role"],
  path: string,
  value = "f"
): Promise<IntegrationRecoveryArtifactProof> {
  const parentPath = dirname(path);
  const [parent, root] = await Promise.all([
    lstat(parentPath, { bigint: true }),
    lstat(path, { bigint: true })
  ]);
  return {
    role,
    path,
    physicalParentPath: await realpath(parentPath),
    parentIdentity: {
      device: parent.dev.toString(),
      inode: parent.ino.toString()
    },
    rootIdentity: {
      device: root.dev.toString(),
      inode: root.ino.toString()
    },
    fingerprint: fingerprint(value)
  };
}

describe("integration recovery store", () => {
  it("accepts exact retain and final removal disconnect fingerprints", async () => {
    const exact = fingerprint("d");
    const first = await fixture();
    const disconnect: IntegrationRecoveryIntentInput = {
      ...withoutLifecycleBinding(first.input),
      action: "disconnect",
      beforeFingerprint: exact,
      afterFingerprint: exact,
      artifactHints: []
    };
    await expect(createIntegrationRecoveryIntent(first.stateDirectory, disconnect))
      .resolves.toMatchObject({ action: "disconnect", state: "prepared" });

    const removed = await fixture();
    await expect(createIntegrationRecoveryIntent(removed.stateDirectory, {
      ...withoutLifecycleBinding(removed.input),
      action: "disconnect",
      beforeFingerprint: exact,
      afterFingerprint: null,
      artifactHints: []
    })).resolves.toMatchObject({
      action: "disconnect",
      beforeFingerprint: exact,
      afterFingerprint: null,
      state: "prepared"
    });

    for (const afterFingerprint of [fingerprint("e")]) {
      const current = await fixture();
      await expect(createIntegrationRecoveryIntent(current.stateDirectory, {
        ...withoutLifecycleBinding(current.input),
        action: "disconnect",
        beforeFingerprint: exact,
        afterFingerprint,
        artifactHints: []
      })).rejects.toThrow(/fingerprint|action/i);
    }
  });

  it("publishes a private prepared intent before exposing unresolved recovery truth", async () => {
    const { stateDirectory, input } = await fixture();
    let observed: string[] = [];

    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => {
        observed = await readdir(join(stateDirectory, "integration-recovery"));
      }
    });

    expect(prepared).toMatchObject({ sequence: 0, state: "prepared" });
    expect(observed.some((name) => name.endsWith(".tmp"))).toBe(true);
    expect(observed.some((name) => name.endsWith(".json"))).toBe(false);
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
    const [fragment] = (await readdir(join(stateDirectory, "integration-recovery")))
      .filter((name) => name.endsWith(".json"));
    expect(fragment).toBe("11111111-1111-4111-8111-111111111111-000000.json");
    if (process.platform !== "win32") {
      expect((await stat(join(stateDirectory, "integration-recovery", fragment!))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it("keeps a prepared plan claimed across Store restart without a lifecycle binding", async () => {
    const { stateDirectory, input } = await fixture();
    const unboundInput = withoutLifecycleBinding(input);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, unboundInput);

    expect(prepared.lifecycleRecordBinding).toBeUndefined();
    expect(await createIntegrationRecoveryStore().readIntegrationRecoveryState(stateDirectory))
      .toEqual({ status: "unresolved", reason: "INTEGRATION_RECOVERY_REQUIRED" });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createIntegrationRecoveryStore().createIntegrationRecoveryIntent(
        stateDirectory,
        { ...unboundInput, transactionId: "22222222-2222-4222-8222-222222222222" },
        { leaseContext }
      )).rejects.toThrow(/already durably claimed/i);
    });
  });

  it("refuses to enter mutating without a lifecycle-record binding", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(
      stateDirectory,
      withoutLifecycleBinding(input)
    );

    await expect(append(stateDirectory, prepared, "mutating"))
      .rejects.toThrow(/lifecycle|binding/i);
    expect(await readIntegrationRecoveryState(stateDirectory)).toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("monotonically adds a lifecycle-record binding at the first mutating checkpoint", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(
      stateDirectory,
      withoutLifecycleBinding(input)
    );
    const lifecycleRecordBinding = bindIntegrationRecordV2({
      schemaVersion: 2,
      id: "checkpoint-bound-record",
      harness: input.harness,
      action: "apply",
      status: "installed",
      targetPath: input.configPath,
      beforeFingerprint: fingerprint("b"),
      afterFingerprint: fingerprint("c"),
      installedEntryFingerprint: fingerprint("d"),
      companion: {
        action: "create",
        path: input.companionPath,
        before: { state: "absent" },
        after: { state: "exact", fingerprint: input.afterFingerprint! },
        source: { fingerprint: input.afterFingerprint! },
        proof: { category: "new" },
        installedFingerprint: input.afterFingerprint!,
        consumers: [input.harness]
      },
      trigger: {
        planId: input.planId,
        harness: input.harness,
        createdAt: input.createdAt
      },
      createdAt: input.createdAt
    });

    const mutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: prepared.sequence,
      expectedState: prepared.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      lifecycleRecordBindingAddition: lifecycleRecordBinding
    } as RecoveryTransitionTestInput & {
      lifecycleRecordBindingAddition: typeof lifecycleRecordBinding;
    });

    expect(prepared.lifecycleRecordBinding).toBeUndefined();
    expect(mutating.lifecycleRecordBinding).toEqual(lifecycleRecordBinding);
  });

  it("keeps publication immutable and leaves no fragment when beforePublish rejects", async () => {
    const { stateDirectory, input } = await fixture();
    const failure = new Error("lease lost");

    await expect(createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => { throw failure; }
    })).rejects.toBe(failure);

    await expect(readdir(join(stateDirectory, "integration-recovery"))).resolves.toEqual([]);
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
  });

  it("requires a live lease at mutation start and makes zero recovery writes otherwise", async () => {
    const { stateDirectory, input } = await fixture();
    const recoveryDirectory = join(stateDirectory, "integration-recovery");
    const guardPath = join(stateDirectory, "integration-recovery.namespace.json");

    for (const leaseContext of [undefined, Object.freeze({})]) {
      await expect(createIntegrationRecoveryIntentRaw(stateDirectory, input, {
        leaseContext: leaseContext as IntegrationMutationLeaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_LEASE_LOST" });
    }
    await expect(lstat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(guardPath)).rejects.toMatchObject({ code: "ENOENT" });

    const other = await mkdtemp(join(tmpdir(), "steward-recovery-wrong-lease-"));
    await withIntegrationMutationLease(other, async (leaseContext) => {
      await expect(createIntegrationRecoveryIntentRaw(stateDirectory, input, { leaseContext }))
        .rejects.toMatchObject({ code: "INTEGRATION_LEASE_LOST" });
    });
    await expect(lstat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate a missing state root during recovery mutation", async () => {
    const { stateDirectory, input } = await fixture();
    const moved = `${stateDirectory}.moved`;
    let failure: unknown;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await rename(stateDirectory, moved);
      failure = await createIntegrationRecoveryIntentRaw(stateDirectory, input, { leaseContext })
        .catch((error: unknown) => error);
      await expect(lstat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await rename(moved, stateDirectory);
    });

    expect(failure).toMatchObject({ code: "INTEGRATION_LEASE_LOST" });
  });

  it("revalidates the live lease immediately before authoritative publication", async () => {
    const { stateDirectory, input } = await fixture();
    const leasePath = join(stateDirectory, "integration-mutation.lease");
    const movedLease = `${leasePath}.moved`;

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const failure = await createIntegrationRecoveryIntentRaw(stateDirectory, input, {
        leaseContext,
        beforePublish: async () => {
          const source = await readFile(leasePath);
          await rename(leasePath, movedLease);
          await writeFile(leasePath, source, { mode: 0o600 });
        }
      }).catch((error: unknown) => error);
      await unlink(leasePath);
      await rename(movedLease, leasePath);
      expect(failure).toMatchObject({ code: "INTEGRATION_LEASE_LOST" });
    });

    const recoveryEntries = await readdir(join(stateDirectory, "integration-recovery"));
    expect(recoveryEntries.some((name) => name.endsWith(".json"))).toBe(false);
  });

  it("persists the commit and cleanup workflow through closed", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await append(stateDirectory, prepared, "mutating");
    const committed = await append(stateDirectory, mutating, "committed");
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toMatchObject({
      status: "unresolved"
    });
    const cleanupPending = await append(stateDirectory, committed, "cleanup-pending");
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toMatchObject({
      status: "unresolved"
    });
    const closed = await append(stateDirectory, cleanupPending, "closed");

    expect(closed).toMatchObject({ sequence: 4, state: "closed" });
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
  });

  it("persists the recovery-required rollback workflow through closed", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await append(stateDirectory, prepared, "mutating");
    const recoveryRequired = await append(stateDirectory, mutating, "recovery-required");
    const rolledBack = await append(stateDirectory, recoveryRequired, "rolled-back");

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
    const closed = await append(stateDirectory, rolledBack, "closed");
    expect(closed).toMatchObject({ sequence: 4, state: "closed" });
  });

  it("durably rejects a claimed plan after rollback and close while allowing a fresh plan", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await append(stateDirectory, prepared, "mutating");
    const rolledBack = await append(stateDirectory, mutating, "rolled-back");
    await append(stateDirectory, rolledBack, "closed");

    const restartedStore = createIntegrationRecoveryStore();
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(restartedStore.createIntegrationRecoveryIntent(stateDirectory, {
        ...input,
        transactionId: "22222222-2222-4222-8222-222222222222"
      }, { leaseContext })).rejects.toThrow(/plan.*claimed|consumed|already/i);

      await expect(restartedStore.createIntegrationRecoveryIntent(stateDirectory, {
        ...input,
        transactionId: "33333333-3333-4333-8333-333333333333",
        planId: "fresh-reviewed-plan"
      }, { leaseContext })).resolves.toMatchObject({
        planId: "fresh-reviewed-plan",
        state: "prepared",
        sequence: 0
      });
    });
  });

  it("atomically publishes only one recovery claim for the same plan ID", async () => {
    const { stateDirectory, input } = await fixture();

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const results = await Promise.allSettled([
        createIntegrationRecoveryIntentRaw(stateDirectory, input, { leaseContext }),
        createIntegrationRecoveryIntentRaw(stateDirectory, {
          ...input,
          transactionId: "22222222-2222-4222-8222-222222222222"
        }, { leaseContext })
      ]);

      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    });

    const fragments = (await readdir(join(stateDirectory, "integration-recovery")))
      .filter((name) => name.endsWith(".json"));
    expect(fragments).toHaveLength(1);
  });

  it.each(allowedTransitionPairs)("accepts the allowed transition %s -> %s", async (before, after) => {
    const { stateDirectory, current } = await stateFixture(before);
    await expect(append(stateDirectory, current, after)).resolves.toMatchObject({ state: after });
  });

  it.each(rejectedTransitionPairs)("rejects the transition %s -> %s", async (before, after) => {
    const { stateDirectory, current } = await stateFixture(before);
    await expect(append(stateDirectory, current, after)).rejects.toThrow(/transition/i);
  });

  it.each([
    "prepared",
    "mutating",
    "recovery-required",
    "committed",
    "cleanup-pending"
  ] as const)("reports %s as unresolved", async (target) => {
    const { stateDirectory } = await stateFixture(target);

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("selects each transaction head independently in interleaved history", async () => {
    const { stateDirectory, input } = await fixture();
    const first = await createIntegrationRecoveryIntent(stateDirectory, input);
    const second = await createIntegrationRecoveryIntent(stateDirectory, {
      ...input,
      transactionId: "22222222-2222-4222-8222-222222222222",
      planId: "second-reviewed-plan"
    });
    const firstMutating = await append(stateDirectory, first, "mutating");
    const secondMutating = await append(stateDirectory, second, "mutating");
    const firstCommitted = await append(stateDirectory, firstMutating, "committed");
    await append(stateDirectory, secondMutating, "rolled-back");

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toMatchObject({
      status: "unresolved"
    });
    const firstCleanup = await append(stateDirectory, firstCommitted, "cleanup-pending");
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toMatchObject({
      status: "unresolved"
    });
    await append(stateDirectory, firstCleanup, "closed");
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
  });

  it("monotonically adds exact artifact proofs and retains them in later states", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const artifactPath = join(dirname(input.companionPath), "stage-proof");
    await writeFile(artifactPath, "stage\n", { mode: 0o600 });
    const proof = await artifactProof("stage", artifactPath);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: prepared.sequence,
      expectedState: prepared.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [proof]
    });
    const committed = await append(stateDirectory, mutating, "committed");

    expect(mutating.artifactProofs).toEqual([proof]);
    expect(committed.artifactProofs).toEqual([proof]);
  });

  it("persists one strict lifecycle-record binding from prepared through later states", async () => {
    const { stateDirectory, input } = await fixture();
    const lifecycleRecord = {
      schemaVersion: 2 as const,
      id: "bound-record",
      harness: input.harness,
      action: "apply" as const,
      status: "installed" as const,
      targetPath: input.configPath,
      beforeFingerprint: fingerprint("b"),
      afterFingerprint: fingerprint("c"),
      installedEntryFingerprint: fingerprint("d"),
      companion: {
        action: "create" as const,
        path: input.companionPath,
        before: { state: "absent" as const },
        after: { state: "exact" as const, fingerprint: input.afterFingerprint! },
        source: { fingerprint: input.afterFingerprint! },
        proof: { category: "new" as const },
        installedFingerprint: input.afterFingerprint!,
        consumers: [input.harness]
      },
      trigger: {
        planId: input.planId,
        harness: input.harness,
        createdAt: input.createdAt
      },
      createdAt: input.createdAt
    };
    const lifecycleRecordBinding = bindIntegrationRecordV2(lifecycleRecord);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, {
      ...input,
      lifecycleRecordBinding
    });
    const mutating = await append(stateDirectory, prepared, "mutating");

    expect(prepared.lifecycleRecordBinding).toEqual(lifecycleRecordBinding);
    expect(mutating.lifecycleRecordBinding).toEqual(lifecycleRecordBinding);
    expect(Object.isFrozen(lifecycleRecordBinding)).toBe(true);
  });

  it("monotonically binds one compact configuration recovery artifact", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.configPath), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("after\n", "utf8");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let current = await createIntegrationRecoveryIntentRaw(
        stateDirectory,
        input,
        { leaseContext }
      );
      await publishIntegrationFileTransaction({
        targetPath: input.configPath,
        allowedBoundaryPath: dirname(dirname(input.configPath)),
        expectedBefore: { state: "absent" },
        after: {
          state: "file",
          bytes,
          fingerprint: fingerprintIntegrationFileBytes(bytes),
          mode: 0o600
        },
        recovery: {
          transactionId: input.transactionId,
          beforePublish: async (artifact) => {
            for (const mismatch of [
              { ...structuredClone(artifact), stateDirectory: join(stateDirectory, "other") },
              { ...structuredClone(artifact), targetPath: join(dirname(input.configPath), "other.json") }
            ]) {
              await expect(appendIntegrationRecoveryTransitionRaw(stateDirectory, {
                transactionId: current.transactionId,
                expectedSequence: current.sequence,
                expectedState: current.state,
                state: "mutating",
                transitionedAt: "2026-07-05T00:00:01.000Z",
                configurationArtifactAddition: mismatch
              }, { leaseContext })).rejects.toThrow(/state|target|artifact/i);
            }
            current = await appendIntegrationRecoveryTransitionRaw(stateDirectory, {
              transactionId: current.transactionId,
              expectedSequence: current.sequence,
              expectedState: current.state,
              state: "mutating",
              transitionedAt: "2026-07-05T00:00:01.000Z",
              configurationArtifactAddition: artifact
            } as Parameters<typeof appendIntegrationRecoveryTransitionRaw>[1] & {
              configurationArtifactAddition: typeof artifact;
            }, { leaseContext });
          }
        }
      }, { stateDirectory, leaseContext });

      const retained = await appendIntegrationRecoveryTransitionRaw(stateDirectory, {
        transactionId: current.transactionId,
        expectedSequence: current.sequence,
        expectedState: current.state,
        state: "mutating",
        transitionedAt: "2026-07-05T00:00:02.000Z"
      }, { leaseContext });
      expect(current).toMatchObject({
        configurationArtifact: {
          recoveryTransactionId: input.transactionId,
          targetPath: input.configPath
        }
      });
      expect(retained).toMatchObject({
        configurationArtifact: {
          recoveryTransactionId: input.transactionId,
          targetPath: input.configPath
        }
      });
    });
  });

  it("monotonically binds one compact readiness recovery artifact", async () => {
    const { stateDirectory, input } = await fixture();

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let current = await createIntegrationRecoveryIntentRaw(
        stateDirectory,
        input,
        { leaseContext }
      );
      await publishIntegrationReadiness({
        schemaVersion: 1,
        generatedAt: "2026-07-05T00:00:00.000Z",
        portfolioFingerprint: fingerprint("b"),
        skills: [],
        findings: []
      }, {
        stateDirectory,
        leaseContext,
        transactionId: "readiness-record",
        trigger: {
          planId: input.planId,
          harness: input.harness,
          createdAt: input.createdAt
        },
        recovery: {
          transactionId: input.transactionId,
          beforePublish: async (artifact) => {
            for (const mismatch of [
              { ...structuredClone(artifact), stateDirectory: join(stateDirectory, "other") },
              {
                ...structuredClone(artifact),
                trigger: { ...artifact.trigger, planId: "another-plan" }
              }
            ]) {
              await expect(appendIntegrationRecoveryTransitionRaw(stateDirectory, {
                transactionId: current.transactionId,
                expectedSequence: current.sequence,
                expectedState: current.state,
                state: "mutating",
                transitionedAt: "2026-07-05T00:00:01.000Z",
                readinessArtifactAddition: mismatch
              }, { leaseContext })).rejects.toThrow(/state|trigger|artifact/i);
            }
            current = await appendIntegrationRecoveryTransitionRaw(stateDirectory, {
              transactionId: current.transactionId,
              expectedSequence: current.sequence,
              expectedState: current.state,
              state: "mutating",
              transitionedAt: "2026-07-05T00:00:01.000Z",
              readinessArtifactAddition: artifact
            } as Parameters<typeof appendIntegrationRecoveryTransitionRaw>[1] & {
              readinessArtifactAddition: typeof artifact;
            }, { leaseContext });
          }
        }
      });

      expect(current).toMatchObject({
        readinessArtifact: {
          recoveryTransactionId: input.transactionId,
          readinessTransactionId: "readiness-record"
        }
      });
    });
  });

  it("monotonically checkpoints staged, backup, and installed tree snapshots", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const stagePath = join(dirname(input.companionPath), "stage-checkpoint");
    const backupPath = join(dirname(input.companionPath), "backup-checkpoint");
    const installedPath = join(dirname(input.companionPath), "installed-checkpoint");
    await Promise.all([
      writeFile(stagePath, "stage\n", { mode: 0o600 }),
      writeFile(backupPath, "backup\n", { mode: 0o600 }),
      writeFile(installedPath, "installed\n", { mode: 0o600 })
    ]);
    const stage = await artifactProof("stage", stagePath, "a");
    const backup = await artifactProof("backup", backupPath, "b");
    const installed = await artifactProof("installed", installedPath, "c");
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const staged = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: prepared.sequence,
      expectedState: prepared.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [stage]
    });
    const backedUp = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: staged.transactionId,
      expectedSequence: staged.sequence,
      expectedState: staged.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:02.000Z",
      artifactProofAdditions: [backup]
    });
    const published = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: backedUp.transactionId,
      expectedSequence: backedUp.sequence,
      expectedState: backedUp.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:03.000Z",
      artifactProofAdditions: [installed]
    });

    expect(published.artifactProofs).toEqual([backup, installed, stage]);
  });

  it("rejects a contradictory update to an existing artifact role", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const artifactPath = join(dirname(input.companionPath), "stage-proof");
    await writeFile(artifactPath, "stage\n", { mode: 0o600 });
    const proof = await artifactProof("stage", artifactPath);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: prepared.sequence,
      expectedState: prepared.state,
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [proof]
    });

    await expect(appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: mutating.transactionId,
      expectedSequence: mutating.sequence,
      expectedState: mutating.state,
      state: "committed",
      transitionedAt: "2026-07-05T00:00:02.000Z",
      artifactProofAdditions: [{ ...proof, fingerprint: fingerprint("e") }]
    })).rejects.toThrow(/artifact|proof|role/i);
  });

  it("reports unavailable for a persisted contradictory artifact proof update", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const artifactPath = join(dirname(input.companionPath), "contradictory-stage-proof");
    await writeFile(artifactPath, "stage\n", { mode: 0o600 });
    const proof = await artifactProof("stage", artifactPath);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: 0,
      expectedState: "prepared",
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [proof]
    });
    const directory = join(stateDirectory, "integration-recovery");
    await writeFile(
      join(directory, `${mutating.transactionId}-000002.json`),
      `${JSON.stringify({
        ...mutating,
        sequence: 2,
        state: "committed",
        transitionedAt: "2026-07-05T00:00:02.000Z",
        artifactProofs: [{ ...proof, fingerprint: fingerprint("e") }]
      }, null, 2)}\n`,
      { mode: 0o600 }
    );

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it("retains separate artifact proofs for interleaved transaction histories", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const firstPath = join(dirname(input.companionPath), "first-stage-proof");
    const secondPath = join(dirname(input.companionPath), "second-stage-proof");
    await Promise.all([
      writeFile(firstPath, "first\n", { mode: 0o600 }),
      writeFile(secondPath, "second\n", { mode: 0o600 })
    ]);
    const [firstProof, secondProof] = await Promise.all([
      artifactProof("stage", firstPath, "a"),
      artifactProof("stage", secondPath, "b")
    ]);
    const first = await createIntegrationRecoveryIntent(stateDirectory, input);
    const second = await createIntegrationRecoveryIntent(stateDirectory, {
      ...input,
      transactionId: "22222222-2222-4222-8222-222222222222",
      planId: "second-proof-plan"
    });
    const firstMutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: first.transactionId,
      expectedSequence: 0,
      expectedState: "prepared",
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [firstProof]
    });
    const secondMutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: second.transactionId,
      expectedSequence: 0,
      expectedState: "prepared",
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [secondProof]
    });

    expect(firstMutating.artifactProofs).toEqual([firstProof]);
    expect(secondMutating.artifactProofs).toEqual([secondProof]);
  });

  it("keeps an artifact proof bound to the original root identity after same-name replacement", async () => {
    const { stateDirectory, input } = await fixture();
    await mkdir(dirname(input.companionPath), { recursive: true });
    const artifactPath = join(dirname(input.companionPath), "replaceable-stage-proof");
    await writeFile(artifactPath, "original\n", { mode: 0o600 });
    const proof = await artifactProof("stage", artifactPath);
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const mutating = await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId: prepared.transactionId,
      expectedSequence: 0,
      expectedState: "prepared",
      state: "mutating",
      transitionedAt: "2026-07-05T00:00:01.000Z",
      artifactProofAdditions: [proof]
    });
    await link(artifactPath, join(dirname(artifactPath), ".retained-stage-proof"));
    await unlink(artifactPath);
    await writeFile(artifactPath, "replacement\n", { mode: 0o600 });
    const replacement = await lstat(artifactPath, { bigint: true });

    expect(mutating.artifactProofs[0]?.rootIdentity).not.toEqual({
      device: replacement.dev.toString(),
      inode: replacement.ino.toString()
    });
  });

  it("durably anchors a new recovery root and both fragment namespace changes in order", async () => {
    const { stateDirectory, input } = await fixture();
    durabilityGate.stateDirectory = stateDirectory;
    durabilityGate.recoveryDirectory = join(stateDirectory, "integration-recovery");

    await createIntegrationRecoveryIntent(stateDirectory, input);

    const indexOf = (event: string): number => durabilityGate.events.indexOf(event);
    expect(indexOf("mkdir-recovery")).toBeGreaterThanOrEqual(0);
    expect(indexOf("sync-state")).toBeGreaterThan(indexOf("mkdir-recovery"));
    expect(indexOf("sync-temp")).toBeGreaterThan(indexOf("sync-state"));
    expect(indexOf("link-fragment")).toBeGreaterThan(indexOf("sync-temp"));
    expect(indexOf("sync-recovery-first")).toBeGreaterThan(indexOf("link-fragment"));
    expect(indexOf("unlink-temp")).toBeGreaterThan(indexOf("sync-recovery-first"));
    expect(indexOf("sync-recovery-second")).toBeGreaterThan(indexOf("unlink-temp"));
  });

  it.each([
    ["state", "unavailable"],
    ["recovery-first", "unresolved"],
    ["recovery-second", "unresolved"]
  ] as const)("returns typed uncertainty when %s durability sync fails", async (failAt, status) => {
    const { stateDirectory, input } = await fixture();
    durabilityGate.stateDirectory = stateDirectory;
    durabilityGate.recoveryDirectory = join(stateDirectory, "integration-recovery");
    durabilityGate.failAt = failAt;

    await expect(createIntegrationRecoveryIntent(stateDirectory, input)).rejects.toMatchObject({
      code: "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN"
    });
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toMatchObject({ status });
  });

  it("rejects stale concurrent append expectations without publishing another fragment", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    await append(stateDirectory, prepared, "mutating");

    await expect(append(stateDirectory, prepared, "rolled-back"))
      .rejects.toThrow(/stale/i);
    expect((await readdir(join(stateDirectory, "integration-recovery")))
      .filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("allows only one concurrent append to publish the same immutable next sequence", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const transition = {
      transactionId: prepared.transactionId,
      expectedSequence: prepared.sequence,
      expectedState: prepared.state,
      state: "mutating" as const,
      transitionedAt: "2026-07-05T00:00:01.000Z"
    };

    const results = await Promise.allSettled([
      appendIntegrationRecoveryTransition(stateDirectory, transition),
      appendIntegrationRecoveryTransition(stateDirectory, transition)
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await readdir(join(stateDirectory, "integration-recovery")))
      .filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("proves publication when link reports failure after committing the saved inode", async () => {
    const { stateDirectory, input } = await fixture();
    raceGate.linkThenThrow = true;

    await expect(createIntegrationRecoveryIntent(stateDirectory, input)).resolves.toMatchObject({
      state: "prepared"
    });
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("proves publication after link throws even when the temporary alias already vanished", async () => {
    const { stateDirectory, input } = await fixture();
    raceGate.linkFault = "remove-temp-then-throw";

    await expect(createIntegrationRecoveryIntent(stateDirectory, input)).resolves.toMatchObject({
      state: "prepared"
    });
    expect((await readdir(join(stateDirectory, "integration-recovery")))
      .filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("preserves definite nonpublication when link throws with source exact and destination absent", async () => {
    const { stateDirectory, input } = await fixture();
    raceGate.linkFault = "throw-before-link";

    const failure = await createIntegrationRecoveryIntent(stateDirectory, input)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "EIO",
      message: "injected definite link nonpublication"
    });
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
  });

  it("returns typed publication uncertainty when storage is replaced after link throws", async () => {
    const { stateDirectory, input } = await fixture();
    raceGate.linkFault = "replace-storage-then-throw";

    await expect(createIntegrationRecoveryIntent(stateDirectory, input)).rejects.toMatchObject({
      code: "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN"
    });
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it("preserves primary failure and cleanup failure in typed uncertainty", async () => {
    const { stateDirectory, input } = await fixture();
    const primary = Object.assign(new Error("primary before-publication failure"), {
      code: "PRIMARY_FAILURE"
    });
    raceGate.cleanupUnlinkFailure = true;

    const failure = await createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => { throw primary; }
    }).catch((error: unknown) => error) as Error & { code?: string };

    expect(failure).toMatchObject({ code: "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const errors = (failure.cause as AggregateError).errors;
    expect(errors).toContain(primary);
    expect(errors.some((error) => error instanceof Error
      && error.message === "injected owned temp cleanup failure")).toBe(true);
  });

  it("returns clear for a missing state or recovery directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-recovery-missing-"));
    await expect(readIntegrationRecoveryState(join(root, "missing")))
      .resolves.toEqual({ status: "clear" });
    await expect(readIntegrationRecoveryState(root)).resolves.toEqual({ status: "clear" });
  });

  it("returns clear for an initialized guarded namespace with no recovery history", async () => {
    const { stateDirectory, input } = await fixture();
    const primary = new Error("stop before fragment publication");

    await expect(createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => { throw primary; }
    })).rejects.toBe(primary);
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
    await expect(lstat(join(stateDirectory, "integration-recovery.namespace.json")))
      .resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it.each(["directory-only", "guard-only", "guard-missing"] as const)(
    "returns unavailable when the guarded namespace is %s",
    async (condition) => {
      const { stateDirectory, input } = await fixture();
      const recoveryDirectory = join(stateDirectory, "integration-recovery");
      const guardPath = join(stateDirectory, "integration-recovery.namespace.json");
      if (condition === "directory-only") {
        await mkdir(recoveryDirectory, { mode: 0o700 });
      } else {
        await createIntegrationRecoveryIntent(stateDirectory, input);
        if (condition === "guard-only") {
          await rename(recoveryDirectory, `${recoveryDirectory}.moved`);
        } else {
          await unlink(guardPath);
        }
      }

      await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
        status: "unavailable",
        reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
      });
    }
  );

  it.each(["same-content-replacement", "symlink", "hardlink", "malformed"] as const)(
    "returns unavailable for a %s recovery namespace guard",
    async (condition) => {
      const { stateDirectory, input } = await fixture();
      await createIntegrationRecoveryIntent(stateDirectory, input);
      const guardPath = join(stateDirectory, "integration-recovery.namespace.json");
      const source = await readFile(guardPath);
      if (condition === "same-content-replacement") {
        await unlink(guardPath);
        await writeFile(guardPath, source, { mode: 0o600 });
      } else if (condition === "symlink") {
        const moved = `${guardPath}.moved`;
        await rename(guardPath, moved);
        await symlink(moved, guardPath);
      } else if (condition === "hardlink") {
        await link(guardPath, `${guardPath}.extra-link`);
      } else {
        await writeFile(guardPath, "not-json\n", { mode: 0o600 });
      }

      await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
        status: "unavailable",
        reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
      });
    }
  );

  it("detects same-name replacement of a populated recovery directory through its guard", async () => {
    const { stateDirectory, input } = await fixture();
    await createIntegrationRecoveryIntent(stateDirectory, input);
    const recoveryDirectory = join(stateDirectory, "integration-recovery");
    await rename(recoveryDirectory, `${recoveryDirectory}.moved`);
    await mkdir(recoveryDirectory, { mode: 0o700 });

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it.each([
    "malformed",
    "invalid-utf8",
    "oversize",
    "symlink",
    "non-private"
  ] as const)(
    "fails closed when an authoritative recovery fragment contains %s evidence",
    async (kind) => {
      const { stateDirectory, input } = await fixture();
      await createIntegrationRecoveryIntent(stateDirectory, input);
      const directory = join(stateDirectory, "integration-recovery");
      const [fragment] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      const path = join(directory, fragment!);
      if (kind === "malformed") await writeFile(path, "not-json\n", { mode: 0o600 });
      if (kind === "invalid-utf8") await writeFile(path, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
      if (kind === "oversize") await writeFile(path, "x".repeat(300_000), { mode: 0o600 });
      if (kind === "symlink") {
        const source = `${path}.source`;
        await rename(path, source);
        await symlink(source, path);
      }
      if (kind === "non-private" && process.platform !== "win32") await chmod(path, 0o644);

      await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
        status: "unavailable",
        reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
      });
    }
  );

  it("ignores unrelated and owned orphan temporary names when history is clear", async () => {
    const { stateDirectory, input } = await fixture();
    const directory = join(stateDirectory, "integration-recovery");
    await expect(createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => { throw new Error("initialize only"); }
    })).rejects.toThrow("initialize only");
    await writeFile(join(directory, "README.txt"), "unrelated\n", { mode: 0o644 });
    await writeFile(
      join(directory, ".recovery-123-99999999-9999-4999-8999-999999999999.tmp"),
      "orphan\n",
      { mode: 0o600 }
    );

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({ status: "clear" });
  });

  it("ignores unrelated and owned orphan temporary names without erasing unresolved truth", async () => {
    const { stateDirectory, input } = await fixture();
    await createIntegrationRecoveryIntent(stateDirectory, input);
    const directory = join(stateDirectory, "integration-recovery");
    await writeFile(join(directory, "README.txt"), "unrelated\n", { mode: 0o644 });
    await writeFile(
      join(directory, ".recovery-123-99999999-9999-4999-8999-999999999999.tmp"),
      "orphan\n",
      { mode: 0o600 }
    );

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("rejects a recognized fragment with an additional hard link outside recovery storage", async () => {
    const { stateDirectory, input } = await fixture();
    await createIntegrationRecoveryIntent(stateDirectory, input);
    const directory = join(stateDirectory, "integration-recovery");
    const [fragment] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    await link(join(directory, fragment!), join(stateDirectory, "external-hard-link"));

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it("binds every fragment name to its body and rejects a sequence gap", async () => {
    const { stateDirectory, input } = await fixture();
    const prepared = await createIntegrationRecoveryIntent(stateDirectory, input);
    const directory = join(stateDirectory, "integration-recovery");
    const [fragment] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const body = await readFile(join(directory, fragment!), "utf8");
    await writeFile(
      join(directory, "22222222-2222-4222-8222-222222222222-000001.json"),
      body.replace(prepared.transactionId, "22222222-2222-4222-8222-222222222222"),
      { mode: 0o600 }
    );

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it.each(["same-name", "parent"] as const)(
    "fails closed when a %s replacement races a no-follow fragment read",
    async (mode) => {
      const { stateDirectory, input } = await fixture();
      await createIntegrationRecoveryIntent(stateDirectory, input);
      const directory = join(stateDirectory, "integration-recovery");
      const [fragment] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      const path = join(directory, fragment!);
      raceGate.mode = mode;
      raceGate.target = path;
      raceGate.replacement = await readFile(path);

      await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
        status: "unavailable",
        reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
      });
      expect(raceGate.triggered).toBe(true);
    }
  );

  it("fails closed at the fragment bound without discarding unresolved history", async () => {
    const { stateDirectory, input } = await fixture();
    await createIntegrationRecoveryIntent(stateDirectory, input);
    const directory = join(stateDirectory, "integration-recovery");
    const [templateName] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const template = await readFile(join(directory, templateName!), "utf8");
    for (let index = 1; index < 128; index += 1) {
      const transactionId = `44444444-4444-4444-8444-${index.toString(16).padStart(12, "0")}`;
      await writeFile(
        join(directory, `${transactionId}-000000.json`),
        template.replace(input.transactionId, transactionId),
        { mode: 0o600 }
      );
    }
    const nextInput = {
      ...input,
      transactionId: "55555555-5555-4555-8555-555555555555",
      planId: "fragment-bound-next-plan"
    };

    await expect(createIntegrationRecoveryIntent(stateDirectory, nextInput))
      .rejects.toThrow(/full|bound/i);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json")))
      .toHaveLength(128);
    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("serializes two distinct writers at the 127-fragment boundary without overflow", async () => {
    const { stateDirectory, input } = await fixture();
    await createIntegrationRecoveryIntent(stateDirectory, input);
    const directory = join(stateDirectory, "integration-recovery");
    const [templateName] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const template = await readFile(join(directory, templateName!), "utf8");
    for (let index = 1; index < 127; index += 1) {
      const transactionId = `66666666-6666-4666-8666-${index.toString(16).padStart(12, "0")}`;
      await writeFile(
        join(directory, `${transactionId}-000000.json`),
        template.replace(input.transactionId, transactionId),
        { mode: 0o600 }
      );
    }
    const first = {
      ...input,
      transactionId: "77777777-7777-4777-8777-777777777777",
      planId: "boundary-first"
    };
    const second = {
      ...input,
      transactionId: "88888888-8888-4888-8888-888888888888",
      planId: "boundary-second"
    };

    const results = await Promise.allSettled([
      createIntegrationRecoveryIntent(stateDirectory, first),
      createIntegrationRecoveryIntent(stateDirectory, second)
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json")))
      .toHaveLength(128);
  });

  it("serializes two creates sharing one lease context at the 127-fragment boundary", async () => {
    const { stateDirectory, input } = await fixture();

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await createIntegrationRecoveryIntentRaw(stateDirectory, input, { leaseContext });
      const directory = join(stateDirectory, "integration-recovery");
      const [templateName] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      const template = await readFile(join(directory, templateName!), "utf8");
      for (let index = 1; index < 127; index += 1) {
        const transactionId = `99999999-9999-4999-8999-${index.toString(16).padStart(12, "0")}`;
        await writeFile(
          join(directory, `${transactionId}-000000.json`),
          template.replace(input.transactionId, transactionId),
          { mode: 0o600 }
        );
      }

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstReachedPublish!: () => void;
      const firstAtPublish = new Promise<void>((resolve) => { firstReachedPublish = resolve; });
      let secondReachedPublish!: () => void;
      const secondAtPublish = new Promise<void>((resolve) => { secondReachedPublish = resolve; });
      let secondPreparedPublication = false;
      const first = {
        ...input,
        transactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        planId: "same-context-first"
      };
      const second = {
        ...input,
        transactionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        planId: "same-context-second"
      };
      const temporaryOpensBefore = raceGate.recoveryTemporaryOpens;

      const firstCreate = createIntegrationRecoveryIntentRaw(stateDirectory, first, {
        leaseContext,
        beforePublish: async () => {
          firstReachedPublish();
          await firstGate;
        }
      });
      await firstAtPublish;
      const secondCreate = createIntegrationRecoveryIntentRaw(stateDirectory, second, {
        leaseContext,
        beforePublish: async () => {
          secondPreparedPublication = true;
          secondReachedPublish();
        }
      });
      await Promise.race([
        secondAtPublish,
        new Promise<void>((resolve) => { setTimeout(resolve, 100); })
      ]);
      releaseFirst();

      const results = await Promise.allSettled([firstCreate, secondCreate]);

      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect(results[1]).toMatchObject({ status: "rejected" });
      if (results[1]?.status === "rejected") {
        expect(results[1].reason).toMatchObject({ message: expect.stringMatching(/full|bound/i) });
      }
      expect(secondPreparedPublication).toBe(false);
      expect(raceGate.recoveryTemporaryOpens - temporaryOpensBefore).toBe(1);
      const entries = await readdir(directory);
      expect(entries.filter((name) => name.endsWith(".json"))).toHaveLength(128);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    });

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unresolved",
      reason: "INTEGRATION_RECOVERY_REQUIRED"
    });
  });

  it("releases a same-context mutation claim after a rejected write", async () => {
    const { stateDirectory, input } = await fixture();

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const failure = new Error("injected recovery write rejection");
      await expect(createIntegrationRecoveryIntentRaw(stateDirectory, input, {
        leaseContext,
        beforePublish: async () => { throw failure; }
      })).rejects.toBe(failure);

      const retry = {
        ...input,
        transactionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        planId: "same-context-after-rejection"
      };
      await expect(createIntegrationRecoveryIntentRaw(stateDirectory, retry, { leaseContext }))
        .resolves.toMatchObject({
          transactionId: retry.transactionId,
          state: "prepared",
          sequence: 0
        });
    });

    const directory = join(stateDirectory, "integration-recovery");
    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed when directory entry bounds are exceeded", async () => {
    const { stateDirectory } = await fixture();
    const directory = join(stateDirectory, "integration-recovery");
    await mkdir(directory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 257 }, async (_, index) => {
      await writeFile(join(directory, `extra-${String(index).padStart(3, "0")}`), "x", {
        mode: 0o600
      });
    }));

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it("refuses publication without two free namespace slots and leaves no new evidence", async () => {
    const { stateDirectory, input } = await fixture();
    const directory = join(stateDirectory, "integration-recovery");
    await expect(createIntegrationRecoveryIntent(stateDirectory, input, {
      beforePublish: async () => { throw new Error("initialize only"); }
    })).rejects.toThrow("initialize only");
    await Promise.all(Array.from({ length: 255 }, async (_, index) => {
      await writeFile(join(directory, `extra-${String(index).padStart(3, "0")}`), "x", {
        mode: 0o600
      });
    }));

    await expect(createIntegrationRecoveryIntent(stateDirectory, input))
      .rejects.toThrow(/full|bound/i);
    expect(await readdir(directory)).toHaveLength(255);
    expect((await readdir(directory)).some((name) => name.endsWith(".json"))).toBe(false);
  });

  it("fails closed on Windows when physical identity cannot be honestly proven", async () => {
    const { stateDirectory, input } = await fixture();
    const store = createIntegrationRecoveryStore({ platform: "win32" });

    await expect(withIntegrationMutationLease(stateDirectory, (leaseContext) =>
      store.createIntegrationRecoveryIntent(stateDirectory, input, { leaseContext })
    )).rejects.toThrow(/unavailable on this platform/i);
    await expect(store.readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
  });

  it("does not follow a linked recovery directory", async () => {
    const { stateDirectory } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "steward-recovery-outside-"));
    await symlink(outside, join(stateDirectory, "integration-recovery"));

    await expect(readIntegrationRecoveryState(stateDirectory)).resolves.toEqual({
      status: "unavailable",
      reason: "INTEGRATION_RECOVERY_UNAVAILABLE"
    });
    expect((await lstat(join(stateDirectory, "integration-recovery"))).isSymbolicLink()).toBe(true);
  });
});
