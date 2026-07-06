import { access, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyIntegrationPlan,
  planIntegration
} from "../src/integration-lifecycle.js";
import { inspectCompanionTree } from "../src/companion-manifest.js";
import { loadOwnedTreeNativeRenameBinding } from "../src/companion-owned-tree-native.js";

describe.skipIf(process.platform !== "win32")("native Windows integration safety", () => {
  it("derives only Win32 security modes from real nonzero identities", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-win32-manifest-"));
    const root = join(home, "skill");
    await mkdir(join(root, "references"), { recursive: true });
    await writeFile(join(root, "SKILL.md"), "skill\n");
    await writeFile(join(root, "references", "guide.md"), "guide\n");

    const manifest = await inspectCompanionTree(root, {
      boundary: home,
      platform: "win32",
      isReparsePoint: async () => false
    });
    expect(manifest.platform).toBe("win32");
    expect(manifest.entries.every(({ securityMode }) =>
      securityMode === "win32:writable" || securityMode === "win32:readonly"
    )).toBe(true);
    expect(manifest.entries.some(({ securityMode }) => securityMode.startsWith("posix:")))
      .toBe(false);
    expect((await stat(root, { bigint: true })).ino).not.toBe(0n);
  });

  it("keeps production source inspection reviewable and non-mutating", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-win32-plan-"));
    const source = join(home, "package", "skill-steward-preflight");
    const stateDirectory = join(home, "state");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "packaged\n");
    const plan = await planIntegration("codex", {
      home,
      stateDirectory,
      companionSourceDirectory: source,
      id: () => "native-windows-plan"
    });
    expect(plan).toMatchObject({
      action: "blocked",
      status: "unknown",
      availability: {
        state: "unavailable",
        available: false,
        reason: "COMPANION_SOURCE_UNPROVABLE"
      }
    });
    const generateReadiness = vi.fn();
    await expect(applyIntegrationPlan(plan.planId, {
      home,
      stateDirectory,
      companionSourceDirectory: source,
      expectedHarness: "codex",
      generateReadiness
    })).rejects.toMatchObject({ code: "INTEGRATION_COMPANION_ACTION_UNAVAILABLE" });
    expect(generateReadiness).not.toHaveBeenCalled();
    await expect(access(plan.targets.hook)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(plan.targets.companion)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim an unimplemented Win32 mutation helper", () => {
    const requirePackage = vi.fn();
    expect(() => loadOwnedTreeNativeRenameBinding({
      platform: "win32",
      arch: process.arch,
      libc: "none",
      runtimePlatform: "win32",
      runtimeArch: process.arch,
      releaseVersion: "0.5.0-beta.1",
      requirePackage,
      requirePackageManifest: () => ({
        name: "unused",
        version: "0.5.0-beta.1"
      })
    })).toThrow(expect.objectContaining({ code: "INTEGRATION_CONFIGURATION_INVALID" }));
    expect(requirePackage).not.toHaveBeenCalled();
  });
});
