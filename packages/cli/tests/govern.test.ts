import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill } from "@skill-steward/engine";
import { readLatestReport, writeLatestReport } from "@skill-steward/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/context.js";

async function run(argv: string[], context: CliContext): Promise<number> {
  vi.resetModules();
  return (await import("../src/main.js")).run(argv, context);
}

async function storedPlan(stateDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    join(stateDir, "reviewed-plans", `${id}.json`),
    "utf8"
  )) as Record<string, unknown>;
}

type PlanIdentityField = "id" | "createdAt" | "expiresAt";

async function tamperPayloadIdentity(
  stateDir: string,
  id: string,
  field: PlanIdentityField
): Promise<void> {
  const path = join(stateDir, "reviewed-plans", `${id}.json`);
  const envelope = await storedPlan(stateDir, id);
  const payload = envelope.payload as Record<string, unknown>;
  payload[field] = field === "id"
    ? `${String(payload[field])}-tampered`
    : new Date(Date.parse(String(payload[field])) - 60_000).toISOString();
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

async function makeLatestReportUnwritable(stateDir: string): Promise<void> {
  const path = join(stateDir, "latest-report.json");
  await unlink(path);
  await mkdir(path);
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "steward-cli-govern-")));
  const home = join(base, "home");
  const activeRoot = join(home, ".agents", "skills");
  const activePath = join(activeRoot, "review-skill");
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

  it("applies exact persisted quarantine and restore plans across separate runs", async () => {
    const quarantine = [
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ];
    expect(await run(quarantine, current.context)).toBe(0);
    const plan = JSON.parse(current.stdout.splice(0).join(""));
    expect(plan).toMatchObject({
      kind: "quarantine",
      skillId: current.parsed.id,
      activePath: current.activePath,
      operations: expect.any(Array),
      planId: expect.any(String),
      expiresAt: "2026-07-03T00:11:00.000Z",
      applyCommand: expect.stringMatching(/^skill-steward govern quarantine --plan \S+ --confirm$/)
    });
    expect(await storedPlan(current.stateDir, plan.planId)).toMatchObject({
      id: plan.planId,
      kind: "governance",
      payload: { kind: "quarantine", skillId: current.parsed.id }
    });
    await expect(access(current.activePath)).resolves.toBeUndefined();

    const report = await readLatestReport(current.stateDir);
    if (!report) throw new Error("fixture report missing");
    await writeLatestReport(current.stateDir, { ...report, skills: [] });
    expect(await run([
      "govern", "quarantine", "--plan", plan.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    const applied = JSON.parse(current.stdout.splice(0).join(""));
    expect(applied).toMatchObject({
      rescanRequired: true,
      transaction: {
        action: "quarantine",
        status: "quarantined",
        skillId: current.parsed.id
      }
    });
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLatestReport(current.stateDir))?.skills).toEqual([]);

    expect(await run(["govern", "history", "--json"], current.context)).toBe(0);
    const [transaction] = JSON.parse(current.stdout.splice(0).join(""));
    expect(transaction).toMatchObject({
      status: "quarantined",
      skillId: current.parsed.id
    });

    const restore = [
      "govern", "restore", "--transaction", transaction.id, "--json"
    ];
    expect(await run(restore, current.context)).toBe(0);
    const restorePlan = JSON.parse(current.stdout.splice(0).join(""));
    expect(restorePlan).toMatchObject({
      kind: "restore",
      skillId: current.parsed.id,
      planId: expect.any(String),
      applyCommand: expect.stringMatching(/^skill-steward govern restore --plan \S+ --confirm$/)
    });
    expect(await storedPlan(current.stateDir, restorePlan.planId)).toMatchObject({
      kind: "governance",
      payload: { kind: "restore", sourceTransactionId: transaction.id }
    });
    await tamperPayloadIdentity(current.stateDir, restorePlan.planId, "id");
    expect(await run([
      "govern", "restore", "--plan", restorePlan.planId, "--confirm", "--json"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_INVALID.*fresh reviewed plan/is);
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await run(restore, current.context)).toBe(0);
    const replacementRestorePlan = JSON.parse(current.stdout.splice(0).join(""));
    expect(await run([
      "govern", "restore", "--plan", replacementRestorePlan.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      transaction: {
        action: "restore",
        status: "restored",
        skillId: current.parsed.id
      }
    });
    await expect(access(current.activePath)).resolves.toBeUndefined();
    expect((await readLatestReport(current.stateDir))?.skills).toEqual([
      expect.objectContaining({ id: current.parsed.id })
    ]);

    expect(await run(["govern", "delete", "--skill", current.parsed.id], current.context)).toBe(1);
  });

  it("uses the Skill display name in human governance output", async () => {
    const quarantine = ["govern", "quarantine", "--skill", current.parsed.id];

    expect(await run(quarantine, current.context)).toBe(0);
    const quarantinePreview = current.stdout.splice(0).join("");
    expect(quarantinePreview.split("\n")[0])
      .toBe("Governance plan: quarantine review");
    const quarantinePlanId = quarantinePreview.match(/^Plan ID: (\S+)$/m)?.[1];
    expect(quarantinePlanId).toBeTruthy();
    expect(quarantinePreview).toContain(
      `Apply: skill-steward govern quarantine --plan ${quarantinePlanId} --confirm`
    );

    expect(await run([
      "govern", "quarantine", "--plan", quarantinePlanId as string, "--confirm"
    ], current.context)).toBe(0);
    const quarantineOutput = current.stdout.splice(0).join("");
    const quarantineTransactionId = quarantineOutput.match(/^Quarantined 'review' \(([^)]+)\)\./m)?.[1];
    expect(quarantineTransactionId).toBeTruthy();
    expect(quarantineOutput).toMatch(/^Plan ID: \S+$/m);

    expect(await run(["govern", "history"], current.context)).toBe(0);
    expect(current.stdout.splice(0).join("").trim().split("\n")).toContain(
      `${quarantineTransactionId}: quarantine review (quarantined)`
    );

    const restore = [
      "govern", "restore", "--transaction", quarantineTransactionId as string
    ];
    expect(await run(restore, current.context)).toBe(0);
    const restorePreview = current.stdout.splice(0).join("");
    expect(restorePreview.split("\n")[0])
      .toBe("Governance plan: restore review");
    const restorePlanId = restorePreview.match(/^Plan ID: (\S+)$/m)?.[1];
    expect(restorePlanId).toBeTruthy();

    expect(await run([
      "govern", "restore", "--plan", restorePlanId as string, "--confirm"
    ], current.context)).toBe(0);
    const restoreOutput = current.stdout.splice(0).join("");
    const restoreTransactionId = restoreOutput.match(/^Restored Skill 'review' \(([^)]+)\)\./m)?.[1];
    expect(restoreTransactionId).toBeTruthy();
    expect(restoreOutput).toMatch(/^Plan ID: \S+$/m);

    expect(await run(["govern", "history"], current.context)).toBe(0);
    expect(current.stdout.splice(0).join("").trim().split("\n")).toEqual(expect.arrayContaining([
      `${quarantineTransactionId}: quarantine review (quarantined)`,
      `${restoreTransactionId}: restore review (restored)`
    ]));
  });

  it("returns a typed error for an unknown Skill", async () => {
    expect(await run([
      "govern", "quarantine", "--skill", "missing"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("SKILL_NOT_FOUND");
    await expect(access(current.activePath)).resolves.toBeUndefined();
  });

  it("escapes terminal control characters in reviewed governance output", async () => {
    const report = await readLatestReport(current.stateDir);
    if (!report) throw new Error("fixture report missing");
    await writeLatestReport(current.stateDir, {
      ...report,
      skills: report.skills.map((skill) => ({
        ...skill,
        name: "trusted\u001b[2J\nspoof"
      }))
    });

    expect(await run([
      "govern", "quarantine", "--skill", current.parsed.id
    ], current.context)).toBe(0);

    const output = current.stdout.join("");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("trusted\\u{001b}[2J\\u{000a}spoof");
  });

  it("refuses missing confirmation inputs and ambiguous governance apply options", async () => {
    for (const args of [
      ["govern", "quarantine", "--confirm"],
      ["govern", "restore", "--confirm"]
    ]) {
      expect(await run(args, current.context)).toBe(1);
      expect(current.stderr.splice(0).join("")).toMatch(/preview/i);
      await expect(access(current.activePath)).resolves.toBeUndefined();
    }

    for (const args of [
      ["govern", "quarantine", "--plan", "missing"],
      ["govern", "restore", "--plan", "missing"]
    ]) {
      expect(await run(args, current.context)).toBe(1);
      const error = current.stderr.splice(0).join("");
      expect(error).toMatch(/--confirm/i);
      expect(error).not.toMatch(/new preview|fresh reviewed plan|preview command again/i);
      await expect(access(current.activePath)).resolves.toBeUndefined();
    }

    expect(await run([
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    expect(await run([
      "govern", "quarantine",
      "--plan", preview.planId,
      "--confirm",
      "--skill", current.parsed.id
    ], current.context)).toBe(1);
    const ambiguousError = current.stderr.splice(0).join("");
    expect(ambiguousError).toMatch(/ambiguous/i);
    expect(ambiguousError).not.toMatch(/new preview|fresh reviewed plan|preview command again/i);
    await expect(access(current.activePath)).resolves.toBeUndefined();

    expect(await run([
      "govern", "quarantine", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects every quarantine payload identity mismatch before mutation", async () => {
    for (const field of ["id", "createdAt", "expiresAt"] as const) {
      expect(await run([
        "govern", "quarantine", "--skill", current.parsed.id, "--json"
      ], current.context)).toBe(0);
      const preview = JSON.parse(current.stdout.splice(0).join(""));
      await tamperPayloadIdentity(current.stateDir, preview.planId, field);

      expect(await run([
        "govern", "quarantine", "--plan", preview.planId, "--confirm"
      ], current.context)).toBe(1);
      expect(current.stderr.splice(0).join(""))
        .toMatch(/REVIEWED_PLAN_INVALID.*fresh reviewed plan/is);
      await expect(access(current.activePath)).resolves.toBeUndefined();
    }
  });

  it("reports a committed quarantine when the post-commit JSON refresh fails", async () => {
    expect(await run([
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    await makeLatestReportUnwritable(current.stateDir);

    expect(await run([
      "govern", "quarantine", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    const output = JSON.parse(current.stdout.splice(0).join(""));
    expect(output).toMatchObject({
      planId: preview.planId,
      transaction: { action: "quarantine", status: "quarantined" },
      refresh: { status: "failed", recoveryCommand: "skill-steward scan" },
      warnings: [{
        code: "PORTFOLIO_REFRESH_FAILED",
        recoveryCommand: "skill-steward scan"
      }]
    });
    expect(current.stdout).toEqual([]);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/PORTFOLIO_REFRESH_FAILED.*skill-steward scan/is);
    await expect(access(current.activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a committed restore when the post-commit human refresh fails", async () => {
    expect(await run([
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ], current.context)).toBe(0);
    const quarantinePlan = JSON.parse(current.stdout.splice(0).join(""));
    expect(await run([
      "govern", "quarantine", "--plan", quarantinePlan.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    const quarantine = JSON.parse(current.stdout.splice(0).join(""));

    expect(await run([
      "govern", "restore", "--transaction", quarantine.transaction.id, "--json"
    ], current.context)).toBe(0);
    const restorePlan = JSON.parse(current.stdout.splice(0).join(""));
    await makeLatestReportUnwritable(current.stateDir);

    expect(await run([
      "govern", "restore", "--plan", restorePlan.planId, "--confirm"
    ], current.context)).toBe(0);
    const output = current.stdout.splice(0).join("");
    expect(output).toMatch(/^Restored Skill 'review' \([^)]+\)\./m);
    expect(output).toContain(`Plan ID: ${restorePlan.planId}`);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/PORTFOLIO_REFRESH_FAILED.*skill-steward scan/is);
    await expect(access(current.activePath)).resolves.toBeUndefined();
  });

  it("preserves governance drift checks for a claimed exact plan", async () => {
    expect(await run([
      "govern", "quarantine", "--skill", current.parsed.id, "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    await writeFile(join(current.activePath, "SKILL.md"), [
      "---",
      "name: review",
      "description: changed after preview",
      "---",
      ""
    ].join("\n"));

    expect(await run([
      "govern", "quarantine", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/SOURCE_DRIFT.*consumed.*fresh reviewed plan/is);
    await expect(access(current.activePath)).resolves.toBeUndefined();

    expect(await run([
      "govern", "quarantine", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
  });
});
