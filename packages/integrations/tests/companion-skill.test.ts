import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  companionSkillDirectory,
  inspectCompanionSkill,
  type InspectCompanionSkillInput
} from "../src/companion-skill.js";
import { inspectCompanionSkillWithProof } from "../src/companion-inspector-internal.js";

describe("packaged preflight companion Skill", () => {
  it("requests compact output and supplies the current Harness ID when known", async () => {
    const source = await readFile(new URL(
      "../assets/skill-steward-preflight/SKILL.md",
      import.meta.url
    ), "utf8");

    expect(source).toContain("skill-steward preflight --stdin --compact-json");
    expect(source).not.toContain("skill-steward preflight --stdin --json");
    expect(source).toContain("--harness");
    expect(source).toContain("codex");
    expect(source).toContain("claude");
    expect(source).toContain("github-copilot");
    expect(source).toMatch(/`use` array/u);
    expect(source).toMatch(/`install` array/u);
    expect(source).not.toMatch(/candidate whose decision|decision is `use`|decision is `install`/u);
    expect(source).toContain("never install them automatically");
    expect(source).toContain("Do not refresh catalogs unless the user approves");
  });
});

async function companionFixture() {
  const home = await mkdtemp(join(tmpdir(), "steward-companion-status-"));
  const sourceDirectory = join(home, "package", "skill-steward-preflight");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "packaged\n", "utf8");
  return { home, sourceDirectory, destination: companionSkillDirectory(home) };
}

describe("inspectCompanionSkill", () => {
  it("returns missing/create with a complete proof-bound subplan", async () => {
    const fixture = await companionFixture();
    const result = await inspectCompanionSkill(fixture);

    expect(result).toMatchObject({
      status: "missing",
      reason: "COMPANION_MISSING",
      subplan: {
        action: "create",
        path: fixture.destination,
        expectedBefore: { state: "absent" },
        source: { path: fixture.sourceDirectory },
        proof: { kind: "new" }
      }
    });
  });

  it("does not infer ownership from exact package equality", async () => {
    const fixture = await companionFixture();
    await mkdir(dirname(fixture.destination), { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });

    const result = await inspectCompanionSkill(fixture);
    expect(result).toMatchObject({
      status: "conflict",
      reason: "COMPANION_UNMANAGED_TREE",
      subplan: { action: "conflict", proof: { kind: "conflict" } }
    });
  });

  it("returns current/none only with exact recorded ownership proof", async () => {
    const fixture = await companionFixture();
    await mkdir(dirname(fixture.destination), { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });
    const unowned = await inspectCompanionSkill(fixture);
    if (unowned.subplan.expectedBefore.state !== "exact") {
      throw new Error("expected exact readable tree");
    }

    const result = await inspectCompanionSkillWithProof({
      ...fixture,
      managedProof: {
        kind: "recorded",
        recordId: "record-current",
        installedFingerprint: unowned.subplan.expectedBefore.fingerprint
      }
    });
    expect(result).toMatchObject({
      status: "current",
      reason: "COMPANION_CURRENT",
      subplan: { action: "none", proof: { kind: "recorded" } }
    });
  });

  it("does not treat a readable old tree as safely upgradeable without record proof", async () => {
    const fixture = await companionFixture();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, "SKILL.md"), "old or user modified\n", "utf8");

    const result = await inspectCompanionSkill(fixture);
    expect(result).toMatchObject({
      status: "conflict",
      reason: "COMPANION_UNMANAGED_TREE",
      subplan: {
        action: "conflict",
        expectedBefore: { state: "exact" },
        proof: { kind: "conflict", reason: "COMPANION_UNMANAGED_TREE" }
      }
    });
  });

  it("returns upgrade-available only when recorded proof matches the live old tree", async () => {
    const fixture = await companionFixture();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, "SKILL.md"), "recorded old\n", "utf8");
    const old = await inspectCompanionSkill(fixture);
    if (old.subplan.expectedBefore.state !== "exact") {
      throw new Error("expected exact readable old tree");
    }

    const result = await inspectCompanionSkillWithProof({
      ...fixture,
      managedProof: {
        kind: "recorded",
        recordId: "record-1",
        installedFingerprint: old.subplan.expectedBefore.fingerprint
      }
    });
    expect(result).toMatchObject({
      status: "upgrade-available",
      reason: "COMPANION_UPGRADE_AVAILABLE",
      subplan: { action: "upgrade", proof: { kind: "recorded", recordId: "record-1" } }
    });
  });

  it("maps destination I/O and traversal bounds to unknown without weakening the plan", async () => {
    const fixture = await companionFixture();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, "SKILL.md"), "current?\n", "utf8");

    const denied = await inspectCompanionSkillWithProof(fixture, {
      destination: {
        openDirectory: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      }
    });
    expect(denied).toMatchObject({
      status: "unknown",
      reason: "COMPANION_INSPECTION_UNAVAILABLE",
      subplan: {
        action: "conflict",
        expectedBefore: { state: "unknown" },
        proof: { kind: "unknown" }
      }
    });

    const truncated = await inspectCompanionSkillWithProof(fixture, {
      destination: { limits: { maxEntries: 1 } }
    });
    expect(truncated).toMatchObject({
      status: "unknown",
      reason: "COMPANION_INSPECTION_TRUNCATED",
      subplan: { action: "conflict" }
    });
  });

  it("maps unprovable Windows reparse semantics to unknown", async () => {
    const fixture = await companionFixture();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, "SKILL.md"), "current?\n", "utf8");

    const result = await inspectCompanionSkillWithProof(fixture, {
      destination: { platform: "win32" }
    });
    expect(result).toMatchObject({
      status: "unknown",
      reason: "COMPANION_INSPECTION_UNPROVABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("keeps an actually unsafe packaged source typed invalid", async () => {
    const fixture = await companionFixture();
    const outside = join(fixture.home, "source-outside");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(fixture.sourceDirectory, "linked"));

    await expect(inspectCompanionSkill(fixture)).rejects.toMatchObject({
      code: "COMPANION_SOURCE_INVALID"
    });
  });

  it("keeps ordinary packaged-source I/O typed invalid", async () => {
    const fixture = await companionFixture();
    await expect(inspectCompanionSkillWithProof(fixture, {
      source: {
        openDirectory: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      }
    })).rejects.toMatchObject({ code: "COMPANION_SOURCE_INVALID" });
  });

  it("keeps missing or changing packaged source typed invalid", async () => {
    const missing = await companionFixture();
    await rm(missing.sourceDirectory, { recursive: true, force: true });
    await expect(inspectCompanionSkill(missing)).rejects.toMatchObject({
      code: "COMPANION_SOURCE_INVALID"
    });

    const changing = await companionFixture();
    await expect(inspectCompanionSkillWithProof(changing, {
      source: {
        openFile: async (path, flags) => {
          if (path.endsWith("SKILL.md")) {
            await writeFile(path, "changed during source inspection\n", "utf8");
          }
          return open(path, flags);
        }
      }
    })).rejects.toMatchObject({ code: "COMPANION_SOURCE_INVALID" });
  });

  it("maps a deterministic Win32 packaged-source replacement to source-invalid", async () => {
    const fixture = await companionFixture();
    const moved = `${fixture.sourceDirectory}-initial`;
    let rootSamples = 0;
    await expect(inspectCompanionSkillWithProof(fixture, {
      source: {
        platform: "win32",
        lstatPath: async (path) => {
          const metadata = await lstat(path);
          if (path === fixture.sourceDirectory) {
            rootSamples += 1;
            if (rootSamples === 1) {
              await rename(fixture.sourceDirectory, moved);
              await mkdir(fixture.sourceDirectory);
              await writeFile(
                join(fixture.sourceDirectory, "SKILL.md"),
                "replacement\n",
                "utf8"
              );
            }
          }
          return metadata;
        }
      }
    })).rejects.toMatchObject({ code: "COMPANION_SOURCE_INVALID" });
    expect(rootSamples).toBe(2);
  });

  it("ignores forged ownership fields passed to the public inspector", async () => {
    const fixture = await companionFixture();
    await mkdir(dirname(fixture.destination), { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });
    const forged = {
      ...fixture,
      managedProof: {
        kind: "recorded",
        recordId: "caller-controlled",
        installedFingerprint: "sha256:" + "0".repeat(64)
      }
    } as unknown as InspectCompanionSkillInput;

    await expect(inspectCompanionSkill(forged)).resolves.toMatchObject({
      status: "conflict",
      reason: "COMPANION_UNMANAGED_TREE"
    });
  });

  it("maps a link/reparse/special structure to conflict and never follows it", async () => {
    const fixture = await companionFixture();
    await mkdir(fixture.destination, { recursive: true });
    const outside = join(fixture.home, "outside");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(fixture.destination, "linked"));

    const result = await inspectCompanionSkill(fixture);
    expect(result).toMatchObject({
      status: "conflict",
      reason: "COMPANION_TREE_UNSAFE",
      subplan: { action: "conflict", proof: { kind: "conflict" } }
    });
  });

  it("does not use the installer directory fingerprint helper", async () => {
    const source = await readFile(new URL("../src/companion-skill.ts", import.meta.url), "utf8");
    expect(source).not.toContain("fingerprintDirectory");
    expect(source).not.toContain("managedProof");
    expect(source).not.toContain("installCompanionSkill");
    expect(source).not.toContain("removeManagedCompanionSkill");
    const root = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(root).not.toContain("companion-inspector-internal");
    expect(root).not.toContain("companion-manifest");
  });
});
