import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SkillRecord, SkillRoot } from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import { describe, expect, it } from "vitest";
import {
  appendGovernanceTransaction,
  applyQuarantinePlan,
  applyRestorePlan,
  planQuarantine,
  planRestore,
  quarantinedSkillFromTransaction,
  readGovernanceTransactions
} from "../src/index.js";

async function fixture(id: string) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-governance-transaction-")));
  const activeRoot = join(base, "active");
  const activePath = join(activeRoot, "review");
  const stateDirectory = join(base, "state");
  await mkdir(activePath, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(activePath, "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\n"
  );
  await writeFile(join(activePath, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const fingerprint = await fingerprintDirectory(activePath);
  const skill: SkillRecord = {
    id: "skill-review",
    name: "review",
    description: "Review changes",
    path: activePath,
    root: basename(activePath),
    scope: "global",
    visibleTo: ["codex"],
    fingerprint,
    files: [],
    estimatedTokens: 20
  };
  const roots: SkillRoot[] = [{
    path: activeRoot,
    scope: "global",
    visibleTo: ["codex"]
  }];
  const plan = await planQuarantine({
    skill,
    activeRoots: roots,
    stateDirectory,
    id: () => id,
    now: new Date("2026-07-03T00:00:00.000Z")
  });
  return { base, activePath, stateDirectory, fingerprint, plan, roots };
}

describe("applyQuarantinePlan", () => {
  it("rejects an unsafe journal before consuming the plan or mutating the Skill", async () => {
    const current = await fixture("tx-unsafe-journal-preflight");
    const outside = join(current.base, "outside-journal");
    const original = Buffer.from("outside\n");
    await writeFile(outside, original, { mode: 0o640 });
    const journalPath = join(current.stateDirectory, "governance.jsonl");
    await symlink(outside, journalPath);

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    await expect(access(current.activePath)).resolves.toBeUndefined();
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside)).toEqual(original);
    expect((await stat(outside)).mode & 0o777).toBe(0o640);

    await unlink(journalPath);
    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toMatchObject({ transaction: { status: "quarantined" } });
  });

  it("rejects an append-time journal replacement and safely recovers", async () => {
    const current = await fixture("tx-journal-append-race");
    const outside = join(current.base, "outside-append-race");
    const original = Buffer.from("outside-race\n");
    await writeFile(outside, original, { mode: 0o640 });

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterVault: async () => {
        await symlink(outside, join(current.stateDirectory, "governance.jsonl"));
      }
    })).rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    await expect(access(current.activePath)).resolves.toBeUndefined();
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside)).toEqual(original);
    expect((await stat(outside)).mode & 0o777).toBe(0o640);
  });

  it.each([
    ["proof removed", "PLAN_INVALID"],
    ["schema downgraded", "PLAN_REVIEW_REQUIRED"]
  ] as const)("rejects a reviewed quarantine plan with %s", async (variant, code) => {
    const current = await fixture(`tx-${variant.replace(" ", "-")}`);
    const tampered = { ...current.plan } as Record<string, unknown>;
    if (variant === "proof removed") {
      delete tampered.skillOwnership;
    } else {
      tampered.schemaVersion = 1;
      delete tampered.skillOwnership;
    }

    await expect(applyQuarantinePlan(tampered as typeof current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code });

    await expect(access(current.activePath)).resolves.toBeUndefined();
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("rejects a direct plan retargeted into an excluded nested native cache", async () => {
    const current = await fixture("tx-retarget-native");
    const nativeCache = join(dirname(current.activePath), "native-cache");
    const nativePath = join(nativeCache, basename(current.activePath));
    await mkdir(nativePath, { recursive: true });
    await writeFile(
      join(nativePath, "SKILL.md"),
      await readFile(join(current.activePath, "SKILL.md"))
    );
    await writeFile(join(nativePath, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await fingerprintDirectory(nativePath)).toBe(current.fingerprint);
    const rollbackPath = join(
      nativeCache,
      `.${basename(nativePath)}.skill-steward-quarantine-${current.plan.id}.rollback`
    );
    const malicious = {
      ...current.plan,
      activePath: nativePath,
      rollbackPath,
      skillOwnership: { ownership: "direct" as const },
      operations: [
        { operation: "copy-to-staging" as const, from: nativePath, to: current.plan.stagingPath },
        {
          operation: "verify-staging" as const,
          path: current.plan.stagingPath,
          fingerprint: current.fingerprint
        },
        { operation: "move-active-to-rollback" as const, from: nativePath, to: rollbackPath },
        {
          operation: "commit-vault" as const,
          from: current.plan.stagingPath,
          to: current.plan.vaultPath
        },
        { operation: "append-journal" as const, transactionId: current.plan.id },
        { operation: "cleanup-rollback" as const, path: rollbackPath }
      ]
    };
    const directBefore = await readFile(join(current.activePath, "SKILL.md"));
    const nativeBefore = await readFile(join(nativePath, "SKILL.md"));

    await expect(applyQuarantinePlan(malicious, {
      stateDirectory: current.stateDirectory,
      activeRoots: [{ ...current.roots[0]!, excludedPaths: [nativeCache] }],
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });

    expect(await readFile(join(current.activePath, "SKILL.md"))).toEqual(directBefore);
    expect(await readFile(join(nativePath, "SKILL.md"))).toEqual(nativeBefore);
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("rejects authority supplied through a symbolic-link root alias", async () => {
    const current = await fixture("tx-aliased-root");
    const aliasedRoot = join(current.base, "active-alias");
    await symlink(current.roots[0]!.path, aliasedRoot, "dir");
    const original = await readFile(join(current.activePath, "SKILL.md"));

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: [{ ...current.roots[0]!, path: aliasedRoot }],
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });

    expect(await readFile(join(current.activePath, "SKILL.md"))).toEqual(original);
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("refuses a persisted native quarantine plan before filesystem or journal mutation", async () => {
    const current = await fixture("tx-native-persisted");
    const original = await readFile(join(current.activePath, "SKILL.md"));
    const malicious = {
      ...current.plan,
      skillOwnership: { ownership: "native-plugin" as const, harness: "codex" as const }
    };

    await expect(applyQuarantinePlan(malicious, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "NATIVE_PLUGIN_MANAGED" });

    expect(await readFile(join(current.activePath, "SKILL.md"))).toEqual(original);
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(current.plan.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("commits a private verified vault before cleaning the adjacent rollback", async () => {
    const current = await fixture("tx-success");
    const result = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    });

    expect(result).toMatchObject({
      rescanRequired: true,
      transaction: {
        id: "tx-success",
        action: "quarantine",
        status: "quarantined",
        skillId: "skill-review",
        originalPath: current.activePath,
        vaultPath: current.plan.vaultPath,
        fingerprint: current.fingerprint
      }
    });
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fingerprintDirectory(current.plan.vaultPath)).toBe(current.fingerprint);
    await expect(access(current.plan.rollbackPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(current.stateDirectory, "quarantine", "tx-success"))).mode & 0o777)
      .toBe(0o700);
    expect((await stat(join(current.stateDirectory, "governance.jsonl"))).mode & 0o777)
      .toBe(0o600);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ id: "tx-success", status: "quarantined" })
    ]);
  });

  it("returns a committed quarantine when an append wrapper throws after sync", async () => {
    const current = await fixture("tx-post-sync-wrapper-failure");

    const result = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      appendRecord: async (...args) => {
        await appendGovernanceTransaction(...args);
        throw new Error("injected quarantine post-sync failure");
      }
    });

    expect(result).toMatchObject({
      cleanupPending: true,
      transaction: { action: "quarantine", status: "quarantined" }
    });
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fingerprintDirectory(current.plan.vaultPath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.plan.rollbackPath!)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ action: "quarantine", status: "quarantined" })
    ]);
  });

  for (const boundary of ["copy", "verify", "move", "vault", "journal"] as const) {
    it(`restores the active Skill when the ${boundary} boundary fails`, async () => {
      const current = await fixture(`tx-${boundary}`);
      const failure = async () => { throw new Error(`injected ${boundary} failure`); };
      await expect(applyQuarantinePlan(current.plan, {
        stateDirectory: current.stateDirectory,
        activeRoots: current.roots,
        now: () => new Date("2026-07-03T00:01:00.000Z"),
        ...(boundary === "copy" ? { afterCopy: failure } : {}),
        ...(boundary === "verify" ? { afterVerify: failure } : {}),
        ...(boundary === "move" ? { afterMove: failure } : {}),
        ...(boundary === "vault" ? { afterVault: failure } : {}),
        ...(boundary === "journal" ? { appendRecord: failure } : {})
      })).rejects.toThrow(`injected ${boundary} failure`);

      expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
      await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(current.plan.rollbackPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
        expect.objectContaining({
          id: `tx-${boundary}`,
          action: "quarantine",
          status: "failed"
        })
      ]);
    });
  }

  it("records a failed verification without removing the active Skill", async () => {
    const current = await fixture("tx-verify-mismatch");
    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterCopy: () => writeFile(join(current.plan.stagingPath, "changed.md"), "changed")
    })).rejects.toMatchObject({ code: "COPY_VERIFICATION_FAILED" });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ status: "failed", failureBoundary: "verify" })
    ]);
  });

  it("preserves an after-verify source replacement and the parked reviewed source", async () => {
    const current = await fixture("tx-source-identity-swap");
    const parkedReviewed = join(current.base, "parked-reviewed-source");

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterVerify: async () => {
        await rename(current.activePath, parkedReviewed);
        await cp(parkedReviewed, current.activePath, { recursive: true });
        await writeFile(join(current.activePath, "replacement.txt"), "replacement");
      }
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    await expect(readFile(join(current.activePath, "replacement.txt"), "utf8"))
      .resolves.toBe("replacement");
    expect(await fingerprintDirectory(parkedReviewed)).toBe(current.fingerprint);
    await expect(access(current.plan.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("does not clean an identity-mismatched rollback after commit", async () => {
    const current = await fixture("tx-rollback-cleanup-swap");
    const parkedReviewed = join(current.base, "parked-rollback-source");
    const result = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterVault: async () => {
        await rename(current.plan.rollbackPath!, parkedReviewed);
        await cp(parkedReviewed, current.plan.rollbackPath!, { recursive: true });
      }
    });

    expect(result.cleanupPending).toBe(true);
    expect(await fingerprintDirectory(parkedReviewed)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.plan.rollbackPath!)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.plan.vaultPath)).toBe(current.fingerprint);
  });

  it("rejects a same-inode vault edit after the vault hook without deleting either copy", async () => {
    const current = await fixture("tx-vault-content-drift");

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterVault: async () => {
        await writeFile(join(current.plan.vaultPath, "late.txt"), "late change");
      }
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    await expect(readFile(join(current.plan.vaultPath, "late.txt"), "utf8"))
      .resolves.toBe("late change");
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("rejects a replaced state directory after vault commit and preserves parked state", async () => {
    const current = await fixture("tx-state-directory-swap");
    const parkedState = join(current.base, "parked-state");
    const parkedVault = join(
      parkedState,
      "quarantine",
      current.plan.id,
      basename(current.plan.vaultPath)
    );

    await expect(applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterVault: async () => {
        await rename(current.stateDirectory, parkedState);
        await mkdir(current.stateDirectory);
      }
    })).rejects.toMatchObject({ code: "UNSAFE_DESTINATION" });

    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(parkedVault)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
    expect(await readGovernanceTransactions(parkedState)).toEqual([]);
  });

  it("refuses expired, drifted, and reused plans before mutation", async () => {
    const expired = await fixture("tx-expired");
    await expect(applyQuarantinePlan(expired.plan, {
      stateDirectory: expired.stateDirectory,
      activeRoots: expired.roots,
      now: () => new Date("2026-07-03T00:10:00.001Z")
    })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(await readFile(join(expired.activePath, "SKILL.md"), "utf8")).toContain("review");

    const drifted = await fixture("tx-drifted");
    await writeFile(join(drifted.activePath, "changed.md"), "changed");
    await expect(applyQuarantinePlan(drifted.plan, {
      stateDirectory: drifted.stateDirectory,
      activeRoots: drifted.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    const reused = await fixture("tx-reused");
    await expect(applyQuarantinePlan(reused.plan, {
      stateDirectory: reused.stateDirectory,
      activeRoots: reused.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterCopy: () => { throw new Error("first use"); }
    })).rejects.toThrow("first use");
    await expect(applyQuarantinePlan(reused.plan, {
      stateDirectory: reused.stateDirectory,
      activeRoots: reused.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "PLAN_ALREADY_USED" });
  });
});

describe("applyRestorePlan", () => {
  async function quarantinedFixture(id: string) {
    const current = await fixture(`quarantine-${id}`);
    const quarantine = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    });
    const roots: SkillRoot[] = [{
      path: dirname(current.activePath),
      scope: "global",
      visibleTo: ["codex"]
    }];
    const restore = await planRestore({
      quarantined: quarantinedSkillFromTransaction(quarantine.transaction),
      activeRoots: roots,
      stateDirectory: current.stateDirectory,
      id: () => `restore-${id}`,
      now: new Date("2026-07-03T00:02:00.000Z")
    });
    return { ...current, roots, quarantine, restore };
  }

  it("round-trips a quarantine to the original fingerprint", async () => {
    const current = await quarantinedFixture("success");
    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    });
    expect(result).toMatchObject({
      rescanRequired: true,
      cleanupPending: false,
      transaction: {
        id: "restore-success",
        action: "restore",
        status: "restored",
        sourceTransactionId: "quarantine-success"
      }
    });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    await expect(access(current.restore.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readGovernanceTransactions(current.stateDirectory)).map(({ status }) => status))
      .toEqual(["restored", "quarantined"]);
  });

  it("upgrades a legacy v1 direct journal into an authority-bound v2 restore", async () => {
    const current = await fixture("legacy-direct-source");
    const transactionId = "legacy-direct-quarantine";
    const vaultPath = join(
      current.stateDirectory,
      "quarantine",
      transactionId,
      basename(current.activePath)
    );
    await mkdir(vaultPath, { recursive: true });
    await writeFile(
      join(vaultPath, "SKILL.md"),
      await readFile(join(current.activePath, "SKILL.md"))
    );
    await writeFile(join(vaultPath, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await rm(current.activePath, { recursive: true });
    await writeFile(join(current.stateDirectory, "governance.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      id: transactionId,
      action: "quarantine",
      status: "quarantined",
      skillId: "skill-review",
      skillName: "review",
      originalPath: current.activePath,
      vaultPath,
      fingerprint: current.fingerprint,
      visibleAliases: [{
        harness: "codex",
        scope: "global",
        rootPath: dirname(current.activePath)
      }],
      createdAt: "2026-07-03T00:01:00.000Z"
    })}\n`);
    const [legacy] = await readGovernanceTransactions(current.stateDirectory);
    if (!legacy) throw new Error("legacy transaction missing");

    const restore = await planRestore({
      quarantined: quarantinedSkillFromTransaction(legacy),
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id: () => "restore-legacy-direct",
      now: new Date("2026-07-03T00:02:00.000Z")
    });
    expect(restore).toMatchObject({
      schemaVersion: 2,
      skillOwnership: { ownership: "direct" }
    });

    await expect(applyRestorePlan(restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).resolves.toMatchObject({ transaction: { schemaVersion: 2, status: "restored" } });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
  });

  it("rejects a native restore journal and plan downgraded to v1", async () => {
    const current = await fixture("legacy-native-source");
    const transactionId = "downgraded-native-quarantine";
    const vaultPath = join(
      current.stateDirectory,
      "quarantine",
      transactionId,
      basename(current.activePath)
    );
    await mkdir(vaultPath, { recursive: true });
    await writeFile(
      join(vaultPath, "SKILL.md"),
      await readFile(join(current.activePath, "SKILL.md"))
    );
    await writeFile(join(vaultPath, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await rm(current.activePath, { recursive: true });
    const nativeParent = join(current.base, "native-cache");
    const nativePath = join(nativeParent, basename(current.activePath));
    await mkdir(nativeParent);
    const legacyTransaction = {
      schemaVersion: 1,
      id: transactionId,
      action: "quarantine",
      status: "quarantined",
      skillId: "skill-review",
      skillName: "review",
      originalPath: nativePath,
      vaultPath,
      fingerprint: current.fingerprint,
      visibleAliases: [],
      createdAt: "2026-07-03T00:01:00.000Z"
    };
    const journalPath = join(current.stateDirectory, "governance.jsonl");
    await writeFile(journalPath, `${JSON.stringify(legacyTransaction)}\n`);
    const journalBefore = await readFile(journalPath);
    const id = "restore-downgraded-native";
    const stagingPath = join(nativeParent, `.${basename(nativePath)}.skill-steward-restore-${id}.tmp`);
    const malicious = {
      schemaVersion: 1 as const,
      id,
      kind: "restore" as const,
      sourceTransactionId: transactionId,
      skillId: "skill-review",
      skillName: "review",
      activePath: nativePath,
      vaultPath,
      stagingPath,
      sourceFingerprint: current.fingerprint,
      expectedDestinationFingerprint: null,
      visibleAliases: [],
      operations: [
        { operation: "copy-to-staging" as const, from: vaultPath, to: stagingPath },
        {
          operation: "verify-staging" as const,
          path: stagingPath,
          fingerprint: current.fingerprint
        },
        { operation: "restore-active" as const, from: stagingPath, to: nativePath },
        { operation: "append-journal" as const, transactionId: id },
        { operation: "cleanup-vault" as const, path: vaultPath }
      ],
      createdAt: "2026-07-03T00:02:00.000Z",
      expiresAt: "2026-07-03T00:12:00.000Z"
    };

    await expect(applyRestorePlan(malicious, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });

    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fingerprintDirectory(vaultPath)).toBe(current.fingerprint);
    expect(await readFile(journalPath)).toEqual(journalBefore);
  });

  it("rejects a v2 journal when its required ownership proof is removed", async () => {
    const current = await fixture("removed-v2-journal-proof");
    const journalPath = join(current.stateDirectory, "governance.jsonl");
    await writeFile(journalPath, `${JSON.stringify({
      schemaVersion: 2,
      id: "removed-v2-journal-proof",
      action: "quarantine",
      status: "quarantined",
      skillId: "skill-review",
      originalPath: current.activePath,
      vaultPath: join(current.stateDirectory, "quarantine", "removed", "review"),
      fingerprint: current.fingerprint,
      visibleAliases: [],
      createdAt: "2026-07-03T00:01:00.000Z"
    })}\n`);

    await expect(readGovernanceTransactions(current.stateDirectory)).rejects.toThrow();
    await expect(access(current.activePath)).resolves.toBeUndefined();
    await expect(access(join(current.stateDirectory, "quarantine")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a v2 native journal whose ownership was changed to direct", async () => {
    const current = await fixture("changed-v2-native-proof");
    const transactionId = "changed-v2-native-proof";
    const nativeParent = join(current.base, "native-cache-v2");
    const nativePath = join(nativeParent, basename(current.activePath));
    await mkdir(nativeParent);
    const vaultPath = join(
      current.stateDirectory,
      "quarantine",
      transactionId,
      basename(nativePath)
    );
    const transaction = {
      schemaVersion: 2,
      id: transactionId,
      action: "quarantine",
      status: "quarantined",
      skillId: "skill-review",
      originalPath: nativePath,
      vaultPath,
      fingerprint: current.fingerprint,
      visibleAliases: [],
      skillOwnership: { ownership: "direct" },
      createdAt: "2026-07-03T00:01:00.000Z"
    };
    const journalPath = join(current.stateDirectory, "governance.jsonl");
    await writeFile(journalPath, `${JSON.stringify(transaction)}\n`);
    const journalBefore = await readFile(journalPath);
    const id = "restore-changed-v2-native-proof";
    const stagingPath = join(nativeParent, `.${basename(nativePath)}.skill-steward-restore-${id}.tmp`);
    const malicious = {
      schemaVersion: 2 as const,
      id,
      kind: "restore" as const,
      sourceTransactionId: transactionId,
      skillId: "skill-review",
      skillOwnership: { ownership: "direct" as const },
      activePath: nativePath,
      vaultPath,
      stagingPath,
      sourceFingerprint: current.fingerprint,
      expectedDestinationFingerprint: null,
      visibleAliases: [],
      operations: [
        { operation: "copy-to-staging" as const, from: vaultPath, to: stagingPath },
        {
          operation: "verify-staging" as const,
          path: stagingPath,
          fingerprint: current.fingerprint
        },
        { operation: "restore-active" as const, from: stagingPath, to: nativePath },
        { operation: "append-journal" as const, transactionId: id },
        { operation: "cleanup-vault" as const, path: vaultPath }
      ],
      createdAt: "2026-07-03T00:02:00.000Z",
      expiresAt: "2026-07-03T00:12:00.000Z"
    };

    await expect(applyRestorePlan(malicious, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });

    await expect(access(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(journalPath)).toEqual(journalBefore);
    await expect(access(current.activePath)).resolves.toBeUndefined();
  });

  it("refuses a stale persisted native restore plan before filesystem or journal mutation", async () => {
    const current = await quarantinedFixture("native-persisted");
    const malicious = {
      ...current.restore,
      skillOwnership: { ownership: "native-plugin" as const, harness: "codex" as const }
    };
    const vaultBefore = await readFile(join(current.restore.vaultPath, "SKILL.md"));
    const journalBefore = await readFile(join(current.stateDirectory, "governance.jsonl"));

    await expect(applyRestorePlan(malicious, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "NATIVE_PLUGIN_MANAGED" });

    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(current.restore.vaultPath, "SKILL.md"))).toEqual(vaultBefore);
    await expect(access(current.restore.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(current.stateDirectory, "governance.jsonl"))).toEqual(journalBefore);
  });

  it("refuses destination conflict and vault drift without losing either copy", async () => {
    const occupied = await quarantinedFixture("occupied");
    await mkdir(occupied.activePath);
    await writeFile(join(occupied.activePath, "SKILL.md"), "occupied");
    await expect(applyRestorePlan(occupied.restore, {
      stateDirectory: occupied.stateDirectory,
      activeRoots: occupied.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
    expect(await readFile(join(occupied.activePath, "SKILL.md"), "utf8")).toBe("occupied");
    expect(await fingerprintDirectory(occupied.restore.vaultPath)).toBe(occupied.fingerprint);

    const drifted = await quarantinedFixture("drifted");
    await writeFile(join(drifted.restore.vaultPath, "changed.md"), "changed");
    await expect(applyRestorePlan(drifted.restore, {
      stateDirectory: drifted.stateDirectory,
      activeRoots: drifted.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "VAULT_DRIFT" });
    await expect(access(drifted.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(drifted.restore.vaultPath, "changed.md"))).resolves.toBeUndefined();
  });

  for (const boundary of ["copy", "verify", "restore", "journal"] as const) {
    it(`preserves the verified vault when restore ${boundary} fails`, async () => {
      const current = await quarantinedFixture(boundary);
      const failure = async () => { throw new Error(`injected restore ${boundary}`); };
      await expect(applyRestorePlan(current.restore, {
        stateDirectory: current.stateDirectory,
        activeRoots: current.roots,
        now: () => new Date("2026-07-03T00:03:00.000Z"),
        ...(boundary === "copy" ? { afterCopy: failure } : {}),
        ...(boundary === "verify" ? { afterVerify: failure } : {}),
        ...(boundary === "restore" ? { afterRestore: failure } : {}),
        ...(boundary === "journal" ? { appendRecord: failure } : {})
      })).rejects.toThrow(`injected restore ${boundary}`);
      await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
      await expect(access(current.restore.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
        expect.objectContaining({ action: "restore", status: "failed" }),
        expect.objectContaining({ action: "quarantine", status: "quarantined" })
      ]);
    });
  }

  it("keeps both verified copies when post-commit vault cleanup fails", async () => {
    const current = await quarantinedFixture("cleanup");
    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      cleanupVault: async () => { throw new Error("injected cleanup"); }
    });
    expect(result.cleanupPending).toBe(true);
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
  });

  it("does not clean an identity-mismatched vault with identical content", async () => {
    const current = await quarantinedFixture("vault-cleanup-swap");
    const parkedVault = join(current.base, "parked-reviewed-vault");
    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      afterVerify: async () => {
        await rename(current.restore.vaultPath, parkedVault);
        await cp(parkedVault, current.restore.vaultPath, { recursive: true });
      }
    });

    expect(result.cleanupPending).toBe(true);
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(parkedVault)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
  });

  it("does not delegate cleanup of an identity-mismatched vault", async () => {
    const current = await quarantinedFixture("vault-custom-cleanup-swap");
    const parkedVault = join(current.base, "parked-custom-cleanup-vault");
    let cleanupCalled = false;

    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      afterVerify: async () => {
        await rename(current.restore.vaultPath, parkedVault);
        await cp(parkedVault, current.restore.vaultPath, { recursive: true });
      },
      cleanupVault: async () => { cleanupCalled = true; }
    });

    expect(result.cleanupPending).toBe(true);
    expect(cleanupCalled).toBe(false);
    expect(await fingerprintDirectory(parkedVault)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
  });

  it("rejects an active identity replacement before restore journal commit", async () => {
    const current = await quarantinedFixture("restore-active-swap");
    const parkedRestored = join(current.base, "parked-restored-copy");
    let appendCalled = false;

    await expect(applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      afterRestore: async () => {
        await rename(current.activePath, parkedRestored);
        await mkdir(current.activePath);
        await writeFile(join(current.activePath, "replacement.txt"), "replacement");
      },
      appendRecord: async () => {
        appendCalled = true;
        throw new Error("Append must not run after active identity drift");
      }
    })).rejects.toMatchObject({ code: "VAULT_DRIFT" });

    expect(appendCalled).toBe(false);
    await expect(readFile(join(current.activePath, "replacement.txt"), "utf8"))
      .resolves.toBe("replacement");
    expect(await fingerprintDirectory(parkedRestored)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ action: "quarantine", status: "quarantined" })
    ]);
  });

  it("rejects same-inode active edits before restore journal commit", async () => {
    const current = await quarantinedFixture("restore-active-content-drift");

    await expect(applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      afterRestore: async () => {
        await writeFile(join(current.activePath, "late.txt"), "concurrent edit");
      }
    })).rejects.toMatchObject({ code: "TRANSACTION_RECOVERY_FAILED" });

    await expect(readFile(join(current.activePath, "late.txt"), "utf8"))
      .resolves.toBe("concurrent edit");
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ action: "quarantine", status: "quarantined" })
    ]);
  });

  it("returns a committed cleanup-pending restore after post-journal active drift", async () => {
    const current = await quarantinedFixture("restore-post-journal-active-drift");

    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      appendRecord: async (stateDirectory, transaction, access) => {
        const receipt = await appendGovernanceTransaction(stateDirectory, transaction, access);
        await writeFile(join(current.activePath, "late.txt"), "post-commit edit");
        return receipt;
      }
    });

    expect(result).toMatchObject({
      cleanupPending: true,
      transaction: { action: "restore", status: "restored" }
    });
    await expect(readFile(join(current.activePath, "late.txt"), "utf8"))
      .resolves.toBe("post-commit edit");
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
    expect((await readGovernanceTransactions(current.stateDirectory)).map(({ status }) => status))
      .toEqual(["restored", "quarantined"]);
  });

  it("returns a committed cleanup-pending restore after post-journal state drift", async () => {
    const current = await quarantinedFixture("restore-post-journal-state-drift");
    const parkedState = join(current.base, "parked-post-journal-state");
    const parkedVault = join(
      parkedState,
      "quarantine",
      current.restore.sourceTransactionId!,
      basename(current.restore.vaultPath)
    );

    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      appendRecord: async (stateDirectory, transaction, access) => {
        const receipt = await appendGovernanceTransaction(stateDirectory, transaction, access);
        await rename(current.stateDirectory, parkedState);
        await mkdir(current.stateDirectory);
        return receipt;
      }
    });

    expect(result).toMatchObject({
      cleanupPending: true,
      transaction: { action: "restore", status: "restored" }
    });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(parkedVault)).toBe(current.fingerprint);
    expect((await readGovernanceTransactions(parkedState)).map(({ status }) => status))
      .toEqual(["restored", "quarantined"]);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([]);
  });

  it("returns a committed restore when an append wrapper throws after sync", async () => {
    const current = await quarantinedFixture("restore-post-sync-wrapper-failure");

    const result = await applyRestorePlan(current.restore, {
      stateDirectory: current.stateDirectory,
      activeRoots: current.roots,
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      appendRecord: async (...args) => {
        await appendGovernanceTransaction(...args);
        throw new Error("injected restore post-sync failure");
      }
    });

    expect(result).toMatchObject({
      cleanupPending: true,
      transaction: { action: "restore", status: "restored" }
    });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
    expect((await readGovernanceTransactions(current.stateDirectory)).map(({ status }) => status))
      .toEqual(["restored", "quarantined"]);
  });
});
