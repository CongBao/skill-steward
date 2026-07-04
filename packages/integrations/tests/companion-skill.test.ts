import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendIntegrationRecord, readIntegrationRecords } from "@skill-steward/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planIntegration } from "../src/config.js";
import {
  companionSkillDirectory,
  inspectCompanionSkill,
  type InspectCompanionSkillInput
} from "../src/companion-skill.js";
import { inspectCompanionSkillWithProof } from "../src/companion-inspector-internal.js";
import { inspectCompanionTree } from "../src/companion-manifest.js";

const journalRemovalGate = vi.hoisted(() => ({
  remainingFailures: 0,
  restore: null as Buffer | null,
  target: null as string | null,
  triggered: false
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async open(...args: Parameters<typeof original.open>) {
      const path = String(args[0]);
      if (
        path === journalRemovalGate.target
        && (!journalRemovalGate.triggered || journalRemovalGate.remainingFailures > 0)
      ) {
        journalRemovalGate.triggered = true;
        await original.unlink(path);
        if (journalRemovalGate.remainingFailures > 0) {
          journalRemovalGate.remainingFailures -= 1;
          let failure: unknown;
          try {
            await original.open(...args);
          } catch (error) {
            failure = error;
          }
          await original.writeFile(path, journalRemovalGate.restore!, { mode: 0o600 });
          throw failure;
        }
      }
      return original.open(...args);
    }
  };
});

afterEach(() => {
  journalRemovalGate.remainingFailures = 0;
  journalRemovalGate.restore = null;
  journalRemovalGate.target = null;
  journalRemovalGate.triggered = false;
});

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

const legacyAlphaTree = fileURLToPath(new URL(
  "./fixtures/companion-legacy/alpha-0.3.0-alpha.1/tree",
  import.meta.url
));

async function legacyAlphaEvidenceFixture() {
  const home = await mkdtemp(join(tmpdir(), "steward-companion-legacy-"));
  const stateDirectory = join(home, "state");
  const sourceDirectory = fileURLToPath(new URL(
    "../assets/skill-steward-preflight",
    import.meta.url
  ));
  const destination = companionSkillDirectory(home);
  await mkdir(dirname(destination), { recursive: true });
  await cp(legacyAlphaTree, destination, { recursive: true });
  const plan = await planIntegration("codex", {
    home,
    stateDirectory,
    companionSourceDirectory: sourceDirectory,
    id: () => "legacy-config-plan",
    now: () => new Date("2026-07-04T00:00:00.000Z")
  });
  await mkdir(dirname(plan.targetPath), { recursive: true });
  await writeFile(
    plan.targetPath,
    `${JSON.stringify(plan.afterConfig, null, 2)}\n`,
    "utf8"
  );
  await appendIntegrationRecord(stateDirectory, {
    schemaVersion: 1,
    id: "legacy-hook-record",
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: plan.targetPath,
    beforeFingerprint: plan.expectedBeforeFingerprint,
    afterFingerprint: plan.afterFingerprint,
    installedEntryFingerprint: plan.installedEntryFingerprint,
    createdAt: "2026-07-04T00:00:00.000Z"
  });
  return { home, stateDirectory, sourceDirectory, destination, plan };
}

async function legacyCopilotEvidenceFixture(
  sourceFor: (config: Record<string, unknown>) => Buffer
) {
  const home = await mkdtemp(join(tmpdir(), "steward-companion-copilot-proof-"));
  const stateDirectory = join(home, "state");
  const sourceDirectory = fileURLToPath(new URL(
    "../assets/skill-steward-preflight",
    import.meta.url
  ));
  const destination = companionSkillDirectory(home);
  await mkdir(dirname(destination), { recursive: true });
  await cp(legacyAlphaTree, destination, { recursive: true });
  const plan = await planIntegration("github-copilot", {
    home,
    stateDirectory,
    companionSourceDirectory: sourceDirectory,
    id: () => "copilot-proof-plan",
    now: () => new Date("2026-07-04T00:30:00.000Z")
  });
  const source = sourceFor(plan.afterConfig);
  await mkdir(dirname(plan.targetPath), { recursive: true });
  await writeFile(plan.targetPath, source);
  await appendIntegrationRecord(stateDirectory, {
    schemaVersion: 1,
    id: "copilot-proof-record",
    harness: "github-copilot",
    action: "apply",
    status: "installed",
    targetPath: plan.targetPath,
    beforeFingerprint: plan.expectedBeforeFingerprint,
    afterFingerprint: plan.afterFingerprint,
    installedEntryFingerprint: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    createdAt: "2026-07-04T00:30:00.000Z"
  });
  return { home, stateDirectory, sourceDirectory };
}

async function recordedEvidenceFixture(state: "current" | "old") {
  const fixture = await companionFixture();
  const stateDirectory = join(fixture.home, "state");
  await mkdir(dirname(fixture.destination), { recursive: true });
  if (state === "current") {
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });
  } else {
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, "SKILL.md"), "recorded old\n", "utf8");
  }
  const unowned = await inspectCompanionSkill(fixture);
  if (unowned.subplan.expectedBefore.state !== "exact") {
    throw new Error("expected an exact readable companion tree");
  }
  const installedFingerprint = unowned.subplan.expectedBefore.fingerprint;
  const plan = await planIntegration("codex", {
    home: fixture.home,
    stateDirectory,
    companionSourceDirectory: fixture.sourceDirectory,
    id: () => `recorded-${state}-plan`,
    now: () => new Date("2026-07-04T01:00:00.000Z")
  });
  await mkdir(dirname(plan.targetPath), { recursive: true });
  await writeFile(
    plan.targetPath,
    `${JSON.stringify(plan.afterConfig, null, 2)}\n`,
    "utf8"
  );
  await appendIntegrationRecord(stateDirectory, {
    schemaVersion: 2,
    id: `recorded-${state}`,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: plan.targetPath,
    beforeFingerprint: plan.expectedBeforeFingerprint,
    afterFingerprint: plan.afterFingerprint,
    installedEntryFingerprint: plan.installedEntryFingerprint,
    companion: {
      action: "none",
      path: fixture.destination,
      before: { state: "exact", fingerprint: installedFingerprint },
      after: { state: "exact", fingerprint: installedFingerprint },
      source: { fingerprint: installedFingerprint },
      proof: { category: "recorded" },
      installedFingerprint,
      consumers: ["codex"]
    },
    trigger: {
      planId: `recorded-${state}-plan`,
      harness: "codex",
      createdAt: "2026-07-04T01:00:00.000Z"
    },
    createdAt: "2026-07-04T01:00:00.000Z"
  });
  return { ...fixture, stateDirectory, plan };
}

describe("inspectCompanionSkill", () => {
  it("keeps auditable POSIX and Win32 manifests for the copied shipped Alpha tree", async () => {
    for (const platform of ["posix", "win32"] as const) {
      const expected = JSON.parse(await readFile(new URL(
        `./fixtures/companion-legacy/alpha-0.3.0-alpha.1/manifest.${platform}.json`,
        import.meta.url
      ), "utf8"));
      const actual = await inspectCompanionTree(legacyAlphaTree, {
        boundary: dirname(legacyAlphaTree),
        ...(platform === "win32"
          ? { platform: "win32" as const, isReparsePoint: async () => false }
          : {})
      });
      expect(actual).toEqual(expected);
      expect(JSON.stringify(expected)).not.toContain("/Users/");
    }
  });

  it("admits a shipped Alpha tree only from private v1 record and live Hook proof", async () => {
    const fixture = await legacyAlphaEvidenceFixture();

    const result = await inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    } as Parameters<typeof inspectCompanionSkillWithProof>[0]);

    expect(result).toMatchObject({
      status: "upgrade-available",
      reason: "COMPANION_UPGRADE_AVAILABLE",
      subplan: {
        action: "upgrade",
        proof: {
          kind: "legacy-alpha",
          allowlistId: "skill-steward-preflight@0.3.0-alpha.1",
          installedHookRecordId: "legacy-hook-record"
        }
      }
    });
  });

  it("admits the same exact shipped Alpha tree with injected Win32 manifest semantics", async () => {
    const fixture = await legacyAlphaEvidenceFixture();
    const noReparsePoint = async () => false;
    const result = await inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    }, {
      source: { platform: "win32", isReparsePoint: noReparsePoint },
      destination: { platform: "win32", isReparsePoint: noReparsePoint }
    });
    expect(result).toMatchObject({
      status: "upgrade-available",
      subplan: {
        action: "upgrade",
        proof: {
          kind: "legacy-alpha",
          allowlistId: "skill-steward-preflight@0.3.0-alpha.1"
        }
      }
    });
  });

  it("classifies readable legacy proof mismatches as conflict", async () => {
    const cases: Array<{
      name: string;
      mutate: (fixture: Awaited<ReturnType<typeof legacyAlphaEvidenceFixture>>) => Promise<void>;
    }> = [
      {
        name: "removed record",
        mutate: async ({ stateDirectory }) => {
          await rm(join(stateDirectory, "integration-records"), { recursive: true });
        }
      },
      {
        name: "latest removal",
        mutate: async ({ stateDirectory, plan }) => {
          await appendIntegrationRecord(stateDirectory, {
            schemaVersion: 1,
            id: "legacy-hook-removed",
            harness: "codex",
            action: "remove",
            status: "removed",
            targetPath: plan.targetPath,
            beforeFingerprint: plan.afterFingerprint,
            afterFingerprint: plan.expectedBeforeFingerprint,
            installedEntryFingerprint: plan.installedEntryFingerprint,
            createdAt: "2026-07-04T00:01:00.000Z"
          });
        }
      },
      {
        name: "missing config",
        mutate: async ({ plan }) => { await unlink(plan.targetPath); }
      },
      {
        name: "config drift",
        mutate: async ({ plan }) => {
          const config = JSON.parse(await readFile(plan.targetPath, "utf8"));
          config.hooks.UserPromptSubmit[0].hooks[0].command = "different command";
          await writeFile(plan.targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        }
      },
      {
        name: "extra tree entry",
        mutate: async ({ destination }) => {
          await writeFile(join(destination, "EXTRA.md"), "extra\n", "utf8");
        }
      },
      {
        name: "one byte tree edit",
        mutate: async ({ destination }) => {
          await writeFile(join(destination, "SKILL.md"), "x", "utf8");
        }
      },
      {
        name: "allowlisted subset",
        mutate: async ({ destination }) => {
          await unlink(join(destination, "agents", "openai.yaml"));
        }
      },
      {
        name: "frontmatter and name equality only",
        mutate: async ({ destination, sourceDirectory }) => {
          await cp(
            join(sourceDirectory, "SKILL.md"),
            join(destination, "SKILL.md"),
            { force: true }
          );
        }
      }
    ];
    if (process.platform !== "win32") {
      cases.push({
        name: "mode drift",
        mutate: async ({ destination }) => {
          await chmod(join(destination, "SKILL.md"), 0o600);
        }
      });
      cases.push({
        name: "linked canonical config ancestor",
        mutate: async ({ home, plan }) => {
          const canonicalParent = dirname(plan.targetPath);
          const physicalParent = join(home, "physical-config-parent");
          await rename(canonicalParent, physicalParent);
          await symlink(physicalParent, canonicalParent, "dir");
        }
      });
    }

    for (const entry of cases) {
      const fixture = await legacyAlphaEvidenceFixture();
      await entry.mutate(fixture);
      const result = await inspectCompanionSkillWithProof({
        home: fixture.home,
        stateDirectory: fixture.stateDirectory,
        sourceDirectory: fixture.sourceDirectory,
        harness: "codex"
      });
      expect(result, entry.name).toMatchObject({
        status: "conflict",
        subplan: { action: "conflict", proof: { kind: "conflict" } }
      });
    }
  });

  it("classifies unreadable or malformed private legacy proof as unknown", async () => {
    const malformed = await legacyAlphaEvidenceFixture();
    const [fragment] = await readdir(join(malformed.stateDirectory, "integration-records"));
    await writeFile(
      join(malformed.stateDirectory, "integration-records", fragment!),
      "not-json\n",
      "utf8"
    );
    await expect(inspectCompanionSkillWithProof({
      home: malformed.home,
      stateDirectory: malformed.stateDirectory,
      sourceDirectory: malformed.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNAVAILABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });

    if (process.platform !== "win32") {
      const unreadable = await legacyAlphaEvidenceFixture();
      await chmod(unreadable.plan.targetPath, 0o000);
      try {
        await expect(inspectCompanionSkillWithProof({
          home: unreadable.home,
          stateDirectory: unreadable.stateDirectory,
          sourceDirectory: unreadable.sourceDirectory,
          harness: "codex"
        })).resolves.toMatchObject({
          status: "unknown",
          reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE"
        });
      } finally {
        await chmod(unreadable.plan.targetPath, 0o600);
      }
    }
  });

  it("treats legal UTF-8 containing malformed Copilot Hook JSON as unknown", async () => {
    const fixture = await legacyCopilotEvidenceFixture(() =>
      Buffer.from('{"version":1,"hooks":\n', "utf8")
    );

    await expect(inspectCompanionSkillWithProof({
      ...fixture,
      harness: "github-copilot"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("rejects noncanonical Copilot Hook bytes even when a v1 fingerprint matches", async () => {
    const variants = [
      (config: Record<string, unknown>) => Buffer.from(JSON.stringify(config), "utf8"),
      (config: Record<string, unknown>) => Buffer.from(
        `${JSON.stringify(config, null, 2).replace(
          '"version": 1',
          '"version": 0,\n  "version": 1'
        )}\n`,
        "utf8"
      )
    ];
    for (const sourceFor of variants) {
      const fixture = await legacyCopilotEvidenceFixture(sourceFor);
      await expect(inspectCompanionSkillWithProof({
        ...fixture,
        harness: "github-copilot"
      })).resolves.toMatchObject({
        status: "conflict",
        reason: "COMPANION_CANONICAL_CONFIG_DRIFT",
        subplan: { action: "conflict", proof: { kind: "conflict" } }
      });
    }
  });

  it("fails closed on deterministic canonical config target and parent swaps", async () => {
    for (const boundary of ["target", "parent"] as const) {
      const fixture = await legacyAlphaEvidenceFixture();
      const target = fixture.plan.targetPath;
      const source = await readFile(target);
      let opened = false;
      const result = await inspectCompanionSkillWithProof({
        home: fixture.home,
        stateDirectory: fixture.stateDirectory,
        sourceDirectory: fixture.sourceDirectory,
        harness: "codex"
      }, {
        config: {
          openFile: async (path, flags) => {
            if (!opened) {
              opened = true;
              if (boundary === "target") {
                await rename(target, `${target}.initial`);
                await writeFile(target, source);
              } else {
                const parent = dirname(target);
                await rename(parent, `${parent}.initial`);
                await mkdir(parent);
                await writeFile(target, source);
              }
            }
            return open(path, flags);
          }
        }
      } as Parameters<typeof inspectCompanionSkillWithProof>[1]);
      expect(result, boundary).toMatchObject({
        status: "conflict",
        reason: "COMPANION_CANONICAL_CONFIG_DRIFT"
      });
    }
  });

  it("treats invalid UTF-8 in canonical config proof as unknown", async () => {
    const fixture = await legacyAlphaEvidenceFixture();
    const source = await readFile(fixture.plan.targetPath);
    const invalid = Buffer.concat([
      Buffer.from('{"invalid":"'),
      Buffer.from([0x80]),
      Buffer.from('",'),
      source.subarray(1)
    ]);
    await writeFile(fixture.plan.targetPath, invalid);

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE"
    });
  });

  it("bounds canonical config bytes before extracting Hook proof", async () => {
    const fixture = await legacyAlphaEvidenceFixture();
    const source = await readFile(fixture.plan.targetPath, "utf8");
    await writeFile(
      fixture.plan.targetPath,
      `${source}${" ".repeat(2 * 1024 * 1024)}`,
      "utf8"
    );

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("treats zero Windows identity for config target or any ancestor as unknown", async () => {
    for (const boundary of ["target", "ancestor"] as const) {
      const fixture = await legacyAlphaEvidenceFixture();
      const zeroPath = boundary === "target" ? fixture.plan.targetPath : fixture.home;
      const result = await inspectCompanionSkillWithProof({
        home: fixture.home,
        stateDirectory: fixture.stateDirectory,
        sourceDirectory: fixture.sourceDirectory,
        harness: "codex"
      }, {
        config: {
          platform: "win32",
          lstatPath: async (path: string) => {
            const metadata = await lstat(path, { bigint: true });
            if (path !== zeroPath) return metadata;
            return new Proxy(metadata, {
              get(target, property, receiver) {
                if (property === "dev" || property === "ino") return 0n;
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
            });
          }
        }
      } as Parameters<typeof inspectCompanionSkillWithProof>[1]);

      expect(result, boundary).toMatchObject({
        status: "unknown",
        reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE",
        subplan: { action: "conflict", proof: { kind: "unknown" } }
      });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "proves native Windows canonical config identities before legacy adoption",
    async () => {
      const fixture = await legacyAlphaEvidenceFixture();
      await expect(inspectCompanionSkillWithProof({
        home: fixture.home,
        stateDirectory: fixture.stateDirectory,
        sourceDirectory: fixture.sourceDirectory,
        harness: "codex"
      }, { config: { platform: "win32" } } as Parameters<
        typeof inspectCompanionSkillWithProof
      >[1])).resolves.toMatchObject({
        status: "upgrade-available",
        subplan: { action: "upgrade", proof: { kind: "legacy-alpha" } }
      });
    }
  );

  it("rejects a linked legacy tree without following it", async () => {
    const fixture = await legacyAlphaEvidenceFixture();
    const outside = join(fixture.home, "outside-legacy");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(fixture.destination, "linked"));

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "conflict",
      reason: "COMPANION_TREE_UNSAFE"
    });
  });

  it("does not authorize current-package equality without a private record", async () => {
    const fixture = await companionFixture();
    await mkdir(dirname(fixture.destination), { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: join(fixture.home, "empty-state"),
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "conflict",
      subplan: { action: "conflict", proof: { kind: "conflict" } }
    });
  });

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
    const fixture = await recordedEvidenceFixture("current");
    const result = await inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    });
    expect(result).toMatchObject({
      status: "current",
      reason: "COMPANION_CURRENT",
      subplan: { action: "none", proof: { kind: "recorded" } }
    });
  });

  it("keeps recorded proof current across concurrent pure readers", async () => {
    const fixture = await recordedEvidenceFixture("current");
    const results = (await Promise.all(Array.from({ length: 20 }, async () => {
      const workerResults = [];
      for (let index = 0; index < 20; index += 1) {
        workerResults.push(await inspectCompanionSkillWithProof({
          home: fixture.home,
          stateDirectory: fixture.stateDirectory,
          sourceDirectory: fixture.sourceDirectory,
          harness: "codex"
        }));
      }
      return workerResults;
    }))).flat();

    expect(results.every((result) =>
      result.status === "current"
      && result.subplan.action === "none"
      && result.subplan.proof.kind === "recorded"
    )).toBe(true);
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
    const fixture = await recordedEvidenceFixture("old");
    const result = await inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    });
    expect(result).toMatchObject({
      status: "upgrade-available",
      reason: "COMPANION_UPGRADE_AVAILABLE",
      subplan: { action: "upgrade", proof: { kind: "recorded", recordId: "recorded-old" } }
    });
  });

  it("requires recorded proof to match both the live tree and canonical Hook config", async () => {
    const treeDrift = await recordedEvidenceFixture("current");
    await writeFile(join(treeDrift.destination, "EXTRA.md"), "extra\n", "utf8");
    await expect(inspectCompanionSkillWithProof({
      home: treeDrift.home,
      stateDirectory: treeDrift.stateDirectory,
      sourceDirectory: treeDrift.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "conflict",
      reason: "COMPANION_RECORDED_TREE_DRIFT"
    });

    const configDrift = await recordedEvidenceFixture("current");
    const config = JSON.parse(await readFile(configDrift.plan.targetPath, "utf8"));
    config.hooks.Stop[0].hooks[0].command = "different command";
    await writeFile(
      configDrift.plan.targetPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8"
    );
    await expect(inspectCompanionSkillWithProof({
      home: configDrift.home,
      stateDirectory: configDrift.stateDirectory,
      sourceDirectory: configDrift.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "conflict",
      reason: "COMPANION_CANONICAL_CONFIG_DRIFT"
    });
  });

  it("uses the global v2 companion head with the current Harness Hook proof", async () => {
    const fixture = await recordedEvidenceFixture("old");
    await rm(fixture.destination, { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });
    const current = await inspectCompanionSkill(fixture);
    if (current.subplan.expectedBefore.state !== "exact") {
      throw new Error("expected an exact upgraded companion tree");
    }
    const installedFingerprint = current.subplan.expectedBefore.fingerprint;
    const claudePlan = await planIntegration("claude-code", {
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      companionSourceDirectory: fixture.sourceDirectory,
      id: () => "claude-upgrade-plan",
      now: () => new Date("2026-07-04T02:00:00.000Z")
    });
    await mkdir(dirname(claudePlan.targetPath), { recursive: true });
    await writeFile(
      claudePlan.targetPath,
      `${JSON.stringify(claudePlan.afterConfig, null, 2)}\n`,
      "utf8"
    );
    const [codexRecord] = await readIntegrationRecords(fixture.stateDirectory);
    if (codexRecord?.schemaVersion !== 2) throw new Error("expected v2 Codex record");
    await appendIntegrationRecord(fixture.stateDirectory, {
      schemaVersion: 2,
      id: "claude-upgrade-head",
      harness: "claude-code",
      action: "apply",
      status: "installed",
      targetPath: claudePlan.targetPath,
      beforeFingerprint: claudePlan.expectedBeforeFingerprint,
      afterFingerprint: claudePlan.afterFingerprint,
      installedEntryFingerprint: claudePlan.installedEntryFingerprint,
      companion: {
        action: "upgrade",
        path: fixture.destination,
        before: {
          state: "exact",
          fingerprint: codexRecord.companion.installedFingerprint
        },
        after: { state: "exact", fingerprint: installedFingerprint },
        source: { fingerprint: installedFingerprint },
        proof: { category: "recorded" },
        installedFingerprint,
        consumers: ["claude-code", "codex"]
      },
      trigger: {
        planId: "claude-upgrade-plan",
        harness: "claude-code",
        createdAt: "2026-07-04T02:00:00.000Z"
      },
      createdAt: "2026-07-04T02:00:00.000Z"
    }, { limit: 1 });

    await expect(readIntegrationRecords(fixture.stateDirectory)).resolves.toMatchObject([
      { id: "claude-upgrade-head", harness: "claude-code" }
    ]);

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "current",
      subplan: {
        action: "none",
        proof: { kind: "recorded", recordId: "claude-upgrade-head" }
      }
    });
  });

  it("fails closed when a newer v1 record shadows the latest v2 companion head", async () => {
    const fixture = await recordedEvidenceFixture("current");
    await appendIntegrationRecord(fixture.stateDirectory, {
      schemaVersion: 1,
      id: "downgraded-binary-write",
      harness: "codex",
      action: "apply",
      status: "installed",
      targetPath: fixture.plan.targetPath,
      beforeFingerprint: fixture.plan.expectedBeforeFingerprint,
      afterFingerprint: fixture.plan.afterFingerprint,
      installedEntryFingerprint: fixture.plan.installedEntryFingerprint,
      createdAt: "2026-07-04T03:00:00.000Z"
    });

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNPROVABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("does not revive an older v2 when its newer v1 shadow disappears during read", async () => {
    const fixture = await recordedEvidenceFixture("current");
    await appendIntegrationRecord(fixture.stateDirectory, {
      schemaVersion: 1,
      id: "disappearing-shadow",
      harness: "codex",
      action: "apply",
      status: "installed",
      targetPath: fixture.plan.targetPath,
      beforeFingerprint: fixture.plan.expectedBeforeFingerprint,
      afterFingerprint: fixture.plan.afterFingerprint,
      installedEntryFingerprint: fixture.plan.installedEntryFingerprint,
      createdAt: "2026-07-04T03:15:00.000Z"
    });
    const directory = join(fixture.stateDirectory, "integration-records");
    for (const fileName of await readdir(directory)) {
      const path = join(directory, fileName);
      const fragment = JSON.parse(await readFile(path, "utf8"));
      if (fragment.record.id === "disappearing-shadow") {
        journalRemovalGate.target = path;
        break;
      }
    }
    if (journalRemovalGate.target === null) throw new Error("shadow fragment not found");

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNPROVABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
    expect(journalRemovalGate.triggered).toBe(true);
  });

  it("returns unknown when a disappearing shadow exhausts bounded snapshot retries", async () => {
    const fixture = await recordedEvidenceFixture("current");
    await appendIntegrationRecord(fixture.stateDirectory, {
      schemaVersion: 1,
      id: "churning-shadow",
      harness: "codex",
      action: "apply",
      status: "installed",
      targetPath: fixture.plan.targetPath,
      beforeFingerprint: fixture.plan.expectedBeforeFingerprint,
      afterFingerprint: fixture.plan.afterFingerprint,
      installedEntryFingerprint: fixture.plan.installedEntryFingerprint,
      createdAt: "2026-07-04T03:20:00.000Z"
    });
    const directory = join(fixture.stateDirectory, "integration-records");
    for (const fileName of await readdir(directory)) {
      const path = join(directory, fileName);
      const source = await readFile(path);
      if (JSON.parse(source.toString("utf8")).record.id === "churning-shadow") {
        journalRemovalGate.target = path;
        journalRemovalGate.restore = source;
        journalRemovalGate.remainingFailures = 100;
        break;
      }
    }
    if (journalRemovalGate.target === null) throw new Error("churning shadow not found");

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNAVAILABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
    expect(journalRemovalGate.remainingFailures).toBeLessThan(100);
  });

  it("preserves the v1 shadow barrier when the newer fragment limit is one", async () => {
    const fixture = await recordedEvidenceFixture("current");
    await appendIntegrationRecord(fixture.stateDirectory, {
      schemaVersion: 1,
      id: "limited-downgraded-write",
      harness: "codex",
      action: "apply",
      status: "installed",
      targetPath: fixture.plan.targetPath,
      beforeFingerprint: fixture.plan.expectedBeforeFingerprint,
      afterFingerprint: fixture.plan.afterFingerprint,
      installedEntryFingerprint: fixture.plan.installedEntryFingerprint,
      createdAt: "2026-07-04T03:30:00.000Z"
    }, { limit: 1 });

    await expect(readIntegrationRecords(fixture.stateDirectory)).resolves.toMatchObject([
      { id: "limited-downgraded-write", schemaVersion: 1 }
    ]);
    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNPROVABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("fails closed when one record ID is reused across v1 and v2", async () => {
    const fixture = await recordedEvidenceFixture("current");
    await writeFile(
      join(
        fixture.stateDirectory,
        "integration-records",
        `${Date.now()}-${process.pid}-999999999997-44444444-4444-4444-8444-444444444444.json`
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        limit: 100,
        record: {
          schemaVersion: 1,
          id: "recorded-current",
          harness: "codex",
          action: "apply",
          status: "installed",
          targetPath: fixture.plan.targetPath,
          beforeFingerprint: fixture.plan.expectedBeforeFingerprint,
          afterFingerprint: fixture.plan.afterFingerprint,
          installedEntryFingerprint: fixture.plan.installedEntryFingerprint,
          createdAt: "2026-07-04T04:00:00.000Z"
        }
      }, null, 2)}\n`,
      { mode: 0o600 }
    );

    await expect(inspectCompanionSkillWithProof({
      home: fixture.home,
      stateDirectory: fixture.stateDirectory,
      sourceDirectory: fixture.sourceDirectory,
      harness: "codex"
    })).resolves.toMatchObject({
      status: "unknown",
      reason: "COMPANION_LIFECYCLE_RECORD_UNAVAILABLE",
      subplan: { action: "conflict", proof: { kind: "unknown" } }
    });
  });

  it("ignores caller-injected proof even on the private inspection entry point", async () => {
    const fixture = await companionFixture();
    await mkdir(dirname(fixture.destination), { recursive: true });
    await cp(fixture.sourceDirectory, fixture.destination, { recursive: true });
    const readable = await inspectCompanionSkill(fixture);
    if (readable.subplan.expectedBefore.state !== "exact") {
      throw new Error("expected exact readable tree");
    }
    const injected = {
      home: fixture.home,
      sourceDirectory: fixture.sourceDirectory,
      managedProof: {
        kind: "recorded",
        recordId: "caller-controlled",
        installedFingerprint: readable.subplan.expectedBefore.fingerprint
      }
    } as unknown as Parameters<typeof inspectCompanionSkillWithProof>[0];

    await expect(inspectCompanionSkillWithProof(injected)).resolves.toMatchObject({
      status: "conflict",
      reason: "COMPANION_UNMANAGED_TREE"
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
