import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SkillRecord, SkillRoot } from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import { describe, expect, it } from "vitest";
import {
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
  return { base, activePath, stateDirectory, fingerprint, plan };
}

describe("applyQuarantinePlan", () => {
  it("commits a private verified vault before cleaning the adjacent rollback", async () => {
    const current = await fixture("tx-success");
    const result = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
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

  for (const boundary of ["copy", "verify", "move", "vault", "journal"] as const) {
    it(`restores the active Skill when the ${boundary} boundary fails`, async () => {
      const current = await fixture(`tx-${boundary}`);
      const failure = async () => { throw new Error(`injected ${boundary} failure`); };
      await expect(applyQuarantinePlan(current.plan, {
        stateDirectory: current.stateDirectory,
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
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterCopy: () => writeFile(join(current.plan.stagingPath, "changed.md"), "changed")
    })).rejects.toMatchObject({ code: "COPY_VERIFICATION_FAILED" });
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await readGovernanceTransactions(current.stateDirectory)).toEqual([
      expect.objectContaining({ status: "failed", failureBoundary: "verify" })
    ]);
  });

  it("refuses expired, drifted, and reused plans before mutation", async () => {
    const expired = await fixture("tx-expired");
    await expect(applyQuarantinePlan(expired.plan, {
      stateDirectory: expired.stateDirectory,
      now: () => new Date("2026-07-03T00:10:00.001Z")
    })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(await readFile(join(expired.activePath, "SKILL.md"), "utf8")).toContain("review");

    const drifted = await fixture("tx-drifted");
    await writeFile(join(drifted.activePath, "changed.md"), "changed");
    await expect(applyQuarantinePlan(drifted.plan, {
      stateDirectory: drifted.stateDirectory,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    const reused = await fixture("tx-reused");
    await expect(applyQuarantinePlan(reused.plan, {
      stateDirectory: reused.stateDirectory,
      now: () => new Date("2026-07-03T00:01:00.000Z"),
      afterCopy: () => { throw new Error("first use"); }
    })).rejects.toThrow("first use");
    await expect(applyQuarantinePlan(reused.plan, {
      stateDirectory: reused.stateDirectory,
      now: () => new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "PLAN_ALREADY_USED" });
  });
});

describe("applyRestorePlan", () => {
  async function quarantinedFixture(id: string) {
    const current = await fixture(`quarantine-${id}`);
    const quarantine = await applyQuarantinePlan(current.plan, {
      stateDirectory: current.stateDirectory,
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

  it("refuses destination conflict and vault drift without losing either copy", async () => {
    const occupied = await quarantinedFixture("occupied");
    await mkdir(occupied.activePath);
    await writeFile(join(occupied.activePath, "SKILL.md"), "occupied");
    await expect(applyRestorePlan(occupied.restore, {
      stateDirectory: occupied.stateDirectory,
      now: () => new Date("2026-07-03T00:03:00.000Z")
    })).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
    expect(await readFile(join(occupied.activePath, "SKILL.md"), "utf8")).toBe("occupied");
    expect(await fingerprintDirectory(occupied.restore.vaultPath)).toBe(occupied.fingerprint);

    const drifted = await quarantinedFixture("drifted");
    await writeFile(join(drifted.restore.vaultPath, "changed.md"), "changed");
    await expect(applyRestorePlan(drifted.restore, {
      stateDirectory: drifted.stateDirectory,
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
      now: () => new Date("2026-07-03T00:03:00.000Z"),
      cleanupVault: async () => { throw new Error("injected cleanup"); }
    });
    expect(result.cleanupPending).toBe(true);
    expect(await fingerprintDirectory(current.activePath)).toBe(current.fingerprint);
    expect(await fingerprintDirectory(current.restore.vaultPath)).toBe(current.fingerprint);
  });
});
