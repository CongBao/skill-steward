import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  HarnessId,
  SkillRecord,
  SkillRecordV2,
  SkillRoot
} from "@skill-steward/engine";
import { fingerprintDirectory } from "@skill-steward/installer";
import { describe, expect, it, vi } from "vitest";
import {
  planQuarantine,
  planRestore,
  type QuarantinedSkill
} from "../src/index.js";

const execFileAsync = promisify(execFile);

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
  it.each([
    ["codex", "codex-plugin-manager"],
    ["claude", "claude-code-plugin-manager"],
    ["github-copilot", "github-copilot-cli-plugin-manager"]
  ] as const)(
    "refuses a %s native plugin Skill before quarantine planning side effects",
    async (harness, lifecycleSurface) => {
      const current = await fixture();
      const sourceId = `native-${harness}`;
      const nativeSkill: SkillRecordV2 = {
        ...current.skill,
        ownership: "native-plugin",
        sourceIds: [sourceId],
        exposures: [{
          harness,
          effectiveName: current.skill.name,
          state: "effective",
          sourceId,
          reason: "NATIVE_PLUGIN_VISIBLE"
        }],
        plugin: {
          harness,
          id: "private-plugin-id",
          version: "private-cache-version"
        }
      };
      const original = await readFile(join(current.source, "SKILL.md"));
      const id = vi.fn(() => "tx-native");

      const error = await planQuarantine({
        skill: nativeSkill,
        activeRoots: current.roots,
        stateDirectory: current.stateDirectory,
        id
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "NATIVE_PLUGIN_MANAGED",
        data: { harness, lifecycleSurface }
      });
      expect(String(error)).not.toContain(current.base);
      expect(String(error)).not.toContain("private-plugin-id");
      expect(String(error)).not.toContain("private-cache-version");
      expect(id).not.toHaveBeenCalled();
      expect(await readFile(join(current.source, "SKILL.md"))).toEqual(original);
      await expect(access(join(
        current.stateDirectory,
        "quarantine",
        "tx-native"
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(
        current.activeRoot,
        ".review.skill-steward-quarantine-tx-native.rollback"
      ))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("refuses a stale native plugin restore before inspecting or creating paths", async () => {
    const current = await fixture();
    const originalPath = join(current.base, "private-native-cache", "review");
    const vaultPath = join(
      current.stateDirectory,
      "quarantine",
      "tx-native-old",
      "review"
    );
    const quarantined = {
      schemaVersion: 2 as const,
      transactionId: "tx-native-old",
      skillId: current.skill.id,
      originalPath,
      vaultPath,
      fingerprint: current.fingerprint,
      visibleAliases: [],
      skillOwnership: {
        ownership: "native-plugin" as const,
        harness: "codex" as HarnessId
      }
    } as QuarantinedSkill & {
      skillOwnership: {
        ownership: "native-plugin";
        harness: HarnessId;
      };
    };
    const id = vi.fn(() => "restore-native");

    const error = await planRestore({
      quarantined,
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "NATIVE_PLUGIN_MANAGED",
      data: {
        harness: "codex",
        lifecycleSurface: "codex-plugin-manager"
      }
    });
    expect(String(error)).not.toContain(current.base);
    expect(id).not.toHaveBeenCalled();
    await expect(access(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a direct v2 instance eligible when native content has the same fingerprint", async () => {
    const current = await fixture();
    const sourceId = "direct-source";
    const directSkill: SkillRecordV2 = {
      ...current.skill,
      ownership: "direct",
      sourceIds: [sourceId],
      exposures: [{
        harness: "codex",
        effectiveName: current.skill.name,
        state: "effective",
        sourceId,
        reason: "DIRECT_SKILL_VISIBLE"
      }]
    };

    const plan = await planQuarantine({
      skill: directSkill,
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id: () => "tx-direct-duplicate"
    });

    expect(plan).toMatchObject({
      schemaVersion: 2,
      id: "tx-direct-duplicate",
      skillId: current.skill.id,
      activePath: current.source,
      skillOwnership: { ownership: "direct" }
    });
  });

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
      schemaVersion: 2,
      id: "tx-1",
      kind: "quarantine",
      skillId: "skill-review",
      skillOwnership: { ownership: "direct" },
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

  it("uses exclusions consistently across multiple reordered alias roots", async () => {
    const current = await fixture();
    const outerRoot: SkillRoot & { excludedPaths: string[] } = {
      path: current.base,
      scope: "global",
      visibleTo: ["agents"],
      excludedPaths: [join(current.base, "unrelated")]
    };
    const excludedInner: SkillRoot & { excludedPaths: string[] } = {
      ...current.roots[0]!,
      excludedPaths: [current.source]
    };
    const forward = await planQuarantine({
      skill: current.skill,
      activeRoots: [excludedInner, outerRoot],
      stateDirectory: current.stateDirectory,
      id: () => "tx-alias-forward"
    });
    const reverse = await planQuarantine({
      skill: current.skill,
      activeRoots: [outerRoot, excludedInner],
      stateDirectory: current.stateDirectory,
      id: () => "tx-alias-reverse"
    });

    expect(forward.visibleAliases).toEqual([{
      harness: "agents",
      scope: "global",
      rootPath: current.base
    }]);
    expect(reverse.visibleAliases).toEqual(forward.visibleAliases);
  });

  it("does not upgrade an excluded legacy direct restore record", async () => {
    const current = await fixture();
    const originalPath = join(current.activeRoot, "excluded-restore");
    const vaultPath = join(current.stateDirectory, "quarantine", "tx-excluded", "review");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(join(vaultPath, "SKILL.md"), await readFile(join(current.source, "SKILL.md")));
    const quarantined: QuarantinedSkill = {
      schemaVersion: 1,
      transactionId: "tx-excluded",
      skillId: current.skill.id,
      originalPath,
      vaultPath,
      fingerprint: await fingerprintDirectory(vaultPath),
      visibleAliases: []
    };

    await expect(planRestore({
      quarantined,
      activeRoots: [{ ...current.roots[0]!, excludedPaths: [originalPath] }],
      stateDirectory: current.stateDirectory,
      id: () => "restore-excluded"
    })).rejects.toMatchObject({ code: "SOURCE_OUTSIDE_ACTIVE_ROOT" });
  });

  it("preserves a scanned Skill display name without introducing a new length limit", async () => {
    const current = await fixture();
    const longName = "review-".repeat(50);
    const plan = await planQuarantine({
      skill: { ...current.skill, name: longName },
      activeRoots: current.roots,
      stateDirectory: current.stateDirectory,
      id: () => "tx-long-name"
    });

    expect(plan.skillName).toBe(longName);
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

  it("rejects nested links and special files before creating a transaction plan", async () => {
    const nestedLink = await fixture();
    const outside = join(nestedLink.base, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(nestedLink.source, "linked.txt"));
    await expect(planQuarantine({
      skill: nestedLink.skill,
      activeRoots: nestedLink.roots,
      stateDirectory: nestedLink.stateDirectory
    })).rejects.toMatchObject({ code: "SOURCE_UNSAFE" });

    if (process.platform !== "win32") {
      const special = await fixture();
      await execFileAsync("mkfifo", [join(special.source, "unsafe.fifo")]);
      await expect(planQuarantine({
        skill: special.skill,
        activeRoots: special.roots,
        stateDirectory: special.stateDirectory
      })).rejects.toMatchObject({ code: "SOURCE_UNSAFE" });
    }
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
      schemaVersion: 1,
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
      schemaVersion: 2,
      kind: "restore",
      id: "restore-1",
      activePath: quarantined.originalPath,
      vaultPath,
      sourceFingerprint: quarantined.fingerprint,
      expectedDestinationFingerprint: null,
      skillOwnership: { ownership: "direct" }
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
