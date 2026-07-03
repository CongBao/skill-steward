import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintDirectory,
  readInstallationHistory
} from "@skill-steward/installer";
import {
  writeCatalogSnapshot,
  writeCatalogSources
} from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "steward-catalog-install-"));
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
    url: "https://example.com/skills.git",
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
  const context: CliContext = {
    cwd: base,
    home: base,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    catalogStage: async (destination) => {
      const staged = join(destination, "source");
      await cp(candidateDirectory, staged, { recursive: true });
      return { sourceDirectory: staged, commitSha: "a".repeat(40) };
    },
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  return { base, stateDir, stdout, stderr, context };
}

describe("catalog install command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("prints an exact plan without mutation, then installs after confirmation", async () => {
    const destination = join(current.base, ".agents", "skills", "testing-review");
    const args = [
      "install",
      "--catalog-candidate", "testing-available",
      "--harness", "codex",
      "--scope", "global",
      "--preflight", "run-1",
      "--json"
    ];
    expect(await run(args, current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      status: "ready",
      action: "create",
      destination
    });
    expect(await exists(destination)).toBe(false);

    expect(await run([...args, "--confirm"], current.context)).toBe(0);
    expect(await exists(destination)).toBe(true);
    expect(await readInstallationHistory(current.stateDir)).toEqual([
      expect.objectContaining({
        status: "installed",
        destination,
        provenance: {
          preflightId: "run-1",
          candidateId: "testing-available",
          sourceId: "fixture-catalog",
          sourceRevision: "a".repeat(40)
        }
      })
    ]);
    expect(await readFile(join(current.stateDir, "installations.jsonl"), "utf8"))
      .not.toContain("https://example.com");
  });

  it("requires replace for a differing destination", async () => {
    const destination = join(current.base, ".agents", "skills", "testing-review");
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, "SKILL.md"),
      "---\nname: testing-review\ndescription: Different content\n---\n"
    );
    const baseArgs = [
      "install",
      "--catalog-candidate", "testing-available",
      "--harness", "codex",
      "--scope", "global",
      "--confirm"
    ];
    expect(await run(baseArgs, current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("PLAN_NOT_COMMITTABLE");
    expect(await run([...baseArgs, "--replace"], current.context)).toBe(0);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain(
      "Find missing tests"
    );
  });

  it("rejects provenance that does not name an explicit recommendation", async () => {
    expect(await run([
      "install",
      "--catalog-candidate", "testing-available",
      "--harness", "codex",
      "--scope", "global",
      "--preflight", "missing",
      "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("PREFLIGHT_NOT_FOUND");
    expect(await readInstallationHistory(current.stateDir)).toEqual([]);
  });
});
