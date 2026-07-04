import {
  access,
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintDirectory,
  readInstallationHistory,
  StagingRegistry
} from "@skill-steward/installer";
import {
  writeCatalogSnapshot,
  writeCatalogSources,
  writeReviewedPlan
} from "@skill-steward/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/context.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

async function run(argv: string[], context: CliContext): Promise<number> {
  vi.resetModules();
  return (await import("../src/main.js")).run(argv, context);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface StoredInstallationPlan {
  id: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
  payload: {
    plan: {
      id: string;
      status?: string;
      action?: string;
      source: string;
      destination: string;
      changes?: Array<{ operation: string; path: string }>;
      createdAt: number;
      expiresAt: number;
      provenance?: Record<string, string>;
    };
    previewId: string;
    candidateName: string;
    route: {
      harness: string;
      scope: string;
      targetName: string;
      workspace: string;
    };
  };
}

async function storedPlan(stateDir: string, id: string): Promise<StoredInstallationPlan> {
  return JSON.parse(await readFile(
    join(stateDir, "reviewed-plans", `${id}.json`),
    "utf8"
  )) as StoredInstallationPlan;
}

async function stagingEntries(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(join(stateDir, "staging"))).filter((name) => !name.startsWith("."));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-catalog-install-")));
  const candidateDirectory = join(base, "candidate");
  await mkdir(candidateDirectory, { recursive: true });
  await writeFile(
    join(candidateDirectory, "SKILL.md"),
    "---\nname: testing-review\ndescription: Find missing tests\n---\nReview tests.\n"
  );
  const fingerprint = await fingerprintDirectory(candidateDirectory);
  const stateDir = join(base, "state");
  const source = {
    id: "fixture-catalog",
    name: "Fixture catalog",
    kind: "git" as const,
    url: "https://example.com/skills-secret-token.git",
    enabled: true,
    trust: "user" as const,
    preset: false
  };
  await writeCatalogSources(stateDir, [source]);
  await writeCatalogSnapshot(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    sources: [{ sourceId: source.id, status: "ready", skillCount: 1 }],
    skills: [{
      id: "testing-available",
      sourceId: source.id,
      sourceRevision: "a".repeat(40),
      relativePath: "testing",
      name: "testing-review",
      description: "Find missing tests",
      fingerprint,
      estimatedTokens: 50,
      scripts: [],
      executables: [],
      findings: [],
      compatibleHarnesses: ["codex"],
      compatibility: "declared"
    }]
  });
  await writeFile(join(stateDir, "preflights.json"), `${JSON.stringify({
    schemaVersion: 3,
    records: [{
      schemaVersion: 3,
      id: "run-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"b".repeat(64)}`,
      taskHash: `sha256:${"c".repeat(64)}`,
      taskCharacterCount: 20,
      taskTermCount: 3,
      algorithmVersion: 2,
      harness: "codex",
      candidateIds: ["testing-available"],
      useCandidateIds: [],
      installCandidateIds: ["testing-available"]
    }]
  }, null, 2)}\n`, "utf8");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stageCalls = 0;
  let now = new Date("2026-07-03T00:00:00.000Z");
  const context: CliContext = {
    cwd: base,
    home: base,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    catalogStage: async (destination) => {
      stageCalls += 1;
      const staged = join(destination, "source");
      await cp(candidateDirectory, staged, { recursive: true });
      return { sourceDirectory: staged, commitSha: "a".repeat(40) };
    },
    now: () => now
  };
  return {
    base,
    candidateDirectory,
    stateDir,
    stdout,
    stderr,
    context,
    stageCalls: () => stageCalls,
    setNow: (value: Date) => { now = value; }
  };
}

function previewArgs(...extra: string[]): string[] {
  return [
    "install",
    "--catalog-candidate", "testing-available",
    "--harness", "codex",
    "--scope", "global",
    "--preflight", "run-1",
    "--json",
    ...extra
  ];
}

describe("catalog install command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("refreshes the normal portfolio with shared native inventory after commit", async () => {
    await installNativeCodexFixture(current.context.home);
    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));

    expect(await run([
      "install", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);

    const report = JSON.parse(
      await readFile(join(current.stateDir, "latest-report.json"), "utf8")
    );
    expect(report).toMatchObject({
      schemaVersion: 2,
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "testing-review" }),
        expect.objectContaining({
          name: "native-review",
          ownership: "native-plugin"
        })
      ])
    });
    expect(report.inventory.harnesses).toContainEqual(
      expect.objectContaining({ harness: "codex", status: "verified" })
    );
  });

  it("persists a private exact plan and applies it in a fresh process without restaging", async () => {
    const destination = join(current.base, ".agents", "skills", "testing-review");
    expect(await run(previewArgs(), current.context)).toBe(0);
    const previewOutput = current.stdout.splice(0).join("");
    expect(previewOutput).not.toContain("https://example.com");
    expect(previewOutput).not.toContain("secret-token");
    const preview = JSON.parse(previewOutput);
    expect(preview).toMatchObject({
      status: "ready",
      action: "create",
      destination,
      planId: expect.any(String),
      expiresAt: Date.parse("2026-07-03T00:05:00.000Z"),
      applyCommand: expect.stringMatching(/^skill-steward install --plan \S+ --confirm$/),
      changes: [{ operation: "create", path: destination }]
    });
    expect(current.stageCalls()).toBe(1);
    expect(await exists(destination)).toBe(false);

    const stored = await storedPlan(current.stateDir, preview.planId);
    expect(stored).toMatchObject({
      id: preview.planId,
      kind: "installation",
      createdAt: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-03T00:05:00.000Z",
      payload: {
        plan: {
          id: preview.planId,
          provenance: {
            preflightId: "run-1",
            candidateId: "testing-available",
            sourceId: "fixture-catalog",
            sourceRevision: "a".repeat(40)
          }
        },
        candidateName: "testing-review",
        route: {
          harness: "codex",
          scope: "global",
          targetName: "testing-review",
          workspace: current.base
        }
      }
    });
    expect(stored.payload.previewId).toBe(preview.planId);
    const metadataPath = join(
      current.stateDir,
      "staging",
      stored.payload.previewId,
      "preview.json"
    );
    expect((await stat(join(current.stateDir, "staging"))).mode & 0o777).toBe(0o700);
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(current.stateDir, "reviewed-plans", `${preview.planId}.json`))).mode & 0o777)
      .toBe(0o600);
    expect(await stagingEntries(current.stateDir)).toEqual([stored.payload.previewId]);
    expect(await readFile(join(current.stateDir, "reviewed-plans", `${preview.planId}.json`), "utf8"))
      .not.toContain("secret-token");

    current.context.catalogStage = async () => {
      throw new Error("apply must not stage or use the network");
    };
    expect(await run([
      "install", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      planId: preview.planId,
      record: {
        status: "installed",
        destination,
        provenance: { candidateId: "testing-available" }
      },
      refresh: { status: "completed" },
      warnings: []
    });
    expect(await exists(destination)).toBe(true);
    expect(await stagingEntries(current.stateDir)).toEqual([]);
    await expect(access(join(current.stateDir, "reviewed-plans", `${preview.planId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(current.stageCalls()).toBe(1);

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
  });

  it("rejects ambiguous or incomplete modes before staging or mutation", async () => {
    expect(await run([...previewArgs(), "--confirm"], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_REQUIRED.*--plan/is);
    expect(current.stageCalls()).toBe(0);
    expect(await stagingEntries(current.stateDir)).toEqual([]);

    expect(await run(["install", "--plan", "missing-plan"], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_CONFIRMATION_REQUIRED/is);

    expect(await run([
      ...previewArgs(), "--plan", "missing-plan", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_AMBIGUOUS/is);
    expect(current.stageCalls()).toBe(0);
  });

  it("prints exact changes, expiry, and a copyable plan confirmation command for humans", async () => {
    expect(await run(previewArgs().filter((arg) => arg !== "--json"), current.context)).toBe(0);
    const output = current.stdout.join("");
    expect(output).toMatch(/Status: ready/);
    expect(output).toMatch(/- create .*testing-review/);
    expect(output).toMatch(/Plan ID: [a-f0-9-]+/);
    expect(output).toContain("Expires: 2026-07-03T00:05:00.000Z");
    expect(output).toMatch(/Apply: skill-steward install --plan [a-f0-9-]+ --confirm/);
    expect(output).not.toContain("https://example.com");
  });

  it("does not retain staging or offer apply for conflict and noop previews", async () => {
    const destination = join(current.base, ".agents", "skills", "testing-review");
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, "SKILL.md"),
      "---\nname: testing-review\ndescription: Different content\n---\n"
    );

    expect(await run(previewArgs(), current.context)).toBe(0);
    const conflict = JSON.parse(current.stdout.splice(0).join(""));
    expect(conflict).toMatchObject({ status: "conflict", action: "cancel" });
    expect(conflict).not.toHaveProperty("planId");
    expect(conflict).not.toHaveProperty("applyCommand");
    expect(await stagingEntries(current.stateDir)).toEqual([]);

    await rm(destination, { recursive: true });
    await cp(current.candidateDirectory, destination, { recursive: true });
    expect(await run(previewArgs(), current.context)).toBe(0);
    const noop = JSON.parse(current.stdout.splice(0).join(""));
    expect(noop).toMatchObject({ status: "noop", action: "none" });
    expect(noop).not.toHaveProperty("planId");
    expect(noop).not.toHaveProperty("applyCommand");
    expect(await stagingEntries(current.stateDir)).toEqual([]);
  });

  it.each(["source", "destination"] as const)(
    "consumes the reviewed plan, removes staging, and refuses %s drift",
    async (kind) => {
      expect(await run(previewArgs(), current.context)).toBe(0);
      const preview = JSON.parse(current.stdout.splice(0).join(""));
      const stored = await storedPlan(current.stateDir, preview.planId);
      if (kind === "source") {
        await writeFile(join(stored.payload.plan.source, "SKILL.md"), "changed", "utf8");
      } else {
        await mkdir(stored.payload.plan.destination, { recursive: true });
        await writeFile(join(stored.payload.plan.destination, "SKILL.md"), "changed", "utf8");
      }

      expect(await run([
        "install", "--plan", preview.planId, "--confirm"
      ], current.context)).toBe(1);
      expect(current.stderr.splice(0).join(""))
        .toMatch(new RegExp(`${kind.toUpperCase()}_DRIFT.*consumed.*fresh reviewed plan`, "is"));
      expect(await stagingEntries(current.stateDir)).toEqual([]);
      await expect(access(join(current.stateDir, "reviewed-plans", `${preview.planId}.json`)))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readInstallationHistory(current.stateDir)).toEqual([]);
    }
  );

  it("rejects a schema-valid destination and changes tampered outside the reviewed route", async () => {
    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const path = join(current.stateDir, "reviewed-plans", `${preview.planId}.json`);
    const stored = await storedPlan(current.stateDir, preview.planId);
    const outside = join(current.base, "outside", "tampered-skill");
    stored.payload.plan.destination = outside;
    stored.payload.plan.changes = [{ operation: "create", path: outside }];
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_INVALID.*consumed.*fresh reviewed plan/is);
    await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingEntries(current.stateDir)).toEqual([]);
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
  });

  it("rejects a destination ancestor replaced by a symlink after preview", async () => {
    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const outside = join(current.base, "outside-destination");
    await mkdir(outside);
    await symlink(outside, join(current.base, ".agents"), "dir");

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/UNSAFE_INSTALL_DESTINATION.*consumed.*fresh reviewed plan/is);
    await expect(access(join(outside, "skills", "testing-review")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingEntries(current.stateDir)).toEqual([]);
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
  });

  it.each([
    {
      harness: "claude",
      scope: "global",
      destination: (base: string) => join(base, ".claude", "skills", "testing-review")
    },
    {
      harness: "github-copilot",
      scope: "project",
      destination: (base: string) => join(base, ".github", "skills", "testing-review")
    }
  ] as const)("applies a bound $scope route for $harness", async ({ harness, scope, destination }) => {
    expect(await run([
      "install",
      "--catalog-candidate", "testing-available",
      "--harness", harness,
      "--scope", scope,
      "--workspace", current.base,
      "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const stored = await storedPlan(current.stateDir, preview.planId);
    expect(stored.payload.route).toEqual({
      harness,
      scope,
      targetName: "testing-review",
      workspace: current.base
    });

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(0);
    await expect(access(destination(current.base))).resolves.toBeUndefined();
  });

  it("strictly rejects tampered payload identity and expires its referenced staging", async () => {
    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const path = join(current.stateDir, "reviewed-plans", `${preview.planId}.json`);
    const stored = await storedPlan(current.stateDir, preview.planId);
    stored.payload.plan.createdAt += 1;
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_INVALID.*consumed.*fresh reviewed plan/is);
    expect(await stagingEntries(current.stateDir)).toEqual([]);
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
  });

  it("binds cleanup and source ownership to the claimed envelope instead of an untrusted preview id", async () => {
    expect(await run(previewArgs(), current.context)).toBe(0);
    const first = JSON.parse(current.stdout.splice(0).join(""));
    const firstStored = await storedPlan(current.stateDir, first.planId);
    expect(await run(previewArgs(), current.context)).toBe(0);
    const second = JSON.parse(current.stdout.splice(0).join(""));
    const secondStored = await storedPlan(current.stateDir, second.planId);

    firstStored.payload.previewId = second.planId;
    await writeFile(
      join(current.stateDir, "reviewed-plans", `${first.planId}.json`),
      `${JSON.stringify(firstStored, null, 2)}\n`,
      { mode: 0o600 }
    );

    expect(await run([
      "install", "--plan", first.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_INVALID.*consumed.*fresh reviewed plan/is);
    expect((await stagingEntries(current.stateDir)).sort()).toEqual([second.planId]);
    await expect(access(firstStored.payload.plan.source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondStored.payload.plan.source)).resolves.toBeUndefined();
    await expect(access(join(current.stateDir, "reviewed-plans", `${second.planId}.json`)))
      .resolves.toBeUndefined();
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
  });

  it.each(["extra-field", "invalid-timestamp"] as const)(
    "preserves the consumed INVALID result for a real %s envelope and deletes only its staging",
    async (tamper) => {
      expect(await run(previewArgs(), current.context)).toBe(0);
      const first = JSON.parse(current.stdout.splice(0).join(""));
      expect(await run(previewArgs(), current.context)).toBe(0);
      const second = JSON.parse(current.stdout.splice(0).join(""));
      const firstPath = join(current.stateDir, "reviewed-plans", `${first.planId}.json`);
      const envelope = JSON.parse(await readFile(firstPath, "utf8")) as Record<string, unknown>;
      if (tamper === "extra-field") envelope.unexpected = true;
      else envelope.createdAt = "not-a-timestamp";
      await writeFile(firstPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });

      expect(await run([
        "install", "--plan", first.planId, "--confirm"
      ], current.context)).toBe(1);
      expect(current.stderr.splice(0).join(""))
        .toMatch(/REVIEWED_PLAN_INVALID.*consumed.*fresh reviewed plan/is);
      await expect(access(join(current.stateDir, "staging", first.planId)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(current.stateDir, "reviewed-plans", `${first.planId}.json`)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(current.stateDir, "staging", second.planId)))
        .resolves.toBeUndefined();
      await expect(access(join(current.stateDir, "reviewed-plans", `${second.planId}.json`)))
        .resolves.toBeUndefined();

      expect(await run([
        "install", "--plan", first.planId, "--confirm"
      ], current.context)).toBe(1);
      const secondAttempt = current.stderr.splice(0).join("");
      expect(secondAttempt).toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
      expect(secondAttempt).not.toMatch(/consumed/i);
      expect(await readInstallationHistory(current.stateDir)).toEqual([]);
    }
  );

  it("keeps a committed installation successful when portfolio refresh fails", async () => {
    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const stored = await storedPlan(current.stateDir, preview.planId);
    await mkdir(join(current.stateDir, "latest-report.json"));

    expect(await run([
      "install", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      planId: preview.planId,
      record: { status: "installed", destination: stored.payload.plan.destination },
      refresh: { status: "failed", recoveryCommand: "skill-steward scan" },
      warnings: [{
        code: "PORTFOLIO_REFRESH_FAILED",
        recoveryCommand: "skill-steward scan"
      }]
    });
    expect(current.stderr.join(""))
      .toMatch(/PORTFOLIO_REFRESH_FAILED.*skill-steward scan/is);
    expect(await exists(stored.payload.plan.destination)).toBe(true);
    expect(await readInstallationHistory(current.stateDir)).toHaveLength(1);
    expect(await stagingEntries(current.stateDir)).toEqual([]);
  });

  it("rejects wrong-kind and expired plans without applying", async () => {
    await writeReviewedPlan(current.stateDir, {
      schemaVersion: 1,
      id: "wrong-kind",
      kind: "governance",
      createdAt: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-03T00:05:00.000Z",
      payload: {}
    });
    expect(await run([
      "install", "--plan", "wrong-kind", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_KIND_MISMATCH.*consumed.*fresh reviewed plan/is);

    expect(await run(previewArgs(), current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    current.setNow(new Date("2026-07-03T00:06:00.000Z"));
    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_EXPIRED.*consumed.*fresh reviewed plan/is);
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
    expect(await stagingEntries(current.stateDir)).toEqual([]);

    expect(await run([
      "install", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    const secondAttempt = current.stderr.splice(0).join("");
    expect(secondAttempt).toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
    expect(secondAttempt).not.toMatch(/consumed/i);
  });

  it("reports a genuinely missing plan without consuming or deleting live staging", async () => {
    const missingPlanId = "80134d11-b27c-4b32-8321-2bb4b96e3957";
    const sameNameStaging = await new StagingRegistry({
      stateDirectory: current.stateDir,
      now: () => current.context.now!().getTime(),
      id: () => missingPlanId
    }).create({ ttlMs: 5 * 60_000 });
    expect(await run(previewArgs(), current.context)).toBe(0);
    const other = JSON.parse(current.stdout.splice(0).join(""));

    expect(await run([
      "install", "--plan", missingPlanId, "--confirm"
    ], current.context)).toBe(1);
    const error = current.stderr.splice(0).join("");
    expect(error).toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
    expect(error).not.toMatch(/consumed/i);
    await expect(access(sameNameStaging.directory)).resolves.toBeUndefined();
    await expect(access(join(current.stateDir, "staging", other.planId)))
      .resolves.toBeUndefined();
    await expect(access(join(current.stateDir, "reviewed-plans", `${other.planId}.json`)))
      .resolves.toBeUndefined();
  });

  it.each(["preview", "apply"] as const)(
    "opportunistically removes expired orphan staging on %s entry",
    async (mode) => {
      expect(await run(previewArgs(), current.context)).toBe(0);
      const preview = JSON.parse(current.stdout.splice(0).join(""));
      await unlink(join(current.stateDir, "reviewed-plans", `${preview.planId}.json`));
      current.setNow(new Date("2026-07-03T00:06:00.000Z"));

      const args = mode === "preview"
        ? [
            "install",
            "--catalog-candidate", "missing-candidate",
            "--harness", "codex",
            "--scope", "global"
          ]
        : ["install", "--plan", "missing-plan", "--confirm"];
      expect(await run(args, current.context)).toBe(1);
      expect(await stagingEntries(current.stateDir)).toEqual([]);
    }
  );

  it("isolates concurrent help output in each injected context", async () => {
    const otherStdout: string[] = [];
    const otherStderr: string[] = [];
    const otherContext: CliContext = {
      ...current.context,
      stdout: (value) => otherStdout.push(value),
      stderr: (value) => otherStderr.push(value)
    };
    const { run: runCli } = await import("../src/main.js");

    const [installExitCode, preflightExitCode] = await Promise.all([
      runCli(["install", "--help"], current.context),
      runCli(["preflight", "--help"], otherContext)
    ]);

    expect(installExitCode).toBe(0);
    expect(preflightExitCode).toBe(0);
    const help = current.stdout.join("");
    expect(help).toContain(
      "Preview: --catalog-candidate <id> --harness <id> --scope <scope>"
    );
    expect(help).toContain("Apply: --plan <id> --confirm");
    expect(help).toMatch(/--catalog-candidate <id>\s+catalog candidate ID to preview/);
    expect(help).toMatch(/--harness <id>\s+target Harness for preview/);
    expect(help).toMatch(/--workspace <path>\s+project workspace path/);
    expect(help).toMatch(/--target-name <name>\s+installed directory name/);
    expect(help).not.toContain("Usage: skill-steward preflight");
    expect(otherStdout.join("")).toContain("Usage: skill-steward preflight");
    expect(otherStdout.join("")).not.toContain("Usage: skill-steward install");
    expect(current.stderr).toEqual([]);
    expect(otherStderr).toEqual([]);
  });

  it("rejects provenance that does not name an explicit recommendation and cleans staging", async () => {
    expect(await run([
      "install",
      "--catalog-candidate", "testing-available",
      "--harness", "codex",
      "--scope", "global",
      "--preflight", "missing"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("PREFLIGHT_NOT_FOUND");
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
    expect(await stagingEntries(current.stateDir)).toEqual([]);
  });

  it("escapes untrusted request text in terminal errors", async () => {
    expect(await run([
      "install",
      "--catalog-candidate", "missing\u001b[2J",
      "--harness", "codex",
      "--scope", "global"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).not.toContain("\u001b");
    expect(current.stderr.join("")).toContain("\\u{001b}");
  });
});
