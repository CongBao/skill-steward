import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SkillRecord, SkillRoot } from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import { describe, expect, it } from "vitest";
import {
  applyQuarantinePlan,
  planQuarantine,
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
