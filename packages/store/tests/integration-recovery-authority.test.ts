import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecoveryTransition,
  bindIntegrationRecordV2,
  consumeIntegrationRecoveryArtifactAuthority,
  createIntegrationRecoveryIntent,
  integrationRecoveryArtifactProofSchema,
  loadIntegrationRecoveryArtifactAuthority,
  withIntegrationMutationLease,
  type IntegrationRecoveryArtifactAuthority,
  type IntegrationRecoveryArtifactProof
} from "../src/index.js";

const transactionId = "123e4567-e89b-42d3-a456-426614174000";
const fingerprint = `sha256:${"1".repeat(64)}`;
const manifestFingerprint = "sha256:f6a545ea4b0c6039d58137f3b7734eac0a5cb2df9147ee1383f3f54bc0262612";

function artifact(root: string): IntegrationRecoveryArtifactProof {
  return {
    role: "stage",
    path: join(root, ".agents", "skills", `.skill-steward-owned.${transactionId}.cleanup`),
    physicalParentPath: join(root, ".agents", "skills"),
    parentIdentity: { device: "1", inode: "2" },
    rootIdentity: { device: "1", inode: "3" },
    fingerprint: manifestFingerprint,
    entryIdentities: [{ relativePath: ".", device: "1", inode: "3" }],
    manifest: {
      schemaVersion: 1,
      platform: "posix",
      entries: [{
        relativePath: ".",
        kind: "directory",
        bytes: 0,
        securityMode: "posix:0700"
      }],
      fingerprint: manifestFingerprint
    },
    platformMetadata: {
      platform: "posix",
      identity: "bigint-device-inode",
      securityMode: "posix-permission-bits"
    }
  };
}

async function persistArtifact(
  stateDirectory: string,
  root: string
): Promise<IntegrationRecoveryArtifactProof> {
  const proof = integrationRecoveryArtifactProofSchema.parse(artifact(root));
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    const createdAt = new Date().toISOString();
    const companionPath = join(root, ".agents", "skills", "skill-steward-preflight");
    const configPath = join(root, ".codex", "hooks.json");
    await createIntegrationRecoveryIntent(stateDirectory, {
      schemaVersion: 1,
      transactionId,
      planId: "plan",
      harness: "codex",
      action: "create",
      companionPath,
      configPath,
      beforeFingerprint: null,
      afterFingerprint: fingerprint,
      createdAt,
      lifecycleRecordBinding: bindIntegrationRecordV2({
        schemaVersion: 2,
        id: "recovery-authority-record",
        harness: "codex",
        action: "apply",
        status: "installed",
        targetPath: configPath,
        beforeFingerprint: fingerprint,
        afterFingerprint: fingerprint,
        installedEntryFingerprint: fingerprint,
        companion: {
          action: "create",
          path: companionPath,
          before: { state: "absent" },
          after: { state: "exact", fingerprint },
          source: { fingerprint },
          proof: { category: "new" },
          installedFingerprint: fingerprint,
          consumers: ["codex"]
        },
        trigger: { planId: "plan", harness: "codex", createdAt },
        createdAt
      }),
      artifactHints: [{ role: "stage", path: proof.path }]
    }, { leaseContext });
    await appendIntegrationRecoveryTransition(stateDirectory, {
      transactionId,
      expectedSequence: 0,
      expectedState: "prepared",
      state: "mutating",
      transitionedAt: new Date(Date.now() + 1).toISOString(),
      artifactProofAdditions: [proof]
    }, { leaseContext });
  });
  return proof;
}

describe("integration recovery artifact authority", () => {
  it("strictly validates a self-contained bounded companion manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-recovery-authority-schema-"));
    expect(integrationRecoveryArtifactProofSchema.parse(artifact(root))).toEqual(artifact(root));
    const {
      manifest: _manifest,
      platformMetadata: _platform,
      entryIdentities: _entryIdentities,
      ...legacy
    } = artifact(root);
    expect(integrationRecoveryArtifactProofSchema.parse(legacy)).toEqual(legacy);
    const { entryIdentities: _identities, ...missingIdentities } = artifact(root);
    expect(() => integrationRecoveryArtifactProofSchema.parse(missingIdentities)).toThrow();
    expect(() => integrationRecoveryArtifactProofSchema.parse({
      ...artifact(root),
      entryIdentities: [{ relativePath: ".", device: "1", inode: "4" }]
    })).toThrow();
    expect(() => integrationRecoveryArtifactProofSchema.parse({
      ...artifact(root),
      manifest: {
        ...artifact(root).manifest,
        entries: [{
          relativePath: ".",
          kind: "directory",
          bytes: 0,
          securityMode: "posix:0777"
        }]
      }
    })).toThrow();
    expect(() => integrationRecoveryArtifactProofSchema.parse({
      ...artifact(root),
      platformMetadata: {
        platform: "win32",
        identity: "bigint-device-inode",
        securityMode: "posix-permission-bits"
      }
    })).toThrow();
  });

  it("issues authority only from the persisted transaction head under the same live lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-recovery-authority-"));
    const stateDirectory = join(root, "state");
    const proof = await persistArtifact(stateDirectory, root);

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const authority = await loadIntegrationRecoveryArtifactAuthority(
        stateDirectory,
        { transactionId, role: "stage" },
        { leaseContext }
      );
      expect(Object.isFrozen(authority)).toBe(true);
      expect(consumeIntegrationRecoveryArtifactAuthority(
        authority,
        stateDirectory,
        transactionId,
        "stage",
        leaseContext
      )).toEqual(proof);
      expect(() => consumeIntegrationRecoveryArtifactAuthority(
        authority,
        stateDirectory,
        transactionId,
        "stage",
        leaseContext
      )).toThrow();
      const forged = Object.freeze(Object.create(null)) as IntegrationRecoveryArtifactAuthority;
      expect(() => consumeIntegrationRecoveryArtifactAuthority(
        forged,
        stateDirectory,
        transactionId,
        "stage",
        leaseContext
      )).toThrow();
      const cloned = JSON.parse(JSON.stringify(authority)) as IntegrationRecoveryArtifactAuthority;
      expect(() => consumeIntegrationRecoveryArtifactAuthority(
        cloned,
        stateDirectory,
        transactionId,
        "stage",
        leaseContext
      )).toThrow();
    });
  });

  it("rejects a fabricated matching proof and cross-state authority use", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-recovery-authority-cross-"));
    const stateDirectory = join(root, "state");
    await persistArtifact(stateDirectory, root);
    const otherState = join(root, "other-state");

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const authority = await loadIntegrationRecoveryArtifactAuthority(
        stateDirectory,
        { transactionId, role: "stage" },
        { leaseContext }
      );
      expect(() => consumeIntegrationRecoveryArtifactAuthority(
        authority,
        otherState,
        transactionId,
        "stage",
        leaseContext
      )).toThrow();
    });
  });
});
