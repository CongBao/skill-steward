import { writeFile } from "node:fs/promises";
import {
  appendIntegrationRecoveryTransition,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent,
  publishIntegrationReadiness,
  withIntegrationMutationLease
} from "../../src/index.js";

const report = (character: string, hour = 0) => ({
  schemaVersion: 1 as const,
  generatedAt: `2026-07-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
  portfolioFingerprint: `sha256:${character.repeat(64)}`,
  skills: [],
  findings: []
});

async function main(): Promise<void> {
  const [stateDirectory, beforeState, markerPath] = process.argv.slice(2);
  if (!stateDirectory || !beforeState || !markerPath) {
    throw new Error("state, before state, and marker are required");
  }
  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  const planId = `crash-readiness-${beforeState}`;
  const companionPath = `${stateDirectory}/fixture-skill`;
  const configPath = `${stateDirectory}/fixture-hooks.json`;
  const fingerprint = `sha256:${"d".repeat(64)}`;
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    let recovery = await createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId,
      harness: "codex",
      action: "none",
      companionPath,
      configPath,
      beforeFingerprint: fingerprint,
      afterFingerprint: fingerprint,
      createdAt: "2026-07-05T00:00:00.000Z",
      lifecycleRecordBinding: bindIntegrationRecordV2({
        schemaVersion: 2,
        id: "readiness-record",
        harness: "codex",
        action: "apply",
        status: "installed",
        targetPath: configPath,
        beforeFingerprint: fingerprint,
        afterFingerprint: fingerprint,
        installedEntryFingerprint: fingerprint,
        companion: {
          action: "none",
          path: companionPath,
          before: { state: "exact", fingerprint },
          after: { state: "exact", fingerprint },
          source: { fingerprint },
          proof: { category: "recorded" },
          installedFingerprint: fingerprint,
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
    await publishIntegrationReadiness(report("b", 1), {
      stateDirectory,
      leaseContext,
      transactionId: "readiness-record",
      trigger: {
        planId,
        harness: "codex",
        createdAt: "2026-07-05T00:00:00.000Z"
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
            readinessArtifactAddition: artifact
          }, { leaseContext });
        }
      }
    });
    await writeFile(markerPath, "published\n", { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
