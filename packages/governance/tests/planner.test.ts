import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SkillRecord, SkillRoot } from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import { describe, expect, it } from "vitest";
import {
  planQuarantine,
  planRestore,
  type QuarantinedSkill
} from "../src/index.js";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-governance-plan-")));
  const activeRoot = join(base, "active");
  const source = join(activeRoot, "review");
  const stateDirectory = join(base, "state");
  await mkdir(source, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\n"
  );
  const fingerprint = await fingerprintDirectory(source);
  const skill: SkillRecord = {
    id: "skill-review",
    name: "review",
    description: "Review changes",
    path: source,
    root: basename(source),
    scope: "global",
    visibleTo: ["codex", "claude", "github-copilot"],
    fingerprint,
    files: [],
    estimatedTokens: 20
  };
  const roots: SkillRoot[] = [{
    path: activeRoot,
    scope: "global",
    visibleTo: ["codex", "claude", "github-copilot"]
  }];
  return { base, activeRoot, source, stateDirectory, skill, roots, fingerprint };
}

describe("governance planner", () => {
  it("creates an exact ten-minute quarantine plan", async () => {
    const current = await fixture();
    const plan = await planQuarantine({
      skill: current.skill,
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id: () => "tx-1",
      now: new Date("2026-07-03T00:00:00.000Z")
    });
    expect(plan).toMatchObject({
      schemaVersion: 1,
      id: "tx-1",
      kind: "quarantine",
      skillId: "skill-review",
      activePath: current.source,
      sourceFingerprint: current.fingerprint,
      vaultPath: join(current.stateDirectory, "quarantine", "tx-1", "review"),
      rollbackPath: join(current.activeRoot, ".review.skill-steward-quarantine-tx-1.rollback"),
      createdAt: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-03T00:10:00.000Z",
      visibleAliases: [
        { harness: "claude", scope: "global", rootPath: current.activeRoot },
        { harness: "codex", scope: "global", rootPath: current.activeRoot },
        { harness: "github-copilot", scope: "global", rootPath: current.activeRoot }
      ]
    });
    expect(plan.operations.map(({ operation }) => operation)).toEqual([
      "copy-to-staging",
      "verify-staging",
      "move-active-to-rollback",
      "commit-vault",
      "append-journal",
      "cleanup-rollback"
    ]);
  });

  it("rejects source links, root escape, fingerprint drift, and destination conflicts", async () => {
    const linked = await fixture();
    const target = join(linked.base, "linked-target");
    await mkdir(target);
    await writeFile(join(target, "SKILL.md"), "linked");
    const sourceLink = join(linked.activeRoot, "linked");
    await symlink(target, sourceLink);
    await expect(planQuarantine({
      skill: { ...linked.skill, path: sourceLink, fingerprint: await fingerprintDirectory(target) },
      activeRoots: linked.roots,
      stateDirectory: linked.stateDirectory
    })).rejects.toMatchObject({ code: "SOURCE_UNSAFE" });

    const escaped = await fixture();
    await expect(planQuarantine({
      skill: escaped.skill,
      activeRoots: [{ path: join(escaped.base, "other"), scope: "global", visibleTo: ["codex"] }],
      stateDirectory: escaped.stateDirectory
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });

    const drifted = await fixture();
    await writeFile(join(drifted.source, "changed.md"), "changed");
    await expect(planQuarantine({
      skill: drifted.skill,
      activeRoots: drifted.roots,
      stateDirectory: drifted.stateDirectory
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    const conflict = await fixture();
    await mkdir(join(conflict.stateDirectory, "quarantine", "tx-conflict", "review"), { recursive: true });
    await expect(planQuarantine({
      skill: conflict.skill,
      activeRoots: conflict.roots,
      stateDirectory: conflict.stateDirectory,
      id: () => "tx-conflict"
    })).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
  });

  it("creates a drift-safe restore plan and rejects occupied or changed state", async () => {
    const current = await fixture();
    const vaultPath = join(current.stateDirectory, "quarantine", "tx-old", "review");
    await mkdir(join(current.stateDirectory, "quarantine", "tx-old"), { recursive: true });
    await (async () => {
      await mkdir(vaultPath);
      await writeFile(join(vaultPath, "SKILL.md"), await readFile(join(current.source, "SKILL.md")));
    })();
    const quarantined: QuarantinedSkill = {
      transactionId: "tx-old",
      skillId: current.skill.id,
      originalPath: join(current.activeRoot, "restored-review"),
      vaultPath,
      fingerprint: await fingerprintDirectory(vaultPath),
      visibleAliases: [{ harness: "codex", scope: "global", rootPath: current.activeRoot }]
    };
    const plan = await planRestore({
      quarantined,
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id: () => "restore-1",
      now: new Date("2026-07-03T01:00:00.000Z")
    });
    expect(plan).toMatchObject({
      kind: "restore",
      id: "restore-1",
      activePath: quarantined.originalPath,
      vaultPath,
      sourceFingerprint: quarantined.fingerprint,
      expectedDestinationFingerprint: null
    });
    expect(plan.operations.map(({ operation }) => operation)).toEqual([
      "copy-to-staging",
      "verify-staging",
      "restore-active",
      "append-journal",
      "cleanup-vault"
    ]);

    await mkdir(quarantined.originalPath);
    await expect(planRestore({
      quarantined,
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory
    })).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
    await writeFile(join(vaultPath, "changed.md"), "changed");
    await expect(planRestore({
      quarantined: { ...quarantined, originalPath: join(current.activeRoot, "other-restored") },
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory
    })).rejects.toMatchObject({ code: "VAULT_DRIFT" });
  });
});
