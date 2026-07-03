import { access, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "steward-integrate-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: home,
    home,
    stateDir: join(home, "state"),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now: () => new Date("2026-07-03T00:00:00.000Z")
  };
  return { home, stdout, stderr, context };
}

describe("integrate command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("plans without mutation and applies only with explicit confirmation", async () => {
    const config = join(current.home, ".codex", "hooks.json");
    const skill = join(current.home, ".agents", "skills", "skill-steward-preflight", "SKILL.md");
    expect(await run([
      "integrate", "plan", "--harness", "codex", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      harness: "codex",
      changes: expect.arrayContaining([expect.objectContaining({ operation: "write" })])
    });
    expect(await exists(config)).toBe(false);
    expect(await exists(skill)).toBe(false);

    expect(await run([
      "integrate", "apply", "--harness", "codex"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("--confirm");
    expect(await run([
      "integrate", "apply", "--harness", "codex", "--confirm"
    ], current.context)).toBe(0);
    expect(await readFile(config, "utf8")).toContain(
      "skill-steward hook prompt --harness codex"
    );
    expect(await readFile(skill, "utf8")).toContain("name: skill-steward-preflight");
    current.stdout.splice(0);
    expect(await run([
      "integrate", "status", "--harness", "codex", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({ status: "needs-trust" });
  });

  it("retains the shared Skill while another Harness is active", async () => {
    for (const harness of ["codex", "claude-code", "github-copilot"]) {
      expect(await run([
        "integrate", "apply", "--harness", harness, "--confirm"
      ], current.context)).toBe(0);
    }
    const skillDirectory = join(current.home, ".agents", "skills", "skill-steward-preflight");
    expect(await run([
      "integrate", "remove", "--harness", "codex", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(true);
    expect(await run([
      "integrate", "remove", "--harness", "claude-code", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(true);
    expect(await run([
      "integrate", "remove", "--harness", "github-copilot", "--confirm"
    ], current.context)).toBe(0);
    expect(await exists(skillDirectory)).toBe(false);
  });

  it("reports all three native integration capability adapters by default", async () => {
    expect(await run(["integrate", "status", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join("")).map(({ harness }: { harness: string }) => harness))
      .toEqual(["codex", "claude-code", "github-copilot"]);
  });

  it("refuses a different existing companion Skill before changing Harness config", async () => {
    const skill = join(current.home, ".agents", "skills", "skill-steward-preflight", "SKILL.md");
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, "different", "utf8");
    expect(await run([
      "integrate", "apply", "--harness", "codex", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("SHARED_SKILL_CONFLICT");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
  });
});
