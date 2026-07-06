import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertIntegrationMutationLeaseOwned,
  type IntegrationMutationLeaseContext
} from "./integration-mutation-lease.js";
import {
  issueIntegrationFileRecoveryAuthority,
  type IntegrationFileRecoveryAuthority,
  type IntegrationFileRecoveryOperation
} from "./integration-file-recovery-authority.js";
import {
  issueIntegrationReadinessRecoveryAuthority,
  type IntegrationReadinessRecoveryAuthority,
  type IntegrationReadinessRecoveryOperation
} from "./integration-readiness-recovery-authority.js";
import {
  issueIntegrationRecoveryArtifactAuthority,
  type IntegrationRecoveryArtifactAuthority
} from "./integration-recovery-authority.js";
import {
  allowedRecoveryTransitions,
  integrationRecoveryArtifactProofSchema,
  integrationRecoveryIntentInputSchema,
  integrationRecoveryStateSchema,
  integrationRecoveryTransitionInputSchema,
  latestRecoveryState,
  MAX_RECOVERY_DIRECTORY_ENTRIES,
  MAX_RECOVERY_FRAGMENT_BYTES,
  MAX_RECOVERY_FRAGMENTS,
  mergeArtifactProofs,
  recoveryFragmentName,
  type IntegrationRecoveryArtifactProof,
  type IntegrationRecoveryIntentInput,
  type IntegrationRecoveryState,
  type IntegrationRecoveryTransitionInput
} from "./integration-recovery-domain.js";
import {
  assertPrivateRecoveryFile,
  assertRecoveryStorage,
  isMissing,
  openRecoveryNamespace,
  readRecoveryFragment,
  readRecoverySnapshot,
  RecoveryNamespaceCommitUncertainError,
  removeOwnedRecoveryTemporary,
  sameLinkedRecoveryFile,
  sameRecoveryFile,
  syncRecoveryDirectory,
  type RecoveryStorage,
  type RecoveryStoreContext
} from "./integration-recovery-namespace.js";
import {
  bindIntegrationRecordV2,
  readIntegrationRecordJournal
} from "./integration-store.js";

export {
  integrationRecoveryArtifactProofSchema,
  integrationRecoveryIntentInputSchema,
  integrationRecoveryStateSchema
};
export type {
  IntegrationRecoveryArtifactProof,
  IntegrationRecoveryIntentInput,
  IntegrationRecoveryState,
  IntegrationRecoveryTransitionInput
};

export type IntegrationRecoverySummary =
  | { status: "clear" }
  | { status: "unresolved"; reason: "INTEGRATION_RECOVERY_REQUIRED" }
  | { status: "unavailable"; reason: "INTEGRATION_RECOVERY_UNAVAILABLE" };

export type IntegrationRecoveryInspection =
  | { status: "clear" }
  | { status: "unresolved"; transaction: IntegrationRecoveryState }
  | { status: "unavailable"; reason: "INTEGRATION_RECOVERY_UNAVAILABLE" };

export interface IntegrationRecoveryAppendOptions {
  leaseContext: IntegrationMutationLeaseContext;
  beforePublish?: () => Promise<void>;
}

export interface IntegrationRecoveryArtifactAuthorityInput {
  transactionId: string;
  role: IntegrationRecoveryArtifactProof["role"];
}

export class IntegrationRecoveryPublicationUncertainError extends Error {
  readonly code = "INTEGRATION_RECOVERY_PUBLICATION_UNCERTAIN";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrationRecoveryPublicationUncertainError";
  }
}

export interface IntegrationRecoveryStore {
  createIntegrationRecoveryIntent(
    stateDirectory: string,
    input: IntegrationRecoveryIntentInput,
    options: IntegrationRecoveryAppendOptions
  ): Promise<IntegrationRecoveryState>;
  appendIntegrationRecoveryTransition(
    stateDirectory: string,
    input: IntegrationRecoveryTransitionInput,
    options: IntegrationRecoveryAppendOptions
  ): Promise<IntegrationRecoveryState>;
  loadIntegrationRecoveryArtifactAuthority(
    stateDirectory: string,
    input: IntegrationRecoveryArtifactAuthorityInput,
    options: { leaseContext: IntegrationMutationLeaseContext }
  ): Promise<IntegrationRecoveryArtifactAuthority>;
  loadIntegrationFileRecoveryAuthority(
    stateDirectory: string,
    input: { transactionId: string; operation: IntegrationFileRecoveryOperation },
    options: { leaseContext: IntegrationMutationLeaseContext }
  ): Promise<IntegrationFileRecoveryAuthority>;
  loadIntegrationReadinessRecoveryAuthority(
    stateDirectory: string,
    input: { transactionId: string; operation: IntegrationReadinessRecoveryOperation },
    options: { leaseContext: IntegrationMutationLeaseContext }
  ): Promise<IntegrationReadinessRecoveryAuthority>;
  readIntegrationRecoveryInspection(stateDirectory: string): Promise<IntegrationRecoveryInspection>;
  readIntegrationRecoveryState(stateDirectory: string): Promise<IntegrationRecoverySummary>;
}

async function hasExactCurrentLifecycleRecord(
  stateDirectory: string,
  state: IntegrationRecoveryState
): Promise<boolean> {
  if (state.lifecycleRecordBinding === undefined) return false;
  const journal = await readIntegrationRecordJournal(stateDirectory);
  if (journal.changedDuringRead) return false;
  const head = journal.orderedRecords[0];
  return head?.schemaVersion === 2
    && bindIntegrationRecordV2(head).digest === state.lifecycleRecordBinding.digest;
}

async function executeIfRecoveryHeadCurrent<T>(
  stateDirectory: string,
  expected: Pick<IntegrationRecoveryState, "transactionId" | "sequence" | "state">,
  leaseContext: IntegrationMutationLeaseContext,
  context: RecoveryStoreContext,
  operation: (assertCurrentLifecycleRecord: () => Promise<void>) => Promise<T>,
  lifecycleState?: IntegrationRecoveryState
): Promise<T> {
  return withRecoveryMutationClaim(leaseContext, async () => {
    await assertIntegrationMutationLeaseOwned(leaseContext, stateDirectory);
    const storage = await openRecoveryNamespace(stateDirectory, false, context);
    if (!storage) throw new Error("Integration recovery authority is stale because history vanished");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(snapshot.states, expected.transactionId);
    if (
      latest === undefined
      || latest.sequence !== expected.sequence
      || latest.state !== expected.state
    ) {
      throw new Error("Integration recovery authority is stale because its transaction state changed");
    }
    await assertIntegrationMutationLeaseOwned(leaseContext, stateDirectory);
    const assertCurrentLifecycleRecord = async (): Promise<void> => {
      if (
        lifecycleState === undefined
        || !await hasExactCurrentLifecycleRecord(stateDirectory, lifecycleState)
      ) {
        throw new Error("Integration recovery lifecycle record is not the exact current journal head");
      }
      await assertIntegrationMutationLeaseOwned(leaseContext, stateDirectory);
    };
    return operation(assertCurrentLifecycleRecord);
  });
}

async function loadReadinessAuthorityWithContext(
  stateDirectory: string,
  input: { transactionId: string; operation: IntegrationReadinessRecoveryOperation },
  options: { leaseContext: IntegrationMutationLeaseContext },
  context: RecoveryStoreContext
): Promise<IntegrationReadinessRecoveryAuthority> {
  if (
    typeof input.transactionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(input.transactionId)
    || !["restore", "finalize"].includes(input.operation)
  ) throw new Error("Integration readiness recovery authority request is invalid");
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  return withRecoveryMutationClaim(options.leaseContext, async () => {
    const storage = await openRecoveryNamespace(stateDirectory, false, context);
    if (!storage) throw new Error("Integration recovery transaction does not exist");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(snapshot.states, input.transactionId);
    const operationAllowed = input.operation === "restore"
      ? ["mutating", "recovery-required"].includes(latest?.state ?? "closed")
      : ["mutating", "recovery-required", "committed", "cleanup-pending"]
          .includes(latest?.state ?? "closed")
        && latest !== undefined
        && await hasExactCurrentLifecycleRecord(stateDirectory, latest);
    if (
      latest === undefined
      || !operationAllowed
      || latest.readinessArtifact === undefined
      || latest.readinessArtifact.stateDirectory !== resolve(stateDirectory)
    ) throw new Error("Integration recovery state cannot issue this readiness authority");
    const binding = latest.readinessArtifact;
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    return issueIntegrationReadinessRecoveryAuthority({
      stateDirectory,
      leaseContext: options.leaseContext,
      transactionId: input.transactionId,
      operation: input.operation,
      execute: (operation) => executeIfRecoveryHeadCurrent(
        stateDirectory,
        latest,
        options.leaseContext,
        context,
        (assertCurrentLifecycleRecord) => operation(binding, assertCurrentLifecycleRecord),
        input.operation === "finalize" ? latest : undefined
      )
    });
  });
}

async function loadFileAuthorityWithContext(
  stateDirectory: string,
  input: { transactionId: string; operation: IntegrationFileRecoveryOperation },
  options: { leaseContext: IntegrationMutationLeaseContext },
  context: RecoveryStoreContext
): Promise<IntegrationFileRecoveryAuthority> {
  if (
    typeof input.transactionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(input.transactionId)
    || !["restore", "finalize"].includes(input.operation)
  ) throw new Error("Integration file recovery authority request is invalid");
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  return withRecoveryMutationClaim(options.leaseContext, async () => {
    const storage = await openRecoveryNamespace(stateDirectory, false, context);
    if (!storage) throw new Error("Integration recovery transaction does not exist");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(snapshot.states, input.transactionId);
    const operationAllowed = input.operation === "restore"
      ? ["mutating", "recovery-required"].includes(latest?.state ?? "closed")
      : ["mutating", "recovery-required", "committed", "cleanup-pending"]
          .includes(latest?.state ?? "closed")
        && latest !== undefined
        && await hasExactCurrentLifecycleRecord(stateDirectory, latest);
    if (
      latest === undefined
      || !operationAllowed
      || latest.configurationArtifact === undefined
      || latest.configurationArtifact.stateDirectory !== resolve(stateDirectory)
    ) throw new Error("Integration recovery state cannot issue this file authority");
    const artifact = latest.configurationArtifact;
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    return issueIntegrationFileRecoveryAuthority({
      stateDirectory,
      leaseContext: options.leaseContext,
      transactionId: input.transactionId,
      operation: input.operation,
      execute: (operation) => executeIfRecoveryHeadCurrent(
        stateDirectory,
        latest,
        options.leaseContext,
        context,
        (assertCurrentLifecycleRecord) => operation(artifact, assertCurrentLifecycleRecord),
        input.operation === "finalize" ? latest : undefined
      )
    });
  });
}

type PublicationOutcome =
  | { state: "not-published"; cause: unknown }
  | {
      state: "published";
      destination: BigIntStats;
      temporary?: BigIntStats;
    }
  | { state: "uncertain"; error: IntegrationRecoveryPublicationUncertainError };

const recoveryMutationTails = new WeakMap<
  IntegrationMutationLeaseContext,
  Promise<void>
>();

async function withRecoveryMutationClaim<T>(
  leaseContext: IntegrationMutationLeaseContext,
  operation: () => Promise<T>
): Promise<T> {
  const predecessor = recoveryMutationTails.get(leaseContext) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => gate);
  recoveryMutationTails.set(leaseContext, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (recoveryMutationTails.get(leaseContext) === tail) {
      recoveryMutationTails.delete(leaseContext);
    }
  }
}

function uncertain(
  message: string,
  causes: unknown[]
): IntegrationRecoveryPublicationUncertainError {
  return new IntegrationRecoveryPublicationUncertainError(message, {
    cause: causes.length === 1
      ? causes[0]
      : new AggregateError(causes, message)
  });
}

async function probe(path: string): Promise<
  | { state: "present"; metadata: BigIntStats }
  | { state: "missing" }
  | { state: "error"; error: unknown }
> {
  try {
    return { state: "present", metadata: await lstat(path, { bigint: true }) };
  } catch (error) {
    return isMissing(error) ? { state: "missing" } : { state: "error", error };
  }
}

async function resolveFailedLink(
  storage: RecoveryStorage,
  temporary: string,
  destination: string,
  saved: BigIntStats,
  linkError: unknown
): Promise<PublicationOutcome> {
  try {
    await assertRecoveryStorage(storage);
  } catch (error) {
    return {
      state: "uncertain",
      error: uncertain("Recovery publication storage changed after link failure", [linkError, error])
    };
  }
  const [destinationProbe, temporaryProbe] = await Promise.all([
    probe(destination),
    probe(temporary)
  ]);
  try {
    await assertRecoveryStorage(storage);
  } catch (error) {
    return {
      state: "uncertain",
      error: uncertain("Recovery publication storage changed during outcome probing", [linkError, error])
    };
  }
  if (
    destinationProbe.state === "present"
    && sameLinkedRecoveryFile(saved, destinationProbe.metadata)
  ) {
    if (temporaryProbe.state === "missing") {
      return { state: "published", destination: destinationProbe.metadata };
    }
    if (
      temporaryProbe.state === "present"
      && sameLinkedRecoveryFile(saved, temporaryProbe.metadata)
      && sameLinkedRecoveryFile(temporaryProbe.metadata, destinationProbe.metadata)
    ) {
      return {
        state: "published",
        destination: destinationProbe.metadata,
        temporary: temporaryProbe.metadata
      };
    }
  }
  if (
    destinationProbe.state === "missing"
    && temporaryProbe.state === "present"
    && sameRecoveryFile(saved, temporaryProbe.metadata)
  ) {
    return { state: "not-published", cause: linkError };
  }
  const probeErrors = [destinationProbe, temporaryProbe]
    .filter((result): result is { state: "error"; error: unknown } => result.state === "error")
    .map(({ error }) => error);
  return {
    state: "uncertain",
    error: uncertain(
      "Recovery publication outcome could not be proven after link failure",
      [linkError, ...probeErrors]
    )
  };
}

async function publish(
  stateDirectory: string,
  storage: RecoveryStorage,
  state: IntegrationRecoveryState,
  options: IntegrationRecoveryAppendOptions,
  context: RecoveryStoreContext
): Promise<void> {
  await assertIntegrationMutationLeaseOwned(options?.leaseContext, stateDirectory);
  const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
  if (snapshot.entryCount > MAX_RECOVERY_DIRECTORY_ENTRIES - 2) {
    throw new Error("Integration recovery publication would exceed the directory entry bound");
  }
  if (snapshot.states.length >= MAX_RECOVERY_FRAGMENTS) {
    throw new Error("Integration recovery history is full");
  }
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECOVERY_FRAGMENT_BYTES) {
    throw new Error("Integration recovery fragment exceeds the byte bound");
  }
  const destination = join(storage.path, recoveryFragmentName(state));
  const temporary = join(storage.path, `.recovery-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  let temporaryIdentity: BigIntStats | undefined;
  let publicationProven = false;
  try {
    temporaryIdentity = await handle.stat({ bigint: true });
    assertPrivateRecoveryFile(temporaryIdentity);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    temporaryIdentity = await handle.stat({ bigint: true });
    assertPrivateRecoveryFile(temporaryIdentity);
    if (temporaryIdentity.size !== BigInt(Buffer.byteLength(serialized))) {
      throw new Error("Integration recovery temporary size changed");
    }
    await handle.close();
    await options.beforePublish?.();
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    await assertRecoveryStorage(storage);
    let outcome: PublicationOutcome;
    try {
      await link(temporary, destination);
      const [linkedTemporary, linkedDestination] = await Promise.all([
        lstat(temporary, { bigint: true }),
        lstat(destination, { bigint: true })
      ]);
      outcome = {
        state: "published",
        destination: linkedDestination,
        temporary: linkedTemporary
      };
    } catch (error) {
      outcome = await resolveFailedLink(
        storage,
        temporary,
        destination,
        temporaryIdentity,
        error
      );
    }
    if (outcome.state === "not-published") throw outcome.cause;
    if (outcome.state === "uncertain") throw outcome.error;
    publicationProven = true;
    if (outcome.temporary) {
      if (
        outcome.temporary.nlink !== 2n
        || outcome.destination.nlink !== 2n
        || !sameLinkedRecoveryFile(outcome.temporary, outcome.destination)
      ) {
        throw uncertain("Recovery linked publication ownership cannot be proven", []);
      }
      temporaryIdentity = outcome.temporary;
    } else {
      assertPrivateRecoveryFile(outcome.destination);
      temporaryIdentity = undefined;
    }
    await syncRecoveryDirectory(storage.path, storage.identity);
    if (temporaryIdentity) {
      await removeOwnedRecoveryTemporary(storage, temporary, temporaryIdentity);
      temporaryIdentity = undefined;
    }
    await syncRecoveryDirectory(storage.path, storage.identity);
    const published = await readRecoveryFragment(storage, recoveryFragmentName(state));
    if (
      !sameLinkedRecoveryFile(outcome.destination, published.metadata)
      || JSON.stringify(published.state) !== JSON.stringify(state)
    ) {
      throw uncertain("Recovery published fragment ownership cannot be proven", []);
    }
    const committed = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(committed.states, state.transactionId);
    if (!latest || latest.sequence !== state.sequence || latest.state !== state.state) {
      throw uncertain("Recovery publication could not be confirmed", []);
    }
  } catch (error) {
    const primary = publicationProven
      && !(error instanceof IntegrationRecoveryPublicationUncertainError)
      ? uncertain("Integration recovery publication could not be finalized", [error])
      : error;
    const cleanupErrors: unknown[] = [];
    try {
      await handle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (temporaryIdentity) {
      try {
        await removeOwnedRecoveryTemporary(storage, temporary, temporaryIdentity);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw uncertain(
        "Integration recovery failure and owned temporary cleanup both failed",
        [primary, ...cleanupErrors]
      );
    }
    throw primary;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function createWithContext(
  stateDirectory: string,
  input: IntegrationRecoveryIntentInput,
  options: IntegrationRecoveryAppendOptions,
  context: RecoveryStoreContext
): Promise<IntegrationRecoveryState> {
  await assertIntegrationMutationLeaseOwned(options?.leaseContext, stateDirectory);
  return withRecoveryMutationClaim(options.leaseContext, async () => {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    const base = integrationRecoveryIntentInputSchema.parse(input);
    let storage: RecoveryStorage | undefined;
    try {
      storage = await openRecoveryNamespace(
        stateDirectory,
        true,
        context,
        () => assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory)
      );
    } catch (error) {
      if (error instanceof RecoveryNamespaceCommitUncertainError) {
        throw uncertain("Integration recovery namespace initialization is uncertain", [error]);
      }
      throw error;
    }
    if (!storage) throw new Error("Integration recovery storage was not created");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    if (snapshot.states.some(({ planId }) => planId === base.planId)) {
      throw new Error("Integration recovery plan was already durably claimed");
    }
    if (latestRecoveryState(snapshot.states, base.transactionId)) {
      throw new Error("Integration recovery transaction already exists");
    }
    const state = integrationRecoveryStateSchema.parse({
      ...base,
      sequence: 0,
      state: "prepared",
      transitionedAt: base.createdAt,
      artifactProofs: []
    });
    await publish(stateDirectory, storage, state, options, context);
    return state;
  });
}

async function appendWithContext(
  stateDirectory: string,
  input: IntegrationRecoveryTransitionInput,
  options: IntegrationRecoveryAppendOptions,
  context: RecoveryStoreContext
): Promise<IntegrationRecoveryState> {
  await assertIntegrationMutationLeaseOwned(options?.leaseContext, stateDirectory);
  return withRecoveryMutationClaim(options.leaseContext, async () => {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    const transition = integrationRecoveryTransitionInputSchema.parse(input);
    if (
      transition.configurationArtifactAddition !== undefined
      && transition.configurationArtifactAddition.stateDirectory !== resolve(stateDirectory)
    ) {
      throw new Error("Configuration recovery artifact belongs to another state");
    }
    if (
      transition.readinessArtifactAddition !== undefined
      && transition.readinessArtifactAddition.stateDirectory !== resolve(stateDirectory)
    ) {
      throw new Error("Readiness recovery artifact belongs to another state");
    }
    const storage = await openRecoveryNamespace(stateDirectory, false, context);
    if (!storage) throw new Error("Integration recovery transaction does not exist");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(snapshot.states, transition.transactionId);
    if (!latest) throw new Error("Integration recovery transaction does not exist");
    if (
      latest.sequence !== transition.expectedSequence
      || latest.state !== transition.expectedState
    ) {
      throw new Error("Integration recovery append expectation is stale");
    }
    if (!allowedRecoveryTransitions[latest.state].includes(transition.state)) {
      throw new Error(
        `Integration recovery transition ${latest.state} -> ${transition.state} is invalid`
      );
    }
    if (Date.parse(transition.transitionedAt) < Date.parse(latest.transitionedAt)) {
      throw new Error("Integration recovery transition timestamp is stale");
    }
    const lifecycleRecordBinding = latest.lifecycleRecordBinding
      ?? transition.lifecycleRecordBindingAddition;
    if (
      latest.lifecycleRecordBinding !== undefined
      && transition.lifecycleRecordBindingAddition !== undefined
      && JSON.stringify(latest.lifecycleRecordBinding)
        !== JSON.stringify(transition.lifecycleRecordBindingAddition)
    ) {
      throw new Error("An existing lifecycle-record binding cannot change");
    }
    if (
      transition.lifecycleRecordBindingAddition !== undefined
      && (latest.state !== "prepared" || transition.state !== "mutating")
    ) {
      throw new Error("Lifecycle-record binding can only be added at mutation start");
    }
    if (transition.state === "mutating" && lifecycleRecordBinding === undefined) {
      throw new Error("Mutation cannot begin without an exact lifecycle-record binding");
    }
    const artifactProofs = mergeArtifactProofs(
      latest.artifactProofs,
      transition.artifactProofAdditions ?? [],
      transition.state
    );
    const configurationArtifact = latest.configurationArtifact
      ?? transition.configurationArtifactAddition;
    if (
      latest.configurationArtifact !== undefined
      && transition.configurationArtifactAddition !== undefined
      && JSON.stringify(latest.configurationArtifact)
        !== JSON.stringify(transition.configurationArtifactAddition)
    ) {
      throw new Error("An existing configuration recovery artifact cannot change");
    }
    if (
      transition.configurationArtifactAddition !== undefined
      && !["mutating", "recovery-required", "committed"].includes(transition.state)
    ) {
      throw new Error("Configuration recovery artifact can only be added during live recovery");
    }
    const readinessArtifact = latest.readinessArtifact
      ?? transition.readinessArtifactAddition;
    if (
      latest.readinessArtifact !== undefined
      && transition.readinessArtifactAddition !== undefined
      && JSON.stringify(latest.readinessArtifact)
        !== JSON.stringify(transition.readinessArtifactAddition)
    ) {
      throw new Error("An existing readiness recovery artifact cannot change");
    }
    if (
      transition.readinessArtifactAddition !== undefined
      && !["mutating", "recovery-required", "committed"].includes(transition.state)
    ) {
      throw new Error("Readiness recovery artifact can only be added during live recovery");
    }
    const additions = transition.completedStepAdditions ?? [];
    if (additions.some((step) => latest.completedSteps.includes(step))) {
      throw new Error("A completed recovery step cannot be added twice");
    }
    if (additions.length > 0 && !["committed", "cleanup-pending"].includes(transition.state)) {
      throw new Error("Completed recovery steps require committed recovery");
    }
    const completedSteps = [...latest.completedSteps, ...additions].sort();
    const next = integrationRecoveryStateSchema.parse({
      ...latest,
      sequence: latest.sequence + 1,
      state: transition.state,
      transitionedAt: transition.transitionedAt,
      ...(lifecycleRecordBinding ? { lifecycleRecordBinding } : {}),
      artifactProofs,
      ...(configurationArtifact ? { configurationArtifact } : {}),
      ...(readinessArtifact ? { readinessArtifact } : {}),
      completedSteps
    });
    await publish(stateDirectory, storage, next, options, context);
    return next;
  });
}

async function inspectWithContext(
  stateDirectory: string,
  context: RecoveryStoreContext
): Promise<IntegrationRecoveryInspection> {
  try {
    const snapshot = await readRecoverySnapshot(stateDirectory, context);
    const latest = new Map<string, IntegrationRecoveryState>();
    for (const state of snapshot.states) {
      const current = latest.get(state.transactionId);
      if (!current || state.sequence > current.sequence) latest.set(state.transactionId, state);
    }
    const unresolved = [...latest.values()].filter(({ state }) =>
      state !== "rolled-back" && state !== "closed"
    );
    if (unresolved.length === 0) return { status: "clear" };
    if (unresolved.length !== 1) {
      return { status: "unavailable", reason: "INTEGRATION_RECOVERY_UNAVAILABLE" };
    }
    return {
      status: "unresolved",
      transaction: integrationRecoveryStateSchema.parse(structuredClone(unresolved[0]))
    };
  } catch {
    return { status: "unavailable", reason: "INTEGRATION_RECOVERY_UNAVAILABLE" };
  }
}

async function readWithContext(
  stateDirectory: string,
  context: RecoveryStoreContext
): Promise<IntegrationRecoverySummary> {
  try {
    const snapshot = await readRecoverySnapshot(stateDirectory, context);
    const latest = new Map<string, IntegrationRecoveryState>();
    for (const state of snapshot.states) {
      const current = latest.get(state.transactionId);
      if (!current || state.sequence > current.sequence) latest.set(state.transactionId, state);
    }
    return [...latest.values()].some(({ state }) =>
      state !== "rolled-back" && state !== "closed"
    )
      ? { status: "unresolved", reason: "INTEGRATION_RECOVERY_REQUIRED" }
      : { status: "clear" };
  } catch {
    return { status: "unavailable", reason: "INTEGRATION_RECOVERY_UNAVAILABLE" };
  }
}

async function loadArtifactAuthorityWithContext(
  stateDirectory: string,
  input: IntegrationRecoveryArtifactAuthorityInput,
  options: { leaseContext: IntegrationMutationLeaseContext },
  context: RecoveryStoreContext
): Promise<IntegrationRecoveryArtifactAuthority> {
  if (
    typeof input.transactionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(input.transactionId)
    || ![
      "stage",
      "backup",
      "cleanup",
      "installed",
      "config-backup",
      "readiness-backup"
    ].includes(input.role)
  ) {
    throw new Error("Integration recovery artifact authority request is invalid");
  }
  await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
  return withRecoveryMutationClaim(options.leaseContext, async () => {
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    const storage = await openRecoveryNamespace(stateDirectory, false, context);
    if (!storage) throw new Error("Integration recovery transaction does not exist");
    const snapshot = await readRecoverySnapshot(stateDirectory, context, storage);
    const latest = latestRecoveryState(snapshot.states, input.transactionId);
    if (
      latest === undefined
      || latest.state === "rolled-back"
      || latest.state === "closed"
    ) {
      throw new Error("Integration recovery transaction has no live artifact authority");
    }
    const proof = latest.artifactProofs.find(({ role }) => role === input.role);
    if (
      proof === undefined
      || proof.manifest === undefined
      || proof.platformMetadata === undefined
    ) {
      throw new Error("Integration recovery artifact lacks self-contained proof");
    }
    await assertIntegrationMutationLeaseOwned(options.leaseContext, stateDirectory);
    return issueIntegrationRecoveryArtifactAuthority({
      stateDirectory,
      leaseContext: options.leaseContext,
      transactionId: input.transactionId,
      role: input.role,
      proof
    });
  });
}

const defaultContext: RecoveryStoreContext = { platform: process.platform };

export function createIntegrationRecoveryStore(
  options: { platform?: NodeJS.Platform } = {}
): IntegrationRecoveryStore {
  const context = { platform: options.platform ?? process.platform };
  return {
    createIntegrationRecoveryIntent: (stateDirectory, input, mutationOptions) =>
      createWithContext(stateDirectory, input, mutationOptions, context),
    appendIntegrationRecoveryTransition: (stateDirectory, input, mutationOptions) =>
      appendWithContext(stateDirectory, input, mutationOptions, context),
    loadIntegrationRecoveryArtifactAuthority: (stateDirectory, input, mutationOptions) =>
      loadArtifactAuthorityWithContext(stateDirectory, input, mutationOptions, context),
    loadIntegrationFileRecoveryAuthority: (stateDirectory, input, mutationOptions) =>
      loadFileAuthorityWithContext(stateDirectory, input, mutationOptions, context),
    loadIntegrationReadinessRecoveryAuthority: (stateDirectory, input, mutationOptions) =>
      loadReadinessAuthorityWithContext(stateDirectory, input, mutationOptions, context),
    readIntegrationRecoveryInspection: (stateDirectory) =>
      inspectWithContext(stateDirectory, context),
    readIntegrationRecoveryState: (stateDirectory) => readWithContext(stateDirectory, context)
  };
}

export async function createIntegrationRecoveryIntent(
  stateDirectory: string,
  input: IntegrationRecoveryIntentInput,
  options: IntegrationRecoveryAppendOptions
): Promise<IntegrationRecoveryState> {
  return createWithContext(stateDirectory, input, options, defaultContext);
}

export async function appendIntegrationRecoveryTransition(
  stateDirectory: string,
  input: IntegrationRecoveryTransitionInput,
  options: IntegrationRecoveryAppendOptions
): Promise<IntegrationRecoveryState> {
  return appendWithContext(stateDirectory, input, options, defaultContext);
}

export async function readIntegrationRecoveryState(
  stateDirectory: string
): Promise<IntegrationRecoverySummary> {
  return readWithContext(stateDirectory, defaultContext);
}

export async function readIntegrationRecoveryInspection(
  stateDirectory: string
): Promise<IntegrationRecoveryInspection> {
  return inspectWithContext(stateDirectory, defaultContext);
}

export async function loadIntegrationRecoveryArtifactAuthority(
  stateDirectory: string,
  input: IntegrationRecoveryArtifactAuthorityInput,
  options: { leaseContext: IntegrationMutationLeaseContext }
): Promise<IntegrationRecoveryArtifactAuthority> {
  return loadArtifactAuthorityWithContext(stateDirectory, input, options, defaultContext);
}

export async function loadIntegrationFileRecoveryAuthority(
  stateDirectory: string,
  input: { transactionId: string; operation: IntegrationFileRecoveryOperation },
  options: { leaseContext: IntegrationMutationLeaseContext }
): Promise<IntegrationFileRecoveryAuthority> {
  return loadFileAuthorityWithContext(stateDirectory, input, options, defaultContext);
}

export async function loadIntegrationReadinessRecoveryAuthority(
  stateDirectory: string,
  input: { transactionId: string; operation: IntegrationReadinessRecoveryOperation },
  options: { leaseContext: IntegrationMutationLeaseContext }
): Promise<IntegrationReadinessRecoveryAuthority> {
  return loadReadinessAuthorityWithContext(stateDirectory, input, options, defaultContext);
}
