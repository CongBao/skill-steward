import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill } from "@skill-steward/engine";
import { readLatestReport, writeLatestReport } from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-cli-govern-")));
  const home = join(base, "home");
  const activeRoot = join(home, ".agents", "skills");
  const activePath = join(activeRoot, "review");
  const stateDir = join(base, "state");
  await mkdir(activePath, { recursive: true });
  await mkdir(stateDir);
  await writeFile(
    join(activePath, "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n"
  );
  const parsed = await parseSkill({
    path: activePath,
    roots: [{ path: activeRoot, scope: "global", visibleTo: ["codex", "agents", "github-copilot"] }]
  });
  await writeLatestReport(stateDir, {
    schemaVersion: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [{
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      path: parsed.path,
      root: parsed.root,
      scope: parsed.scope,
      visibleTo: parsed.visibleTo,
      fingerprint: parsed.fingerprint,
      files: parsed.files,
      estimatedTokens: parsed.estimatedTokens
    }],
    findings: []
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: base,
    home,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now: () => new Date("2026-07-03T00:01:00.000Z")
  };
  return { base, home, activePath, stateDir, parsed, stdout, stderr, context };
}

describe("govern command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("reviews, quarantines, lists, and restores without a delete action", async () => {
    const quarantine = [
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ];
    expect(await run(quarantine, current.context)).toBe(0);
    const plan = JSON.parse(current.stdout.splice(0).join(""));
    expect(plan).toMatchObject({
      kind: "quarantine",
      activePath: current.activePath,
      operations: expect.any(Array)
    });
    await expect(access(current.activePath)).resolves.toBeUndefined();

    expect(await run([...quarantine, "--confirm"], current.context)).toBe(0);
    const applied = JSON.parse(current.stdout.splice(0).join(""));
    expect(applied).toMatchObject({
      rescanRequired: true,
      transaction: { action: "quarantine", status: "quarantined" }
    });
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLatestReport(current.stateDir))?.skills).toEqual([]);

    expect(await run(["govern", "history", "--json"], current.context)).toBe(0);
    const [transaction] = JSON.parse(current.stdout.splice(0).join(""));
    expect(transaction).toMatchObject({ status: "quarantined" });

    const restore = [
      "govern", "restore", "--transaction", transaction.id, "--json"
    ];
    expect(await run(restore, current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({ kind: "restore" });
    expect(await run([...restore, "--confirm"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      transaction: { action: "restore", status: "restored" }
    });
    await expect(access(current.activePath)).resolves.toBeUndefined();
    expect((await readLatestReport(current.stateDir))?.skills).toEqual([
      expect.objectContaining({ id: current.parsed.id })
    ]);

    expect(await run(["govern", "delete", "--skill", current.parsed.id], current.context)).toBe(1);
  });

  it("returns a typed error for an unknown Skill", async () => {
    expect(await run([
      "govern", "quarantine", "--skill", "missing", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("SKILL_NOT_FOUND");
    await expect(access(current.activePath)).resolves.toBeUndefined();
  });
});
