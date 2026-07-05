import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  appendIntegrationRecoveryTransition,
  bindIntegrationRecordV2,
  createIntegrationRecoveryIntent,
  loadIntegrationRecoveryArtifactAuthority,
  withIntegrationMutationLease,
  type IntegrationMutationLeaseContext,
  type IntegrationRecoveryArtifactProof
} from "@skill-steward/store";
import { describe, expect, it } from "vitest";
import { inspectCompanionTree } from "../src/companion-manifest.js";
import {
  cleanupOwnedTree,
  createOwnedTreeStage,
  moveOwnedTree,
  ownedTreeRecoveryArtifactProof,
  ownedTreeHandleSnapshot,
  proveOwnedTree,
  resumeOwnedTreeCleanup,
  restoreOwnedTreeUpgrade,
  rollbackCreatedOwnedTreeAncestors
} from "../src/companion-owned-tree.js";
import type { OwnedTreeHandle } from "../src/companion-owned-tree-domain.js";
import {
  constants,
  type
  BigIntStats
} from "node:fs";

const TRANSACTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const execFileAsync = promisify(execFile);

async function sourceFixture(): Promise<{
  base: string;
  source: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "steward-owned-tree-"));
  const source = join(base, "package", "skill-steward-preflight");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "skill\n", "utf8");
  await writeFile(join(source, "references", "guide.md"), "guide\n", "utf8");
  await chmod(source, 0o700);
  await chmod(join(source, "references"), 0o750);
  await chmod(join(source, "SKILL.md"), 0o600);
  await chmod(join(source, "references", "guide.md"), 0o640);
  return { base, source };
}

async function createReadOnlyCompanionTree(root: string): Promise<void> {
  await mkdir(join(root, "references", "nested"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "readonly skill\n", "utf8");
  await writeFile(join(root, "references", "guide.md"), "readonly guide\n", "utf8");
  await writeFile(join(root, "references", "nested", "detail.md"), "readonly detail\n", "utf8");
  await chmod(join(root, "SKILL.md"), 0o400);
  await chmod(join(root, "references", "guide.md"), 0o400);
  await chmod(join(root, "references", "nested", "detail.md"), 0o400);
  await chmod(join(root, "references", "nested"), 0o555);
  await chmod(join(root, "references"), 0o500);
  await chmod(root, 0o555);
}

async function readOnlySourceFixture(): Promise<{ base: string; source: string }> {
  const base = await mkdtemp(join(tmpdir(), "steward-owned-tree-readonly-"));
  const source = join(base, "package", "skill-steward-preflight");
  await createReadOnlyCompanionTree(source);
  return { base, source };
}

function withIdentity(
  metadata: BigIntStats,
  identity: Partial<{ dev: bigint; ino: bigint }>
): BigIntStats {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "dev" && identity.dev !== undefined) return identity.dev;
      if (property === "ino" && identity.ino !== undefined) return identity.ino;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function persistAndLoadArtifactAuthority(
  stateDirectory: string,
  home: string,
  proof: IntegrationRecoveryArtifactProof,
  leaseContext: IntegrationMutationLeaseContext
) {
  const createdAt = new Date().toISOString();
  const companionPath = join(home, ".agents", "skills", "skill-steward-preflight");
  const configPath = join(home, ".codex", "hooks.json");
  await createIntegrationRecoveryIntent(stateDirectory, {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    planId: "owned-tree-test",
    harness: "codex",
    action: "create",
    companionPath,
    configPath,
    beforeFingerprint: null,
    afterFingerprint: proof.fingerprint,
    createdAt,
    lifecycleRecordBinding: bindIntegrationRecordV2({
      schemaVersion: 2,
      id: "owned-tree-recovery-record",
      harness: "codex",
      action: "apply",
      status: "installed",
      targetPath: configPath,
      beforeFingerprint: proof.fingerprint,
      afterFingerprint: proof.fingerprint,
      installedEntryFingerprint: proof.fingerprint,
      companion: {
        action: "create",
        path: companionPath,
        before: { state: "absent" },
        after: { state: "exact", fingerprint: proof.fingerprint },
        source: { fingerprint: proof.fingerprint },
        proof: { category: "new" },
        installedFingerprint: proof.fingerprint,
        consumers: ["codex"]
      },
      trigger: { planId: "owned-tree-test", harness: "codex", createdAt },
      createdAt
    }),
    artifactHints: [{ role: proof.role, path: proof.path }]
  }, { leaseContext });
  await appendIntegrationRecoveryTransition(stateDirectory, {
    transactionId: TRANSACTION_ID,
    expectedSequence: 0,
    expectedState: "prepared",
    state: "mutating",
    transitionedAt: new Date(Date.now() + 1).toISOString(),
    artifactProofAdditions: [proof]
  }, { leaseContext });
  return loadIntegrationRecoveryArtifactAuthority(
    stateDirectory,
    { transactionId: TRANSACTION_ID, role: proof.role },
    { leaseContext }
  );
}

async function withRestoredUpgrade(
  action: (input: {
    backup: OwnedTreeHandle;
    destinationPath: string;
    options: {
      stateDirectory: string;
      leaseContext: IntegrationMutationLeaseContext;
    };
  }) => Promise<void> | void
): Promise<void> {
  const { base, source } = await sourceFixture();
  const home = join(base, "home");
  const stateDirectory = join(base, "state");
  const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
  await mkdir(destinationPath, { recursive: true });
  await writeFile(join(destinationPath, "SKILL.md"), "old\n", "utf8");
  await chmod(destinationPath, 0o700);
  await chmod(join(destinationPath, "SKILL.md"), 0o600);
  const beforeManifest = await inspectCompanionTree(destinationPath, {
    boundary: home,
    platform: "linux"
  });
  const afterManifest = await inspectCompanionTree(source, {
    boundary: dirname(source),
    platform: "linux"
  });
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    const options = { stateDirectory, leaseContext };
    const staged = await createOwnedTreeStage({
      transactionId: TRANSACTION_ID,
      sourcePath: source,
      destinationPath,
      homeBoundaryPath: home,
      expectedManifest: afterManifest
    }, options);
    const backup = await proveOwnedTree({
      transactionId: TRANSACTION_ID,
      role: "backup",
      path: destinationPath,
      homeBoundaryPath: home,
      expectedManifest: beforeManifest
    }, options);
    const backupPath = join(
      dirname(destinationPath),
      `.skill-steward-owned.${TRANSACTION_ID}.backup`
    );
    expect((await moveOwnedTree(backup, backupPath, options)).state).toBe("moved");
    expect((await moveOwnedTree(staged.tree, destinationPath, options)).state).toBe("moved");
    await expect(restoreOwnedTreeUpgrade(staged.tree, backup, options)).resolves.toMatchObject({
      state: "restored"
    });
    await action({ backup, destinationPath, options });
  });
}

describe("companion owned tree", () => {
  it("creates missing ancestors and stages the exact reviewed POSIX manifest", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, { stateDirectory, leaseContext });

      const snapshot = ownedTreeHandleSnapshot(staged.tree);
      expect(Object.isFrozen(staged.tree)).toBe(true);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot).toMatchObject({
        role: "stage",
        status: "staged",
        manifestFingerprint: expectedManifest.fingerprint
      });
      expect(snapshot.path).toBe(join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.stage`
      ));
      expect(await inspectCompanionTree(snapshot.path, {
        boundary: dirname(destinationPath),
        platform: "linux"
      })).toEqual(expectedManifest);
      expect((await stat(snapshot.path)).mode & 0o777).toBe(0o700);
      expect((await stat(join(snapshot.path, "references"))).mode & 0o777).toBe(0o750);
      expect((await stat(join(snapshot.path, "SKILL.md"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(snapshot.path, "references", "guide.md"))).mode & 0o777)
        .toBe(0o640);
      expect(await readFile(join(snapshot.path, "SKILL.md"), "utf8")).toBe("skill\n");
      expect((await stat(snapshot.path, { bigint: true })).dev)
        .toBe((await stat(dirname(destinationPath), { bigint: true })).dev);
      expect(staged.createdAncestors).toHaveLength(2);
    });
  });

  it("stages and cleans nested read-only manifest directories", async () => {
    const { base, source } = await readOnlySourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, options);
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      expect((await stat(stagePath)).mode & 0o777).toBe(0o555);
      expect((await stat(join(stagePath, "references"))).mode & 0o777).toBe(0o500);
      expect((await stat(join(stagePath, "references", "nested"))).mode & 0o777).toBe(0o555);
      await expect(cleanupOwnedTree(staged.tree, options)).resolves.toMatchObject({
        state: "cleaned"
      });
    });
  });

  it("restores read-only directory modes before restart cleanup recovery", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-owned-tree-readonly-restart-"));
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const parent = join(home, ".agents", "skills");
    const cleanupPath = join(parent, `.skill-steward-owned.${TRANSACTION_ID}.cleanup`);
    await createReadOnlyCompanionTree(cleanupPath);
    const manifest = await inspectCompanionTree(cleanupPath, {
      boundary: parent,
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const handle = await proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "stage",
        path: cleanupPath,
        homeBoundaryPath: home,
        expectedParentPath: parent,
        expectedManifest: manifest
      }, options);
      const artifactAuthority = await persistAndLoadArtifactAuthority(
        stateDirectory,
        home,
        JSON.parse(JSON.stringify(
          ownedTreeRecoveryArtifactProof(handle)
        )) as IntegrationRecoveryArtifactProof,
        leaseContext
      );
      let durabilityFailed = false;
      await expect(cleanupOwnedTree(handle, {
        stateDirectory,
        leaseContext,
        hooks: {
          fsyncDirectory: async (path) => {
            if (!durabilityFailed && path.endsWith("nested")) {
              durabilityFailed = true;
              throw new Error("restart after read-only unlink");
            }
            const directory = await import("node:fs/promises").then(({ open }) => open(path));
            try { await directory.sync(); } finally { await directory.close(); }
          }
        }
      })).resolves.toMatchObject({ state: "cleanup-pending" });
      expect(durabilityFailed).toBe(true);
      expect((await stat(cleanupPath)).mode & 0o777).toBe(0o555);
      expect((await stat(join(cleanupPath, "references"))).mode & 0o777).toBe(0o500);
      expect((await stat(join(cleanupPath, "references", "nested"))).mode & 0o777)
        .toBe(0o555);
      const resumed = await resumeOwnedTreeCleanup({
        transactionId: TRANSACTION_ID,
        homeBoundaryPath: home,
        role: "stage",
        artifactAuthority
      }, options);
      await expect(cleanupOwnedTree(resumed, options)).resolves.toMatchObject({
        state: "cleaned"
      });
    });
  });

  it("restores one identity-bound temporary 0700 directory after a fresh-lease restart", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-owned-tree-readonly-crash-"));
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const parent = join(home, ".agents", "skills");
    const cleanupPath = join(parent, `.skill-steward-owned.${TRANSACTION_ID}.cleanup`);
    const interruptedPath = join(cleanupPath, "references");
    await createReadOnlyCompanionTree(cleanupPath);
    const manifest = await inspectCompanionTree(cleanupPath, {
      boundary: parent,
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const handle = await proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "stage",
        path: cleanupPath,
        homeBoundaryPath: home,
        expectedParentPath: parent,
        expectedManifest: manifest
      }, options);
      await persistAndLoadArtifactAuthority(
        stateDirectory,
        home,
        JSON.parse(JSON.stringify(
          ownedTreeRecoveryArtifactProof(handle)
        )) as IntegrationRecoveryArtifactProof,
        leaseContext
      );
      const interrupted = await open(
        interruptedPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await interrupted.chmod(0o700);
        await interrupted.sync();
      } finally {
        await interrupted.close();
      }
      await expect(proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "stage",
        path: cleanupPath,
        homeBoundaryPath: home,
        expectedParentPath: parent,
        expectedManifest: manifest
      }, options)).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const authority = await loadIntegrationRecoveryArtifactAuthority(
        stateDirectory,
        { transactionId: TRANSACTION_ID, role: "stage" },
        { leaseContext }
      );
      const options = { stateDirectory, leaseContext };
      const resumed = await resumeOwnedTreeCleanup({
        transactionId: TRANSACTION_ID,
        homeBoundaryPath: home,
        role: "stage",
        artifactAuthority: authority
      }, options);
      expect((await stat(interruptedPath)).mode & 0o777).toBe(0o500);
      await expect(cleanupOwnedTree(resumed, options)).resolves.toMatchObject({
        state: "cleaned"
      });
    });
  });

  it.each(["widen", "restore"] as const)(
    "never chmods a symlink target when a read-only cleanup parent is swapped before %s",
    async (phase) => {
      const { base, source } = await readOnlySourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const outside = join(base, "outside");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, "external.txt"), "external\n", "utf8");
      await chmod(outside, phase === "widen" ? 0o500 : 0o700);
      const outsideMode = (await stat(outside)).mode & 0o777;
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let targetPath: string | undefined;
        let armed = false;
        let samples = 0;
        let swapped = false;
        await cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: (boundary, paths) => {
              const targetBoundary = phase === "widen"
                ? "cleanup-parent-chmod-writable"
                : "cleanup-parent-chmod-restore";
              if (!armed && boundary === targetBoundary) {
                targetPath = paths[0];
                armed = true;
              }
            },
            lstatPath: async (path) => {
              const metadata = await lstat(path, { bigint: true });
              if (armed && !swapped && path === targetPath && ++samples === 2) {
                swapped = true;
                await rename(path, `${path}.owned-original`);
                await symlink(outside, path, "dir");
              }
              return metadata;
            }
          }
        }).catch(() => undefined);
        expect(swapped).toBe(true);
      });
      expect((await stat(outside)).mode & 0o777).toBe(outsideMode);
      await expect(readFile(join(outside, "external.txt"), "utf8")).resolves.toBe("external\n");
    }
  );

  it("fails closed on Windows before creating companion ancestors", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: { platform: "win32" }
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
    });
    await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an exact staged tree bottom-up and rolls back only created empty ancestors", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, options);
      await expect(cleanupOwnedTree(staged.tree, options)).resolves.toMatchObject({
        state: "cleaned"
      });
      await expect(rollbackCreatedOwnedTreeAncestors(
        staged.createdAncestors,
        options
      )).resolves.toBeUndefined();
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a forged handle without touching an exact staged tree", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, options);
      const forged = JSON.parse(JSON.stringify(staged.tree)) as OwnedTreeHandle;
      await expect(cleanupOwnedTree(forged, options)).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_INVALID"
      });
      await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
    });
  });

  it("classifies rename throws before and after commit without inferring from manifest alone", async () => {
    for (const commits of [false, true]) {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, { stateDirectory, leaseContext });
        const result = await moveOwnedTree(staged.tree, destinationPath, {
          stateDirectory,
          leaseContext,
          hooks: {
            renamePath: async (from, to) => {
              if (commits) await rename(from, to);
              throw new Error(commits ? "throw after commit" : "throw before commit");
            }
          }
        });
        expect(result.state).toBe(commits ? "moved" : "not-moved");
        expect(ownedTreeHandleSnapshot(staged.tree).path)
          .toBe(commits ? destinationPath : join(
            dirname(destinationPath),
            `.skill-steward-owned.${TRANSACTION_ID}.stage`
          ));
      });
    }
  });

  it("refuses a destination collision and preserves both trees", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, options);
      await mkdir(destinationPath);
      await writeFile(join(destinationPath, "external.txt"), "external\n", "utf8");
      await expect(moveOwnedTree(staged.tree, destinationPath, options)).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_DRIFT"
      });
      await expect(readFile(join(destinationPath, "external.txt"), "utf8"))
        .resolves.toBe("external\n");
      await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
    });
  });

  it("atomically preserves a race-created empty destination directory", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const sourcePath = ownedTreeHandleSnapshot(staged.tree).path;
      let injected = false;
      let externalIdentity: bigint | undefined;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeRenameNoReplace: async () => {
            injected = true;
            await mkdir(destinationPath, { mode: 0o700 });
            externalIdentity = (await stat(destinationPath, { bigint: true })).ino;
          }
        }
      });
      expect(injected).toBe(true);
      expect(result.state).toBe("uncertain");
      expect((await stat(destinationPath, { bigint: true })).ino).toBe(externalIdentity);
      await expect(access(sourcePath)).resolves.toBeUndefined();
    });
  });

  it("never renames a foreign stage through a substituted parent path", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const parentPath = join(home, ".agents", "skills");
    const displacedParent = join(home, ".agents", "skills-owned");
    const destinationPath = join(parentPath, "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      const ownedIdentity = (await stat(stagePath, { bigint: true })).ino;
      let foreignIdentity: bigint | undefined;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeRenameNoReplace: async (from) => {
            await rename(parentPath, displacedParent);
            await mkdir(parentPath, { mode: 0o700 });
            await mkdir(from, { mode: 0o700 });
            await writeFile(join(from, "foreign.txt"), "foreign\n", "utf8");
            foreignIdentity = (await stat(from, { bigint: true })).ino;
          }
        }
      });
      expect(result.state).toBe("uncertain");
      expect((await stat(stagePath, { bigint: true })).ino).toBe(foreignIdentity);
      await expect(readFile(join(stagePath, "foreign.txt"), "utf8")).resolves.toBe("foreign\n");
      await expect(access(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(
        join(displacedParent, basename(destinationPath)),
        { bigint: true }
      )).ino).toBe(ownedIdentity);
    });
  });

  it.each([
    ["unsupported", "aix"],
    ["mismatched", process.platform === "darwin" ? "linux" : "darwin"]
  ] as const)("fails closed for a %s native no-replace helper", async (_case, platform) => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const sourcePath = ownedTreeHandleSnapshot(staged.tree).path;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: { platform: platform as NodeJS.Platform }
      });
      expect(result).toMatchObject({
        state: "not-moved",
        cause: { code: "INTEGRATION_CONFIGURATION_INVALID" }
      });
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(access(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("fails closed when the no-replace primitive reports an unavailable capability", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const sourcePath = ownedTreeHandleSnapshot(staged.tree).path;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async () => {
            throw Object.assign(new Error("renameat2 is unavailable"), { code: "ENOSYS" });
          }
        }
      });
      expect(result).toMatchObject({
        state: "not-moved",
        cause: { code: "INTEGRATION_CONFIGURATION_INVALID" }
      });
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(access(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("backs up, installs, and restores an upgrade while deleting only the exact new tree", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(destinationPath, { recursive: true });
    await writeFile(join(destinationPath, "SKILL.md"), "old\n", "utf8");
    await chmod(destinationPath, 0o700);
    await chmod(join(destinationPath, "SKILL.md"), 0o600);
    const beforeManifest = await inspectCompanionTree(destinationPath, {
      boundary: home,
      platform: "linux"
    });
    const afterManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });

    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: afterManifest
      }, options);
      const backup = await proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "backup",
        path: destinationPath,
        homeBoundaryPath: home,
        expectedManifest: beforeManifest
      }, options);
      const backupPath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.backup`
      );
      expect((await moveOwnedTree(backup, backupPath, options)).state).toBe("moved");
      expect((await moveOwnedTree(staged.tree, destinationPath, options)).state).toBe("moved");
      expect(await readFile(join(destinationPath, "SKILL.md"), "utf8")).toBe("skill\n");

      await expect(restoreOwnedTreeUpgrade(staged.tree, backup, options)).resolves.toMatchObject({
        state: "restored"
      });
      expect(await readFile(join(destinationPath, "SKILL.md"), "utf8")).toBe("old\n");
      await expect(access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["move", "cleanup", "recovery-proof", "restore"] as const)(
    "treats a restored handle as terminal for %s",
    async (operation) => {
      await withRestoredUpgrade(async ({ backup, destinationPath, options }) => {
        const nextPath = join(dirname(destinationPath), `terminal-${operation}`);
        if (operation === "move") {
          await expect(moveOwnedTree(backup, nextPath, options)).rejects.toMatchObject({
            code: "INTEGRATION_CONFIGURATION_INVALID"
          });
        } else if (operation === "cleanup") {
          await expect(cleanupOwnedTree(backup, options)).rejects.toMatchObject({
            code: "INTEGRATION_CONFIGURATION_INVALID"
          });
        } else if (operation === "recovery-proof") {
          expect(() => ownedTreeRecoveryArtifactProof(backup)).toThrow(expect.objectContaining({
            code: "INTEGRATION_CONFIGURATION_INVALID"
          }));
        } else {
          await expect(restoreOwnedTreeUpgrade(backup, backup, options)).rejects.toMatchObject({
            code: "INTEGRATION_CONFIGURATION_INVALID"
          });
        }
        expect(await readFile(join(destinationPath, "SKILL.md"), "utf8")).toBe("old\n");
        await expect(access(destinationPath)).resolves.toBeUndefined();
      });
    }
  );

  it("returns committed recovery-incomplete when cleanup drifts after restoration", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(destinationPath, { recursive: true });
    await writeFile(join(destinationPath, "SKILL.md"), "old\n", "utf8");
    await chmod(destinationPath, 0o700);
    await chmod(join(destinationPath, "SKILL.md"), 0o600);
    const beforeManifest = await inspectCompanionTree(destinationPath, {
      boundary: home,
      platform: "linux"
    });
    const afterManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: afterManifest
      }, options);
      const backup = await proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "backup",
        path: destinationPath,
        homeBoundaryPath: home,
        expectedManifest: beforeManifest
      }, options);
      const parent = dirname(destinationPath);
      const backupPath = join(parent, `.skill-steward-owned.${TRANSACTION_ID}.backup`);
      const cleanupPath = join(parent, `.skill-steward-owned.${TRANSACTION_ID}.cleanup`);
      expect((await moveOwnedTree(backup, backupPath, options)).state).toBe("moved");
      expect((await moveOwnedTree(staged.tree, destinationPath, options)).state).toBe("moved");
      let injected = false;
      const receipt = await restoreOwnedTreeUpgrade(staged.tree, backup, {
        stateDirectory,
        leaseContext,
        hooks: {
          afterBoundary: async (boundary, paths) => {
            if (
              boundary === "rename"
              && paths[0] === backupPath
              && paths[1] === destinationPath
              && !injected
            ) {
              injected = true;
              await writeFile(join(cleanupPath, "external.txt"), "external\n", "utf8");
            }
          }
        }
      });
      expect(injected).toBe(true);
      expect(receipt).toMatchObject({
        state: "recovery-incomplete",
        warning: {
          code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE",
          cause: { code: "INTEGRATION_CONFIGURATION_DRIFT" }
        }
      });
      expect(await readFile(join(destinationPath, "SKILL.md"), "utf8")).toBe("old\n");
      expect(await readFile(join(cleanupPath, "external.txt"), "utf8")).toBe("external\n");
    });
  });

  it("compensates an exact partial stage and its created ancestors after source drift", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let changed = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary) => {
            if (boundary === "copy-file-write" && !changed) {
              changed = true;
              await writeFile(join(source, "SKILL.md"), "changed during copy\n", "utf8");
            }
          }
        }
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
    });
    expect(changed).toBe(true);
    await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("compensates an exact completed stage after a late source entry appears", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let injected = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary) => {
            if (boundary === "copy-directory-fsync" && !injected) {
              injected = true;
              await writeFile(join(source, "late.txt"), "late\n", "utf8");
            }
          }
        }
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
    });
    expect(injected).toBe(true);
    await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unlink", "rmdir"] as const)(
    "never follows a relocated stage root during partial compensation %s",
    async (failAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      const stagePath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.stage`
      );
      const relocatedStage = join(base, "relocated-stage");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let lateFailure = false;
      let swapped = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary, paths) => {
              if (boundary === "copy-directory-fsync" && !lateFailure) {
                lateFailure = true;
                await writeFile(join(source, "late.txt"), "late\n", "utf8");
                return;
              }
              if (boundary !== failAt || swapped) return;
              if (failAt === "unlink" && !paths[0]?.endsWith("references/guide.md")) return;
              if (failAt === "rmdir" && basename(paths[0]!) !== "references") return;
              swapped = true;
              await rename(stagePath, relocatedStage);
              await symlink(relocatedStage, stagePath);
            }
          }
        })).rejects.toMatchObject({
          code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
        });
      });
      expect(lateFailure).toBe(true);
      expect(swapped).toBe(true);
      const preserved = failAt === "unlink"
        ? join(relocatedStage, "references", "guide.md")
        : join(relocatedStage, "references");
      await expect(access(preserved)).resolves.toBeUndefined();
    }
  );

  it.each(["unlink", "rmdir"] as const)(
    "never deletes through a parent substituted after final %s verification",
    async (operation) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const outside = join(base, "outside");
      const stateDirectory = join(base, "state");
      const parentPath = join(home, ".agents", "skills");
      const cleanupPath = join(
        parentPath,
        `.skill-steward-owned.${TRANSACTION_ID}.cleanup`
      );
      const displaced = `${cleanupPath}.owned-original`;
      const destinationPath = join(parentPath, "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      await mkdir(join(outside, "references"), { recursive: true, mode: 0o700 });
      if (operation === "unlink") {
        await writeFile(join(outside, "references", "guide.md"), "external\n", "utf8");
      }
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let armed = false;
        let samples = 0;
        let swapped = false;
        const swapRoot = async () => {
          swapped = true;
          await rename(cleanupPath, displaced);
          await symlink(outside, cleanupPath, "dir");
        };
        await cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: (boundary, paths) => {
              if (operation === "unlink") {
                if (boundary === "unlink" && paths[0]?.endsWith("references/guide.md")) {
                  armed = true;
                }
              } else if (boundary === "rmdir" && basename(paths[0]!) === "references") {
                armed = true;
              }
            },
            openPath: async (path, flags, mode) => {
              const handle = await open(path, flags, mode);
              if (
                operation === "unlink"
                && armed
                && !swapped
                && path.endsWith("references/guide.md")
                && ++samples === 2
              ) await swapRoot();
              return handle;
            },
            lstatPath: async (path) => {
              const metadata = await lstat(path, { bigint: true });
              if (
                operation === "rmdir"
                && armed
                && !swapped
                && path.endsWith("/references")
                && ++samples === 2
              ) await swapRoot();
              return metadata;
            }
          }
        }).catch(() => undefined);
        expect(swapped).toBe(true);
      });
      if (operation === "unlink") {
        await expect(readFile(join(outside, "references", "guide.md"), "utf8"))
          .resolves.toBe("external\n");
      } else {
        await expect(access(join(outside, "references"))).resolves.toBeUndefined();
      }
    }
  );

  it.each(["unlink", "rmdir"] as const)(
    "classifies a partial compensation %s after-boundary failure from the real outcome",
    async (failAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let lateFailure = false;
      let afterFailure = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary) => {
              if (boundary === "copy-directory-fsync" && !lateFailure) {
                lateFailure = true;
                await writeFile(join(source, "late.txt"), "late\n", "utf8");
              }
            },
            afterBoundary: (boundary) => {
              if (boundary === failAt && !afterFailure) {
                afterFailure = true;
                throw new Error(`partial compensation ${failAt} after-boundary failure`);
              }
            }
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      });
      expect(lateFailure).toBe(true);
      expect(afterFailure).toBe(true);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["unlink", "rmdir"] as const)(
    "recognizes a committed partial compensation %s that throws",
    async (failAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let lateFailure = false;
      let committedThrows = 0;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary) => {
              if (boundary === "copy-directory-fsync" && !lateFailure) {
                lateFailure = true;
                await writeFile(join(source, "late.txt"), "late\n", "utf8");
              }
            },
            ...(failAt === "unlink"
              ? {
                  unlinkPath: async (path: string) => {
                    await unlink(path);
                    committedThrows += 1;
                    throw new Error("unlink threw after compensation commit");
                  }
                }
              : {
                  rmdirPath: async (path: string) => {
                    await rmdir(path);
                    committedThrows += 1;
                    throw new Error("rmdir threw after compensation commit");
                  }
                })
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      });
      expect(lateFailure).toBe(true);
      expect(committedThrows).toBeGreaterThan(0);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["unlink", "rmdir"] as const)(
    "stops partial compensation immediately after lease loss following %s",
    async (loseAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      const matchingCommits: string[] = [];
      let lateFailure = false;
      await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary) => {
              if (boundary === "copy-directory-fsync" && !lateFailure) {
                lateFailure = true;
                await writeFile(join(source, "late.txt"), "late\n", "utf8");
              }
            },
            afterBoundary: async (boundary) => {
              if (boundary !== loseAt) return;
              matchingCommits.push(boundary);
              if (matchingCommits.length === 1) {
                await unlink(join(stateDirectory, "integration-mutation.lease"));
              }
            }
          }
        });
      })).rejects.toBeInstanceOf(AggregateError);
      expect(lateFailure).toBe(true);
      expect(matchingCommits).toEqual([loseAt]);
    }
  );

  it("returns rename uncertainty for a two-name state and preserves both names", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, { stateDirectory, leaseContext });
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async (from, to) => {
            await rename(from, to);
            await mkdir(from, { mode: 0o700 });
            await writeFile(join(from, "external.txt"), "external\n", "utf8");
            throw new Error("ambiguous two-name outcome");
          }
        }
      });
      expect(result).toMatchObject({
        state: "uncertain",
        error: { code: "INTEGRATION_CONFIGURATION_UNCERTAIN" }
      });
      await expect(access(stagePath)).resolves.toBeUndefined();
      await expect(access(destinationPath)).resolves.toBeUndefined();
      expect(await inspectCompanionTree(destinationPath, {
        boundary: dirname(destinationPath),
        platform: "linux"
      })).toEqual(expectedManifest);
    });
  });

  it("preserves a replacement injected at the unlink boundary", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, { stateDirectory, leaseContext });
      let replacedPath = "";
      await expect(cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary, paths) => {
            if (boundary !== "unlink" || replacedPath !== "") return;
            replacedPath = paths[0]!;
            await rename(replacedPath, `${replacedPath}.external-original`);
            await writeFile(replacedPath, "external replacement\n", { mode: 0o600 });
          }
        }
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      expect(await readFile(replacedPath, "utf8")).toBe("external replacement\n");
      await expect(access(`${replacedPath}.external-original`)).resolves.toBeUndefined();
    });
  });

  it("retries deterministic cleanup after unlink and parent-fsync failures", async () => {
    for (const failAt of ["unlink", "unlink-parent-fsync"] as const) {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, { stateDirectory, leaseContext });
        let failed = false;
        const receipt = await cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: failAt === "unlink"
            ? {
                unlinkPath: async () => {
                  if (!failed) {
                    failed = true;
                    throw new Error("unlink failed before commit");
                  }
                }
              }
            : {
                fsyncDirectory: async (path) => {
                  if (!failed && path.endsWith("references")) {
                    failed = true;
                    throw new Error("parent fsync failed after unlink");
                  }
                  const handle = await import("node:fs/promises").then(({ open }) => open(path));
                  try { await handle.sync(); } finally { await handle.close(); }
                }
              }
        });
        expect(receipt).toMatchObject({
          state: "cleanup-pending",
          warning: { code: "INTEGRATION_CONFIGURATION_CLEANUP_PENDING" }
        });
        expect(failed).toBe(true);
        await expect(cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext }))
          .resolves.toMatchObject({ state: "cleaned" });
        await expect(cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext }))
          .rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      });
    }
  });

  it("serializes same-context stage calls and never overlaps mutation boundaries", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      let active = 0;
      let maximum = 0;
      const options = {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await delay(1);
            active -= 1;
          }
        }
      };
      const input = {
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      };
      const first = createOwnedTreeStage(input, options);
      const second = createOwnedTreeStage(input, options);
      const [one, two] = await Promise.allSettled([first, second]);
      expect(one.status).toBe("fulfilled");
      expect(two).toMatchObject({
        status: "rejected",
        reason: { code: "INTEGRATION_CONFIGURATION_DRIFT" }
      });
      expect(maximum).toBe(1);
    });
  });

  it("converts an owned proof to a self-contained strict recovery artifact", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, { stateDirectory, leaseContext });
      const proof = ownedTreeRecoveryArtifactProof(staged.tree);
      expect(proof).toEqual({
        role: "stage",
        path: ownedTreeHandleSnapshot(staged.tree).path,
        physicalParentPath: await import("node:fs/promises")
          .then(({ realpath }) => realpath(dirname(destinationPath))),
        parentIdentity: {
          device: (await stat(dirname(destinationPath), { bigint: true })).dev.toString(),
          inode: (await stat(dirname(destinationPath), { bigint: true })).ino.toString()
        },
        rootIdentity: {
          device: (await stat(ownedTreeHandleSnapshot(staged.tree).path, { bigint: true })).dev
            .toString(),
          inode: (await stat(ownedTreeHandleSnapshot(staged.tree).path, { bigint: true })).ino
            .toString()
        },
        fingerprint: expectedManifest.fingerprint,
        entryIdentities: await Promise.all(expectedManifest.entries.map(async ({ relativePath }) => {
          const path = relativePath === "."
            ? ownedTreeHandleSnapshot(staged.tree).path
            : join(ownedTreeHandleSnapshot(staged.tree).path, relativePath);
          const identity = await stat(path, { bigint: true });
          return {
            relativePath,
            device: identity.dev.toString(),
            inode: identity.ino.toString()
          };
        })),
        manifest: expectedManifest,
        platformMetadata: {
          platform: "posix",
          identity: "bigint-device-inode",
          securityMode: "posix-permission-bits"
        }
      });
      expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
      expect(Object.isFrozen(proof.manifest)).toBe(true);
    });
  });

  it("reasserts the lease at every POSIX mutation boundary", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    const seen = new Set<string>();
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = {
        stateDirectory,
        leaseContext,
        hooks: { beforeBoundary: (boundary: string) => { seen.add(boundary); } }
      };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, options);
      await cleanupOwnedTree(staged.tree, options);
      await rollbackCreatedOwnedTreeAncestors(staged.createdAncestors, options);
    });
    expect([...seen].sort()).toEqual([
      "ancestor-mkdir",
      "ancestor-parent-fsync",
      "ancestor-rmdir",
      "copy-directory-chmod",
      "copy-directory-fsync",
      "copy-directory-mkdir",
      "copy-file-chmod",
      "copy-file-create",
      "copy-file-fsync",
      "copy-file-write",
      "copy-parent-fsync",
      "rename",
      "rename-parent-fsync",
      "rmdir",
      "rmdir-parent-fsync",
      "stage-mkdir",
      "stage-parent-fsync",
      "stage-root-chmod",
      "unlink",
      "unlink-parent-fsync"
    ]);
  });

  it.each([
    "ancestor-mkdir",
    "ancestor-parent-fsync",
    "stage-mkdir",
    "stage-root-chmod",
    "stage-parent-fsync",
    "copy-directory-mkdir",
    "copy-directory-chmod",
    "copy-file-create",
    "copy-file-write",
    "copy-file-chmod",
    "copy-file-fsync",
    "copy-parent-fsync",
    "copy-directory-fsync"
  ] as const)("compensates a failure at the %s mutation boundary", async (failAt) => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let failed = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: (boundary) => {
            if (boundary === failAt && !failed) {
              failed = true;
              throw new Error(`injected ${failAt} failure`);
            }
          }
        }
      })).rejects.toBeInstanceOf(Error);
    });
    expect(failed).toBe(true);
    await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "ancestor-mkdir",
    "ancestor-parent-fsync",
    "stage-mkdir",
    "stage-root-chmod",
    "stage-parent-fsync",
    "copy-directory-mkdir",
    "copy-directory-chmod",
    "copy-file-create",
    "copy-file-write",
    "copy-file-chmod",
    "copy-file-fsync",
    "copy-parent-fsync",
    "copy-directory-fsync"
  ] as const)("compensates a post-commit failure at %s", async (failAt) => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let failed = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          afterBoundary: (boundary) => {
            if (boundary === failAt && !failed) {
              failed = true;
              throw new Error(`post-commit ${failAt} failure`);
            }
          }
        }
      })).rejects.toBeInstanceOf(Error);
    });
    expect(failed).toBe(true);
    await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "ancestor-mkdir",
    "ancestor-parent-fsync",
    "stage-mkdir",
    "stage-root-chmod",
    "stage-parent-fsync",
    "copy-directory-mkdir",
    "copy-directory-chmod",
    "copy-file-create",
    "copy-file-write",
    "copy-file-chmod",
    "copy-file-fsync",
    "copy-parent-fsync",
    "copy-directory-fsync"
  ] as const)("stops after lease loss immediately after %s", async (loseAt) => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    const committed: string[] = [];
    let lostIndex = -1;
    await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          afterBoundary: async (boundary) => {
            committed.push(boundary);
            if (boundary === loseAt && lostIndex === -1) {
              lostIndex = committed.length - 1;
              await unlink(join(stateDirectory, "integration-mutation.lease"));
            }
          }
        }
      });
    })).rejects.toBeInstanceOf(AggregateError);
    expect(lostIndex).toBeGreaterThanOrEqual(0);
    expect(committed).toHaveLength(lostIndex + 1);
  });

  it("exposes every real verification and probe boundary on the success lifecycle", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    const seen = new Set<string>();
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeVerification: (boundary: string) => { seen.add(boundary); },
          afterVerification: (boundary: string) => { seen.add(boundary); }
        }
      };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, options);
      expect((await moveOwnedTree(staged.tree, destinationPath, options)).state).toBe("moved");
      await cleanupOwnedTree(staged.tree, options);
    });
    expect([...seen].sort()).toEqual([
      "ancestor-created-verify",
      "cleanup-directory-probe",
      "cleanup-file-probe",
      "cleanup-parent-chain-verify",
      "copy-directory-verify",
      "copy-file-verify",
      "copy-parent-chain-verify",
      "copy-source-manifest-verify",
      "copy-stage-manifest-verify",
      "directory-fsync-verify",
      "exact-tree-manifest-verify",
      "rename-destination-probe",
      "rename-source-probe",
      "source-parent-chain-verify",
      "stage-root-verify"
    ]);
  });

  it.each(["before", "after"] as const)(
    "compensates a %s copy verification failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let failed = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const inject = (boundary: string) => {
          if (boundary === "copy-file-verify" && !failed) {
            failed = true;
            throw new Error(`${timing} copy verification failed`);
          }
        };
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toBeInstanceOf(Error);
      });
      expect(failed).toBe(true);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["before", "after"] as const)(
    "preserves the tree with typed drift on a %s exact-tree manifest verification failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let failed = false;
        const inject = (boundary: string) => {
          if (boundary === "exact-tree-manifest-verify" && !failed) {
            failed = true;
            throw new Error(`${timing} exact-tree manifest verification failed`);
          }
        };
        await expect(moveOwnedTree(staged.tree, destinationPath, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
        expect(failed).toBe(true);
        await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
      });
    }
  );

  it.each(["before", "after"] as const)(
    "returns typed drift on a %s source manifest verification failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let failed = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const inject = (boundary: string) => {
          if (boundary === "copy-source-manifest-verify" && !failed) {
            failed = true;
            throw new Error(`${timing} source manifest verification failed`);
          }
        };
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      });
      expect(failed).toBe(true);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["before", "after"] as const)(
    "compensates with typed drift on a %s staged manifest verification failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let failed = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const inject = (boundary: string) => {
          if (boundary === "copy-stage-manifest-verify" && !failed) {
            failed = true;
            throw new Error(`${timing} staged manifest verification failed`);
          }
        };
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      });
      expect(failed).toBe(true);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["before", "after"] as const)(
    "preserves partial cleanup with typed drift on a %s full-tree verification failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let durabilityFailed = false;
        await expect(cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: {
            fsyncDirectory: async (path) => {
              if (!durabilityFailed && path.endsWith("references")) {
                durabilityFailed = true;
                throw new Error("leave cleanup partially complete");
              }
              const handle = await import("node:fs/promises").then(({ open }) => open(path));
              try { await handle.sync(); } finally { await handle.close(); }
            }
          }
        })).resolves.toMatchObject({ state: "cleanup-pending" });
        expect(durabilityFailed).toBe(true);
        let failed = false;
        const inject = (boundary: string) => {
          if (boundary === "partial-cleanup-tree-verify" && !failed) {
            failed = true;
            throw new Error(`${timing} partial cleanup full-tree verification failed`);
          }
        };
        await expect(cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
        expect(failed).toBe(true);
        await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
      });
    }
  );

  it.each([
    ["source", "copy-source-manifest-verify"],
    ["stage", "copy-stage-manifest-verify"]
  ] as const)(
    "reasserts the lease after %s manifest verification",
    async (_category, verificationBoundary) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let lost = false;
      await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            afterVerification: async (boundary) => {
              if (boundary === verificationBoundary && !lost) {
                lost = true;
                await unlink(join(stateDirectory, "integration-mutation.lease"));
              }
            }
          }
        });
      })).rejects.toBeInstanceOf(AggregateError);
      expect(lost).toBe(true);
    }
  );

  it("reasserts the lease after exact-tree manifest verification", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let lost = false;
    await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          afterVerification: async (boundary) => {
            if (boundary === "exact-tree-manifest-verify" && !lost) {
              lost = true;
              await unlink(join(stateDirectory, "integration-mutation.lease"));
            }
          }
        }
      });
    })).rejects.toBeInstanceOf(AggregateError);
    expect(lost).toBe(true);
  });

  it("reasserts the lease after partial-cleanup full-tree verification", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let lost = false;
    await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      let durabilityFailed = false;
      await cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          fsyncDirectory: async (path) => {
            if (!durabilityFailed && path.endsWith("references")) {
              durabilityFailed = true;
              throw new Error("leave cleanup partially complete");
            }
            const handle = await import("node:fs/promises").then(({ open }) => open(path));
            try { await handle.sync(); } finally { await handle.close(); }
          }
        }
      });
      await cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          afterVerification: async (boundary) => {
            if (boundary === "partial-cleanup-tree-verify" && !lost) {
              lost = true;
              await unlink(join(stateDirectory, "integration-mutation.lease"));
            }
          }
        }
      });
    })).rejects.toBeInstanceOf(AggregateError);
    expect(lost).toBe(true);
  });

  it.each(["before", "after"] as const)(
    "returns uncertainty for a %s rename outcome-probe failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let failed = false;
        const inject = (boundary: string) => {
          if (boundary === "rename-destination-probe" && !failed) {
            failed = true;
            throw new Error(`${timing} rename probe failed`);
          }
        };
        const result = await moveOwnedTree(staged.tree, destinationPath, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        });
        expect(result).toMatchObject({ state: "uncertain" });
        expect(failed).toBe(true);
      });
    }
  );

  it.each(["before", "after"] as const)(
    "preserves cleanup state on a %s deletion-probe failure",
    async (timing) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let failed = false;
        const inject = (boundary: string) => {
          if (boundary === "cleanup-file-probe" && !failed) {
            failed = true;
            throw new Error(`${timing} cleanup probe failed`);
          }
        };
        await expect(cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: timing === "before"
            ? { beforeVerification: inject }
            : { afterVerification: inject }
        })).rejects.toBeInstanceOf(Error);
        expect(failed).toBe(true);
        await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
      });
    }
  );

  it.each(["rename", "unlink", "rmdir", "ancestor-rmdir"] as const)(
    "stops the lifecycle after lease loss immediately after %s",
    async (loseAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      const committed: string[] = [];
      let lostIndex = -1;
      await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        const hooks = {
          afterBoundary: async (boundary: string) => {
            committed.push(boundary);
            if (boundary === loseAt && lostIndex === -1) {
              lostIndex = committed.length - 1;
              await unlink(join(stateDirectory, "integration-mutation.lease"));
            }
          }
        };
        if (loseAt === "ancestor-rmdir") {
          await cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext });
          await rollbackCreatedOwnedTreeAncestors(staged.createdAncestors, {
            stateDirectory,
            leaseContext,
            hooks
          });
        } else {
          await cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext, hooks });
        }
      })).rejects.toBeInstanceOf(AggregateError);
      expect(lostIndex).toBeGreaterThanOrEqual(0);
      expect(committed).toHaveLength(lostIndex + 1);
    }
  );

  it("does not write after the lease is lost at the exact file-write boundary", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    const stagePath = join(
      dirname(destinationPath),
      `.skill-steward-owned.${TRANSACTION_ID}.stage`
    );
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let lost = false;
    await expect(withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary) => {
            if (boundary === "copy-file-write" && !lost) {
              lost = true;
              await unlink(join(stateDirectory, "integration-mutation.lease"));
            }
          }
        }
      });
    })).rejects.toBeInstanceOf(AggregateError);
    expect(lost).toBe(true);
    expect((await stat(join(stagePath, "SKILL.md"))).size).toBe(0);
  });

  it("detects every reviewed source file changing at its copy boundary", async () => {
    for (const relativePath of ["SKILL.md", "references/guide.md"] as const) {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let changed = false;
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary, paths) => {
              if (
                boundary === "copy-file-write"
                && !changed
                && paths[0]?.endsWith(relativePath)
              ) {
                changed = true;
                await writeFile(join(source, ...relativePath.split("/")), "changed\n", "utf8");
              }
            }
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      });
      expect(changed).toBe(true);
      await expect(access(join(home, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves a late unknown stage entry and reports incomplete recovery", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    const stagePath = join(
      dirname(destinationPath),
      `.skill-steward-owned.${TRANSACTION_ID}.stage`
    );
    await mkdir(home, { mode: 0o700 });
    const expectedManifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let injected = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary) => {
            if (boundary === "copy-directory-fsync" && !injected) {
              injected = true;
              await writeFile(join(stagePath, "external.txt"), "external\n", "utf8");
            }
          }
        }
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
    });
    expect(await readFile(join(stagePath, "external.txt"), "utf8")).toBe("external\n");
  });

  it("detects parent and root replacement before rename or cleanup mutation", async () => {
    for (const replace of ["parent", "root"] as const) {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, { stateDirectory, leaseContext });
        const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
        if (replace === "parent") {
          const parent = dirname(stagePath);
          const savedParent = `${parent}.saved`;
          await expect(moveOwnedTree(staged.tree, destinationPath, {
            stateDirectory,
            leaseContext,
            hooks: {
              beforeBoundary: async (boundary) => {
                if (boundary !== "rename") return;
                await rename(parent, savedParent);
                await mkdir(parent, { mode: 0o700 });
              }
            }
          })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
          await expect(access(join(savedParent, basename(stagePath)))).resolves.toBeUndefined();
        } else {
          let savedRoot = "";
          await expect(cleanupOwnedTree(staged.tree, {
            stateDirectory,
            leaseContext,
            hooks: {
              beforeBoundary: async (boundary, paths) => {
                if (boundary !== "unlink" || savedRoot !== "") return;
                const cleanupRoot = dirname(paths[0]!);
                savedRoot = `${cleanupRoot}.saved`;
                await rename(cleanupRoot, savedRoot);
                await mkdir(cleanupRoot, { mode: 0o700 });
              }
            }
          })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
          await expect(access(savedRoot)).resolves.toBeUndefined();
        }
      });
    }
  });

  it("rejects symlink injection, zero identity, and cross-device proof", async () => {
    {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const expectedManifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            lstatPath: async (path) => withIdentity(
              await lstat(path, { bigint: true }),
              path === home ? { ino: 0n } : {}
            )
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      });
    }
    {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(dirname(destinationPath), { recursive: true });
      await cp(source, destinationPath, { recursive: true, force: true });
      const manifest = await inspectCompanionTree(destinationPath, {
        boundary: home,
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(proveOwnedTree({
          transactionId: TRANSACTION_ID,
          role: "backup",
          path: destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            lstatPath: async (path) => {
              const metadata = await lstat(path, { bigint: true });
              return path === destinationPath
                ? withIdentity(metadata, { dev: metadata.dev + 1n })
                : metadata;
            }
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      });
    }
    {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
        const saved = `${stagePath}.saved`;
        await expect(moveOwnedTree(staged.tree, destinationPath, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary) => {
              if (boundary !== "rename") return;
              await rename(stagePath, saved);
              await symlink(saved, stagePath);
            }
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
        await expect(access(saved)).resolves.toBeUndefined();
      });
    }
  });

  it("keeps cleanup retryable across rmdir and root durability failures", async () => {
    for (const failAt of ["rmdir", "root-fsync"] as const) {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let failed = false;
        let directorySyncs = 0;
        const receipt = await cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: failAt === "rmdir"
            ? {
                rmdirPath: async (path) => {
                  if (!failed) {
                    failed = true;
                    throw new Error("rmdir failed before commit");
                  }
                  await import("node:fs/promises").then(({ rmdir }) => rmdir(path));
                }
              }
            : {
                beforeBoundary: (boundary) => {
                  if (boundary === "rmdir-parent-fsync") directorySyncs += 1;
                },
                fsyncDirectory: async (path) => {
                  if (!failed && directorySyncs === 2) {
                    failed = true;
                    throw new Error("root parent fsync failed");
                  }
                  const handle = await import("node:fs/promises").then(({ open }) => open(path));
                  try { await handle.sync(); } finally { await handle.close(); }
                }
              }
        });
        expect(receipt).toMatchObject({ state: "cleanup-pending" });
        expect(failed).toBe(true);
        await expect(cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext }))
          .resolves.toMatchObject({ state: "cleaned" });
      });
    }
  });

  it("rejects cross-state and cross-parent handle reuse without mutation", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      await expect(moveOwnedTree(staged.tree, join(home, "other", "skill"), {
        stateDirectory,
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      await expect(cleanupOwnedTree(staged.tree, {
        stateDirectory: join(base, "other-state"),
        leaseContext
      })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID" });
      await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
    });
  });

  it("classifies committed rename durability failure as uncertainty", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          fsyncDirectory: async () => { throw new Error("rename parent fsync failed"); }
        }
      });
      expect(result).toMatchObject({
        state: "uncertain",
        error: { code: "INTEGRATION_CONFIGURATION_UNCERTAIN" }
      });
      expect(ownedTreeHandleSnapshot(staged.tree).path).toBe(destinationPath);
      expect(await inspectCompanionTree(destinationPath, {
        boundary: dirname(destinationPath),
        platform: "linux"
      })).toEqual(manifest);
    });
  });

  it("returns uncertainty when outcome probing fails after rename commit", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      let committed = false;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async (from, to) => {
            await rename(from, to);
            committed = true;
          },
          lstatPath: async (path) => {
            if (committed && path === destinationPath) {
              throw Object.assign(new Error("probe I/O failed"), { code: "EIO" });
            }
            return lstat(path, { bigint: true });
          }
        }
      });
      expect(result).toMatchObject({
        state: "uncertain",
        error: { code: "INTEGRATION_CONFIGURATION_UNCERTAIN" }
      });
      await expect(access(destinationPath)).resolves.toBeUndefined();
    });
  });

  it("treats a simulated same-identity two-name alias as uncertain", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      let aliasIdentity: { dev: bigint; ino: bigint } | undefined;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async (from, to) => {
            await rename(from, to);
            const destination = await lstat(to, { bigint: true });
            aliasIdentity = { dev: destination.dev, ino: destination.ino };
            await cp(to, from, { recursive: true, preserveTimestamps: true });
            throw new Error("simulated same-inode alias");
          },
          lstatPath: async (path) => {
            const metadata = await lstat(path, { bigint: true });
            return path === stagePath && aliasIdentity !== undefined
              ? withIdentity(metadata, aliasIdentity)
              : metadata;
          }
        }
      });
      expect(result).toMatchObject({ state: "uncertain" });
      await expect(access(stagePath)).resolves.toBeUndefined();
      await expect(access(destinationPath)).resolves.toBeUndefined();
    });
  });

  it("preserves both names when the unavoidable no-CAS rename window gains a destination", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async (from, to) => {
            await mkdir(to);
            await writeFile(join(to, "external.txt"), "external\n", "utf8");
            await rename(from, to);
          }
        }
      });
      expect(result).toMatchObject({ state: "uncertain" });
      await expect(access(stagePath)).resolves.toBeUndefined();
      expect(await readFile(join(destinationPath, "external.txt"), "utf8")).toBe("external\n");
    });
  });

  it("returns recovery-incomplete and preserves trees when backup restore proof drifts", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(destinationPath, { recursive: true });
    await writeFile(join(destinationPath, "SKILL.md"), "old\n", "utf8");
    await chmod(destinationPath, 0o700);
    await chmod(join(destinationPath, "SKILL.md"), 0o600);
    const before = await inspectCompanionTree(destinationPath, {
      boundary: home,
      platform: "linux"
    });
    const after = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: after
      }, options);
      const backup = await proveOwnedTree({
        transactionId: TRANSACTION_ID,
        role: "backup",
        path: destinationPath,
        homeBoundaryPath: home,
        expectedManifest: before
      }, options);
      const backupPath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.backup`
      );
      expect((await moveOwnedTree(backup, backupPath, options)).state).toBe("moved");
      expect((await moveOwnedTree(staged.tree, destinationPath, options)).state).toBe("moved");
      let renames = 0;
      const savedBackup = `${backupPath}.external-saved`;
      await expect(restoreOwnedTreeUpgrade(staged.tree, backup, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary) => {
            if (boundary !== "rename") return;
            renames += 1;
            if (renames !== 2) return;
            await rename(backupPath, savedBackup);
            await mkdir(backupPath, { mode: 0o700 });
            await writeFile(join(backupPath, "external.txt"), "external\n", "utf8");
          }
        }
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
      await expect(access(savedBackup)).resolves.toBeUndefined();
      expect(await readFile(join(destinationPath, "SKILL.md"), "utf8")).toBe("skill\n");
      await expect(access(join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.cleanup`
      ))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("never deletes an unknown similarly named sibling", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    const parent = dirname(destinationPath);
    const unknown = join(parent, ".skill-steward-owned.not-our-transaction.stage");
    await mkdir(parent, { recursive: true });
    await mkdir(unknown);
    await writeFile(join(unknown, "external.txt"), "external\n", "utf8");
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      await cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext });
    });
    expect(await readFile(join(unknown, "external.txt"), "utf8")).toBe("external\n");
  });

  it("recognizes committed unlink and rmdir throws, then finishes cleanup", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      await expect(cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          unlinkPath: async (path) => {
            await unlink(path);
            throw new Error("unlink threw after commit");
          },
          rmdirPath: async (path) => {
            await import("node:fs/promises").then(({ rmdir }) => rmdir(path));
            throw new Error("rmdir threw after commit");
          }
        }
      })).resolves.toMatchObject({ state: "cleaned" });
    });
  });

  it("keeps created-ancestor rollback retryable after an exact rmdir failure", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      await cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext });
      let failed = false;
      await expect(rollbackCreatedOwnedTreeAncestors(staged.createdAncestors, {
        stateDirectory,
        leaseContext,
        hooks: {
          rmdirPath: async () => {
            failed = true;
            throw new Error("ancestor rmdir failed before commit");
          }
        }
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
      expect(failed).toBe(true);
      await expect(rollbackCreatedOwnedTreeAncestors(
        staged.createdAncestors,
        { stateDirectory, leaseContext }
      )).resolves.toBeUndefined();
    });
  });

  it("resumes partial cleanup from only a persisted exact artifact proof", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, options);
      const cleanupPath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.cleanup`
      );
      expect((await moveOwnedTree(staged.tree, cleanupPath, options)).state).toBe("moved");
      const persistedProof = JSON.parse(JSON.stringify(
        ownedTreeRecoveryArtifactProof(staged.tree)
      )) as IntegrationRecoveryArtifactProof;
      const artifactAuthority = await persistAndLoadArtifactAuthority(
        stateDirectory,
        home,
        persistedProof,
        leaseContext
      );
      let failed = false;
      await expect(cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          fsyncDirectory: async (path) => {
            if (!failed && path.endsWith("references")) {
              failed = true;
              throw new Error("post-unlink fsync failed");
            }
            const handle = await import("node:fs/promises").then(({ open }) => open(path));
            try { await handle.sync(); } finally { await handle.close(); }
          }
        }
      })).resolves.toMatchObject({ state: "cleanup-pending" });
      const resumed = await resumeOwnedTreeCleanup({
        transactionId: TRANSACTION_ID,
        homeBoundaryPath: home,
        role: "stage",
        artifactAuthority
      }, options);
      expect(resumed).not.toBe(staged.tree);
      await expect(cleanupOwnedTree(resumed, options)).resolves.toMatchObject({
        state: "cleaned"
      });
    });
  });

  it("rejects a fabricated matching restart proof without Store authority", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, options);
      const cleanupPath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.cleanup`
      );
      expect((await moveOwnedTree(staged.tree, cleanupPath, options)).state).toBe("moved");
      const fabricated = JSON.parse(JSON.stringify(
        ownedTreeRecoveryArtifactProof(staged.tree)
      ));
      await expect(resumeOwnedTreeCleanup({
        transactionId: TRANSACTION_ID,
        homeBoundaryPath: home,
        role: "stage",
        artifactAuthority: fabricated
      }, options)).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_INVALID"
      });
      expect(await inspectCompanionTree(cleanupPath, {
        boundary: dirname(cleanupPath),
        platform: "linux"
      })).toEqual(manifest);
    });
  });

  it("resumes parent durability when the cleanup root is already absent", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const options = { stateDirectory, leaseContext };
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, options);
      const cleanupPath = join(
        dirname(destinationPath),
        `.skill-steward-owned.${TRANSACTION_ID}.cleanup`
      );
      expect((await moveOwnedTree(staged.tree, cleanupPath, options)).state).toBe("moved");
      const persistedProof = JSON.parse(JSON.stringify(
        ownedTreeRecoveryArtifactProof(staged.tree)
      )) as IntegrationRecoveryArtifactProof;
      const artifactAuthority = await persistAndLoadArtifactAuthority(
        stateDirectory,
        home,
        persistedProof,
        leaseContext
      );
      let directorySyncs = 0;
      let failed = false;
      await expect(cleanupOwnedTree(staged.tree, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: (boundary) => {
            if (boundary === "rmdir-parent-fsync") directorySyncs += 1;
          },
          fsyncDirectory: async (path) => {
            if (!failed && directorySyncs === 2) {
              failed = true;
              throw new Error("root parent durability unknown");
            }
            const handle = await import("node:fs/promises").then(({ open }) => open(path));
            try { await handle.sync(); } finally { await handle.close(); }
          }
        }
      })).resolves.toMatchObject({ state: "cleanup-pending" });
      await expect(access(cleanupPath)).rejects.toMatchObject({ code: "ENOENT" });
      const resumed = await resumeOwnedTreeCleanup({
        transactionId: TRANSACTION_ID,
        homeBoundaryPath: home,
        role: "stage",
        artifactAuthority
      }, options);
      await expect(cleanupOwnedTree(resumed, options)).resolves.toMatchObject({
        state: "cleaned"
      });
    });
  });

  it("does not follow a swapped intermediate stage symlink at file creation", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const outside = join(base, "outside");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let swapped = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary, paths) => {
            if (
              boundary !== "copy-file-create"
              || swapped
              || !paths[0]?.endsWith("references/guide.md")
            ) return;
            swapped = true;
            const references = dirname(paths[0]);
            await rename(references, `${references}.owned-original`);
            await symlink(outside, references);
          }
        }
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
    });
    expect(swapped).toBe(true);
    await expect(access(join(outside, "guide.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reproves the original stage parent identity before creating a file", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    let swapped = false;
    let fileCreated = false;
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      await expect(createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, {
        stateDirectory,
        leaseContext,
        hooks: {
          beforeBoundary: async (boundary, paths) => {
            if (
              boundary !== "copy-file-create"
              || swapped
              || !paths[0]?.endsWith("references/guide.md")
            ) return;
            swapped = true;
            const stageRoot = dirname(dirname(paths[0]));
            const stageParent = dirname(stageRoot);
            const savedParent = `${stageParent}.owned-original`;
            await rename(stageParent, savedParent);
            await mkdir(stageParent, { mode: 0o700 });
            await rename(
              join(savedParent, basename(stageRoot)),
              join(stageParent, basename(stageRoot))
            );
          },
          afterBoundary: (boundary) => {
            if (swapped && boundary === "copy-file-create") fileCreated = true;
          }
        }
      })).rejects.toMatchObject({
        code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
      });
    });
    expect(swapped).toBe(true);
    expect(fileCreated).toBe(false);
  });

  it.each(["unlink", "rmdir"] as const)(
    "does not follow a swapped cleanup symlink at %s",
    async (failAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const outside = join(base, "outside");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      if (failAt === "unlink") {
        await writeFile(join(outside, "guide.md"), "outside\n", "utf8");
      }
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        const staged = await createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, { stateDirectory, leaseContext });
        let swapped = false;
        await expect(cleanupOwnedTree(staged.tree, {
          stateDirectory,
          leaseContext,
          hooks: {
            beforeBoundary: async (boundary, paths) => {
              if (boundary !== failAt || swapped) return;
              if (failAt === "rmdir" && basename(paths[0]!) !== "references") return;
              if (failAt === "unlink" && !paths[0]?.endsWith("references/guide.md")) return;
              swapped = true;
              const references = failAt === "unlink" ? dirname(paths[0]!) : paths[0]!;
              await rename(references, `${references}.owned-original`);
              await symlink(outside, references);
            }
          }
        })).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
        expect(swapped).toBe(true);
      });
      if (failAt === "unlink") {
        expect(await readFile(join(outside, "guide.md"), "utf8")).toBe("outside\n");
      } else {
        await expect(access(outside)).resolves.toBeUndefined();
      }
    }
  );

  it.each(["root", "directory", "file"] as const)(
    "never adopts an exact-looking %s replacement after exclusive creation",
    async (replaceAt) => {
      const { base, source } = await sourceFixture();
      const home = join(base, "home");
      const stateDirectory = join(base, "state");
      const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
      await mkdir(home, { mode: 0o700 });
      const manifest = await inspectCompanionTree(source, {
        boundary: dirname(source),
        platform: "linux"
      });
      let replacementPath = "";
      await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
        await expect(createOwnedTreeStage({
          transactionId: TRANSACTION_ID,
          sourcePath: source,
          destinationPath,
          homeBoundaryPath: home,
          expectedManifest: manifest
        }, {
          stateDirectory,
          leaseContext,
          hooks: {
            afterBoundary: async (boundary, paths) => {
              const matches = replaceAt === "root"
                ? boundary === "stage-mkdir"
                : replaceAt === "directory"
                  ? boundary === "copy-directory-mkdir"
                  : boundary === "copy-file-create" && paths[0]?.endsWith("SKILL.md");
              if (!matches || replacementPath !== "") return;
              replacementPath = replaceAt === "root" ? paths[0]! : paths[0]!;
              await rename(replacementPath, `${replacementPath}.owned-original`);
              if (replaceAt === "file") {
                await writeFile(replacementPath, "", { mode: 0o600 });
              } else {
                await mkdir(replacementPath, { mode: replaceAt === "root" ? 0o700 : 0o750 });
              }
            }
          }
        })).rejects.toMatchObject({
          code: "INTEGRATION_CONFIGURATION_RECOVERY_INCOMPLETE"
        });
      });
      expect(replacementPath).not.toBe("");
      await expect(access(replacementPath)).resolves.toBeUndefined();
      await expect(access(`${replacementPath}.owned-original`)).resolves.toBeUndefined();
    }
  );

  it("classifies EXDEV as a definite cross-filesystem non-move", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const result = await moveOwnedTree(staged.tree, destinationPath, {
        stateDirectory,
        leaseContext,
        hooks: {
          renamePath: async () => {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          }
        }
      });
      expect(result).toMatchObject({
        state: "not-moved",
        cause: { code: "INTEGRATION_CONFIGURATION_INVALID" }
      });
      await expect(access(ownedTreeHandleSnapshot(staged.tree).path)).resolves.toBeUndefined();
    });
  });

  it("preserves a POSIX special entry during cleanup", async () => {
    const { base, source } = await sourceFixture();
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const destinationPath = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(home, { mode: 0o700 });
    const manifest = await inspectCompanionTree(source, {
      boundary: dirname(source),
      platform: "linux"
    });
    await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
      const staged = await createOwnedTreeStage({
        transactionId: TRANSACTION_ID,
        sourcePath: source,
        destinationPath,
        homeBoundaryPath: home,
        expectedManifest: manifest
      }, { stateDirectory, leaseContext });
      const stagePath = ownedTreeHandleSnapshot(staged.tree).path;
      const fifo = join(stagePath, "external.fifo");
      await execFileAsync("mkfifo", [fifo]);
      await expect(cleanupOwnedTree(staged.tree, { stateDirectory, leaseContext }))
        .rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_DRIFT" });
      await expect(access(fifo)).resolves.toBeUndefined();
    });
  });
});
