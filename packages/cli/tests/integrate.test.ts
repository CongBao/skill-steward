import { access, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLatestReport } from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { integrateApplyCommand } from "../src/commands/integrate.js";
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
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "recommend a preflight skill",
      cwd: home
    })
  };
  return { home, stdout, stderr, context };
}

describe("integrate command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  async function preview(harness: string) {
    const code = await run([
      "integrate", "plan", "--harness", harness, "--json"
    ], current.context);
    expect(code, current.stderr.splice(0).join("")).toBe(0);
    return JSON.parse(current.stdout.splice(0).join("")) as {
      id: string;
      expiresAt: string;
      changes: Array<{ operation: string; path: string }>;
      applyCommand: string;
    };
  }

  async function apply(planId: string, json = false) {
    const code = await run([
      "integrate", "apply", "--plan", planId, "--confirm",
      ...(json ? ["--json"] : [])
    ], current.context);
    current.stdout.splice(0);
    return code;
  }

  it("persists an exact plan across calls and prepares the first prompt Hook", async () => {
    const config = join(current.home, ".codex", "hooks.json");
    const skill = join(current.home, ".agents", "skills", "skill-steward-preflight", "SKILL.md");
    const plan = await preview("codex");
    expect(plan).toMatchObject({
      changes: expect.arrayContaining([expect.objectContaining({ operation: "write" })]),
      applyCommand: `skill-steward integrate apply --plan ${plan.id} --confirm`
    });
    expect(plan.expiresAt).toBe("2026-07-03T00:10:00.000Z");
    expect(await exists(config)).toBe(false);
    expect(await exists(skill)).toBe(false);

    expect(await run([
      "integrate", "apply", "--plan", plan.id
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("--confirm");
    expect(await apply(plan.id, true)).toBe(0);
    expect(await readFile(config, "utf8")).toContain(
      "skill-steward hook prompt --harness codex"
    );
    expect(await readFile(skill, "utf8")).toContain("name: skill-steward-preflight");
    expect(await readLatestReport(current.context.stateDir)).toBeDefined();
    current.stdout.splice(0);
    expect(await run(["hook", "prompt", "--harness", "codex"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toHaveProperty("hookSpecificOutput");
    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_NOT_FOUND");
    current.stdout.splice(0);
    expect(await run([
      "integrate", "status", "--harness", "codex", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({ status: "needs-trust" });
  });

  it("retains the shared Skill while another Harness is active", async () => {
    for (const harness of ["codex", "claude-code", "github-copilot"]) {
      expect(await apply((await preview(harness)).id)).toBe(0);
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
    const plan = await preview("codex");
    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.join("")).toContain("SHARED_SKILL_CONFLICT");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
  });

  it("refuses ambiguous raw apply inputs and confirmation without a plan", async () => {
    expect(await run([
      "integrate", "apply", "--harness", "codex", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("--plan");
    const plan = await preview("codex");
    expect(await run([
      "integrate", "apply", "--plan", plan.id, "--harness", "codex", "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("ambiguous");
  });

  it("consumes drifted and expired plans without regenerating them", async () => {
    const config = join(current.home, ".codex", "hooks.json");
    const drifted = await preview("codex");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, '{"external":true}\n', "utf8");
    expect(await apply(drifted.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("consumed");
    expect(await readFile(config, "utf8")).toBe('{"external":true}\n');
    expect(await apply(drifted.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_NOT_FOUND");

    const claude = await preview("claude-code");
    current.context.now = () => new Date("2026-07-03T00:10:00.000Z");
    expect(await apply(claude.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_EXPIRED");
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses wrong-kind and tampered stored payloads without mutation", async () => {
    const wrongKind = await preview("codex");
    const wrongKindPath = join(
      current.context.stateDir, "reviewed-plans", `${wrongKind.id}.json`
    );
    const wrongEnvelope = JSON.parse(await readFile(wrongKindPath, "utf8"));
    await writeFile(wrongKindPath, `${JSON.stringify({
      ...wrongEnvelope,
      kind: "governance"
    })}\n`, "utf8");
    expect(await apply(wrongKind.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("REVIEWED_PLAN_KIND_MISMATCH");

    const tampered = await preview("codex");
    const tamperedPath = join(
      current.context.stateDir, "reviewed-plans", `${tampered.id}.json`
    );
    const tamperedEnvelope = JSON.parse(await readFile(tamperedPath, "utf8"));
    tamperedEnvelope.payload.targetPath = join(current.home, ".claude", "settings.json");
    await writeFile(tamperedPath, `${JSON.stringify(tamperedEnvelope)}\n`, "utf8");
    expect(await apply(tampered.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("consumed");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(false);
  });

  it("rolls back only artifacts created by an apply whose readiness scan fails", async () => {
    const plan = await preview("codex");
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(plan.id)).toBe(1);
    const error = current.stderr.splice(0).join("");
    expect(error).toContain("INTEGRATION_READINESS_FAILED");
    expect(error).toContain("rolled back");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(false);
  });

  it("removes a newly created companion after a journal failure without rereading it", async () => {
    const plan = await preview("codex");
    await mkdir(join(current.context.stateDir, "integrations.json"));

    expect(await apply(plan.id)).toBe(1);
    expect(current.stderr.splice(0).join("")).toContain("EISDIR");
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(false);
  });

  it("reports typed incomplete rollback when companion cleanup cannot be proven", async () => {
    const plan = await preview("codex");
    await mkdir(join(current.context.stateDir, "integrations.json"));

    expect(await integrateApplyCommand({
      plan: plan.id,
      confirm: true,
      json: false
    }, current.context, {
      removeCompanion: async () => false
    })).toBe(1);
    const error = current.stderr.splice(0).join("");
    expect(error).toContain("INTEGRATION_ROLLBACK_FAILED");
    expect(error).toContain("EISDIR");
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });

  it("preserves a pre-existing companion and integration during failed readiness", async () => {
    const claude = await preview("claude-code");
    expect(await apply(claude.id)).toBe(0);
    current.stdout.splice(0);
    const companion = join(current.home, ".agents", "skills", "skill-steward-preflight");
    const codex = await preview("codex");
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(codex.id)).toBe(1);
    expect(await exists(companion)).toBe(true);
    expect(await exists(join(current.home, ".claude", "settings.json"))).toBe(true);
    expect(await exists(join(current.home, ".codex", "hooks.json"))).toBe(false);
  });

  it("preserves a no-op pre-existing integration when readiness fails", async () => {
    const first = await preview("codex");
    expect(await apply(first.id)).toBe(0);
    current.stdout.splice(0);
    const config = join(current.home, ".codex", "hooks.json");
    const before = await readFile(config, "utf8");
    const noop = await preview("codex");
    expect(noop.changes).toEqual([]);
    await writeFile(join(current.context.stateDir, "latest-report.json"), "not-json", "utf8");
    expect(await apply(noop.id)).toBe(1);
    expect(await readFile(config, "utf8")).toBe(before);
    expect(await exists(join(
      current.home, ".agents", "skills", "skill-steward-preflight"
    ))).toBe(true);
  });
});
