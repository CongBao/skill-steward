import { writeFile } from "node:fs/promises";
import {
  appendIntegrationRecoveryTransition,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent,
  fingerprintIntegrationFileBytes,
  publishIntegrationFileTransaction,
  withIntegrationMutationLease
} from "../../src/index.js";

async function main(): Promise<void> {
  const [
    stateDirectory,
    boundary,
    targetPath,
    beforeState,
    markerPath,
    beforeModeText,
    crashBoundary
  ] = process.argv.slice(2);
  if (!stateDirectory || !boundary || !targetPath || !beforeState || !markerPath) {
    throw new Error("state, boundary, target, before state, and marker are required");
  }
  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  const afterBytes = Buffer.from("after\n", "utf8");
  const beforeMode = beforeModeText === undefined ? 0o600 : Number.parseInt(beforeModeText, 8);
  const sameFingerprint = fingerprintIntegrationFileBytes(Buffer.from("same\n", "utf8"));
  const planId = `crash-config-${beforeState}`;
  const companionPath = `${boundary}/.agents/skills/skill-steward-preflight`;
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    let recovery = await createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId,
      harness: "codex",
      action: "none",
      companionPath,
      configPath: targetPath,
      beforeFingerprint: sameFingerprint,
      afterFingerprint: sameFingerprint,
      createdAt: "2026-07-05T00:00:00.000Z",
      lifecycleRecordBinding: bindIntegrationRecordV2({
        schemaVersion: 2,
        id: "crash-config-record",
        harness: "codex",
        action: "apply",
        status: "installed",
        targetPath,
        beforeFingerprint: sameFingerprint,
        afterFingerprint: sameFingerprint,
        installedEntryFingerprint: sameFingerprint,
        companion: {
          action: "none",
          path: companionPath,
          before: { state: "exact", fingerprint: sameFingerprint },
          after: { state: "exact", fingerprint: sameFingerprint },
          source: { fingerprint: sameFingerprint },
          proof: { category: "recorded" },
          installedFingerprint: sameFingerprint,
          consumers: ["codex"]
        },
        trigger: {
          planId,
          harness: "codex",
          createdAt: "2026-07-05T00:00:00.000Z"
        },
        createdAt: "2026-07-05T00:00:00.000Z"
      }),
      artifactHints: []
    }, { leaseContext });
    await publishIntegrationFileTransaction({
      targetPath,
      allowedBoundaryPath: boundary,
      expectedBefore: beforeState === "file"
        ? {
            state: "file",
            bytes: Buffer.from("before\n", "utf8"),
            fingerprint: fingerprintIntegrationFileBytes(Buffer.from("before\n", "utf8")),
            mode: beforeMode
          }
        : { state: "absent" },
      after: {
        state: "file",
        bytes: afterBytes,
        fingerprint: fingerprintIntegrationFileBytes(afterBytes),
        mode: 0o600
      },
      recovery: {
        transactionId,
        beforePublish: async (artifact) => {
          recovery = await appendIntegrationRecoveryTransition(stateDirectory, {
            transactionId,
            expectedSequence: recovery.sequence,
            expectedState: recovery.state,
            state: "mutating",
            transitionedAt: "2026-07-05T00:00:01.000Z",
            configurationArtifactAddition: artifact
          }, { leaseContext });
          if (crashBoundary === "before-publish") {
            await writeFile(markerPath, "checkpointed\n", { mode: 0o600 });
            process.kill(process.pid, "SIGKILL");
          }
        }
      }
    }, { stateDirectory, leaseContext });
    await writeFile(markerPath, "published\n", { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
