import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInstallationRecord } from "@skill-steward/installer";
import {
  appendEvidenceEvent,
  readEvidencePolicy,
  readNormalizedPreflightEvidence
} from "@skill-steward/store";
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

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "steward-cli-evidence-"));
  const stateDir = join(base, "state");
  await mkdir(stateDir);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: base,
    home: base,
    stateDir,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now: () => new Date("2026-07-03T01:00:00.000Z")
  };
  return { base, stateDir, stdout, stderr, context };
}

async function seedEvidence(stateDir: string): Promise<void> {
  await writeFile(join(stateDir, "preflights.json"), `${JSON.stringify({
    schemaVersion: 3,
    records: [{
      schemaVersion: 3,
      id: "run-1",
      createdAt: "2026-07-03T00:00:00.000Z",
      portfolioFingerprint: `sha256:${"a".repeat(64)}`,
      taskHash: `sha256:${"b".repeat(64)}`,
      taskCharacterCount: 20,
      taskTermCount: 3,
      algorithmVersion: 2,
      harness: "codex",
      candidateIds: ["testing"],
      useCandidateIds: [],
      installCandidateIds: ["testing"],
      feedback: {
        schemaVersion: 1,
        preflightId: "run-1",
        recordedAt: "2026-07-03T00:30:00.000Z",
        label: "useful",
        candidateIds: ["testing"]
      }
    }]
  }, null, 2)}\n`, "utf8");
  await appendEvidenceEvent(stateDir, {
    schemaVersion: 1,
    id: "delivery-1",
    createdAt: "2026-07-03T00:10:00.000Z",
    kind: "preflight-delivered",
    harness: "codex",
    preflightId: "run-1",
    algorithmVersion: 2
  });
  await appendInstallationRecord(stateDir, {
    id: "install-1",
    status: "installed",
    action: "create",
    destination: "/private/not-exported",
    installedFingerprint: `sha256:${"c".repeat(64)}`,
    previousFingerprint: null,
    backupDirectory: null,
    createdAt: "2026-07-03T00:20:00.000Z",
    provenance: {
      preflightId: "run-1",
      candidateId: "testing",
      sourceId: "fixture",
      sourceRevision: "d".repeat(40)
    }
  });
}

describe("evidence command", () => {
  let current: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    current = await fixture();
  });

  it("previews and applies the exact persisted evidence policy in separate runs", async () => {
    expect(await run(["evidence", "policy", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      mode: "minimal",
      retentionDays: 30,
      maxEvents: 5_000
    });

    const previewArgs = [
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ];
    expect(await run(previewArgs, current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    expect(preview).toMatchObject({
      before: { mode: "minimal" },
      after: { mode: "learning", retentionDays: 45, maxEvents: 1_000 },
      planId: expect.any(String),
      expiresAt: "2026-07-03T01:10:00.000Z",
      applyCommand: expect.stringMatching(/^skill-steward evidence policy set --plan \S+ --confirm$/)
    });
    expect(preview.applyCommand).toBe(
      `skill-steward evidence policy set --plan ${preview.planId} --confirm`
    );
    expect(await storedPlan(current.stateDir, preview.planId)).toMatchObject({
      id: preview.planId,
      kind: "evidence-policy",
      payload: { after: { mode: "learning", retentionDays: 45, maxEvents: 1_000 } }
    });
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");

    previewArgs.splice(3, previewArgs.length - 3, "minimal");
    expect(await run([
      "evidence", "policy", "set", "--plan", preview.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      mode: "learning",
      planId: preview.planId
    });
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("learning");

    expect(await run([
      "evidence", "policy", "set", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toMatch(/REVIEWED_PLAN_NOT_FOUND.*preview/is);
  });

  it("shows every exact evidence policy change in human preview output", async () => {
    expect(await run([
      "evidence", "policy", "set",
      "--mode", "minimal",
      "--retention-days", "45",
      "--max-events", "1000"
    ], current.context)).toBe(0);

    expect(current.stdout.splice(0).join("")).toContain([
      "Mode: minimal -> minimal",
      "Retention days: 30 -> 45",
      "Max events: 5000 -> 1000"
    ].join("\n"));
  });

  it("summarizes, exports, compacts, and erases only scoped evidence", async () => {
    await seedEvidence(current.stateDir);
    await writeFile(join(current.stateDir, "evidence-salt"), Buffer.alloc(32, 7), { mode: 0o600 });
    expect(await run(["evidence", "summary", "--json"], current.context)).toBe(0);
    const summary = JSON.parse(current.stdout.splice(0).join(""));
    expect(summary).toMatchObject({
      totals: { preflights: 1, labeled: 1, portfolios: 1, events: 1 },
      metrics: {
        usefulRate: { numerator: 1, denominator: 1, value: 1 },
        installConversion: { numerator: 1, denominator: 1, value: 1 }
      },
      readiness: { status: "insufficient-evidence" }
    });
    expect(summary).not.toHaveProperty("successRate");

    const output = join(current.base, "evidence-export.json");
    expect(await run([
      "evidence", "export", "--output", output
    ], current.context)).toBe(0);
    const exported = await readFile(output, "utf8");
    expect(exported).toContain('"preflightId": "run-1"');
    expect(exported).not.toMatch(/\/private\/not-exported|sourceRevision|evidence-salt/);
    current.stdout.splice(0);
    expect(await run(["evidence", "compact"], current.context)).toBe(0);
    current.stdout.splice(0);

    expect(await run(["evidence", "erase", "--json"], current.context)).toBe(0);
    const plan = JSON.parse(current.stdout.splice(0).join(""));
    expect(plan).toMatchObject({
      paths: expect.any(Array),
      planId: expect.any(String),
      expiresAt: "2026-07-03T01:10:00.000Z",
      applyCommand: expect.stringMatching(/^skill-steward evidence erase --plan \S+ --confirm$/)
    });
    expect(plan.paths).toHaveLength(3);
    expect(await storedPlan(current.stateDir, plan.planId)).toMatchObject({
      id: plan.planId,
      kind: "evidence-erase"
    });
    expect(await access(join(current.stateDir, "preflights.json"))).toBeUndefined();
    expect(await run([
      "evidence", "erase", "--plan", plan.planId, "--confirm", "--json"
    ], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      erased: true,
      planId: plan.planId
    });
    await expect(access(join(current.stateDir, "preflights.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "evidence-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "evidence-salt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "installations.jsonl"))).resolves.toBeUndefined();
  });

  it("refuses missing confirmation inputs and ambiguous evidence apply options", async () => {
    for (const args of [
      ["evidence", "policy", "set", "--confirm"],
      ["evidence", "erase", "--confirm"]
    ]) {
      expect(await run(args, current.context)).toBe(1);
      expect(current.stderr.splice(0).join("")).toMatch(/preview/i);
    }

    for (const args of [
      ["evidence", "policy", "set", "--plan", "missing"],
      ["evidence", "erase", "--plan", "missing"]
    ]) {
      expect(await run(args, current.context)).toBe(1);
      const error = current.stderr.splice(0).join("");
      expect(error).toMatch(/--confirm/i);
      expect(error).not.toMatch(/new preview|fresh reviewed plan|preview command again/i);
    }

    expect(await run([
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    expect(await run([
      "evidence", "policy", "set",
      "--plan", preview.planId,
      "--confirm",
      "--mode", "minimal"
    ], current.context)).toBe(1);
    const ambiguousError = current.stderr.splice(0).join("");
    expect(ambiguousError).toMatch(/ambiguous/i);
    expect(ambiguousError).not.toMatch(/new preview|fresh reviewed plan|preview command again/i);
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");

    expect(await run([
      "evidence", "policy", "set", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(0);
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("learning");
  });

  it("rejects evidence payload identity tampering before mutation", async () => {
    for (const field of ["id", "createdAt", "expiresAt"] as const) {
      expect(await run([
        "evidence", "policy", "set",
        "--mode", "learning",
        "--retention-days", "45",
        "--max-events", "1000",
        "--json"
      ], current.context)).toBe(0);
      const preview = JSON.parse(current.stdout.splice(0).join(""));
      await tamperPayloadIdentity(current.stateDir, preview.planId, field);

      expect(await run([
        "evidence", "policy", "set", "--plan", preview.planId, "--confirm"
      ], current.context)).toBe(1);
      expect(current.stderr.splice(0).join(""))
        .toMatch(/REVIEWED_PLAN_INVALID.*fresh reviewed plan/is);
      expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");
    }

    await seedEvidence(current.stateDir);
    for (const field of ["id", "createdAt", "expiresAt"] as const) {
      expect(await run(["evidence", "erase", "--json"], current.context)).toBe(0);
      const preview = JSON.parse(current.stdout.splice(0).join(""));
      await tamperPayloadIdentity(current.stateDir, preview.planId, field);

      expect(await run([
        "evidence", "erase", "--plan", preview.planId, "--confirm"
      ], current.context)).toBe(1);
      expect(current.stderr.splice(0).join(""))
        .toMatch(/REVIEWED_PLAN_INVALID.*fresh reviewed plan/is);
      await expect(access(join(current.stateDir, "preflights.json"))).resolves.toBeUndefined();
      await expect(access(join(current.stateDir, "evidence-events.jsonl"))).resolves.toBeUndefined();
    }
  });

  it("refuses wrong-kind and expired evidence plans without mutation", async () => {
    expect(await run([
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ], current.context)).toBe(0);
    const wrongKind = JSON.parse(current.stdout.splice(0).join(""));
    expect(await run([
      "evidence", "erase", "--plan", wrongKind.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toMatch(/REVIEWED_PLAN_KIND_MISMATCH.*preview/is);
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");

    expect(await run([
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ], current.context)).toBe(0);
    const expired = JSON.parse(current.stdout.splice(0).join(""));
    current.context.now = () => new Date("2026-07-03T02:00:00.000Z");
    expect(await run([
      "evidence", "policy", "set", "--plan", expired.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join("")).toMatch(/REVIEWED_PLAN_EXPIRED.*preview/is);
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");
  });

  it("explains that a policy drift failure consumed the reviewed plan", async () => {
    expect(await run([
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    await writeFile(join(current.stateDir, "evidence-policy.json"), `${JSON.stringify({
      schemaVersion: 1,
      mode: "learning",
      retentionDays: 60,
      maxEvents: 2_000
    }, null, 2)}\n`, "utf8");

    expect(await run([
      "evidence", "policy", "set", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/POLICY_DRIFT.*consumed.*fresh reviewed plan/is);

    expect(await run([
      "evidence", "policy", "set", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
  });

  it("explains that an erase drift failure consumed the reviewed plan", async () => {
    await seedEvidence(current.stateDir);
    expect(await run(["evidence", "erase", "--json"], current.context)).toBe(0);
    const preview = JSON.parse(current.stdout.splice(0).join(""));
    const preflights = join(current.stateDir, "preflights.json");
    await writeFile(preflights, `${await readFile(preflights, "utf8")} `, "utf8");

    expect(await run([
      "evidence", "erase", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/EVIDENCE_ERASE_DRIFT.*consumed.*fresh reviewed plan/is);
    await expect(access(preflights)).resolves.toBeUndefined();

    expect(await run([
      "evidence", "erase", "--plan", preview.planId, "--confirm"
    ], current.context)).toBe(1);
    expect(current.stderr.splice(0).join(""))
      .toMatch(/REVIEWED_PLAN_NOT_FOUND.*fresh reviewed plan/is);
  });

  it("escapes terminal controls in evidence human paths and errors", async () => {
    const unsafeState = join(current.base, "state\u001b[2J\nspoof");
    await mkdir(unsafeState);
    current.context.stateDir = unsafeState;

    expect(await run(["evidence", "erase"], current.context)).toBe(0);
    const eraseOutput = current.stdout.splice(0).join("");
    expect(eraseOutput).not.toContain("\u001b");
    expect(eraseOutput).toContain("state\\u{001b}[2J\\u{000a}spoof");

    const unsafeOutput = join(current.base, "export\u001b[2J\nrecord.json");
    expect(await run([
      "evidence", "export", "--output", unsafeOutput
    ], current.context)).toBe(0);
    const exportOutput = current.stdout.splice(0).join("");
    expect(exportOutput).not.toContain("\u001b");
    expect(exportOutput).toContain("export\\u{001b}[2J\\u{000a}record.json");

    const missingUnsafeOutput = join(
      current.base,
      "missing\u001b[2J\nparent",
      "record.json"
    );
    expect(await run([
      "evidence", "export", "--output", missingUnsafeOutput
    ], current.context)).toBe(1);
    const error = current.stderr.splice(0).join("");
    expect(error).not.toContain("\u001b");
    expect(error).toContain("missing\\u{001b}[2J\\u{000a}parent");
  });

  it("records explicit Preflight feedback from the CLI", async () => {
    await seedEvidence(current.stateDir);

    expect(await run([
      "evidence",
      "feedback",
      "--preflight",
      "run-1",
      "--label",
      "incomplete",
      "--candidate",
      "testing",
      "--json"
    ], current.context)).toBe(0);

    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      recorded: true,
      preflightId: "run-1",
      label: "incomplete",
      candidateIds: ["testing"]
    });
    expect((await readNormalizedPreflightEvidence(current.stateDir))[0]?.feedback)
      .toMatchObject({ label: "incomplete", candidateIds: ["testing"] });
  });

  it("uses the recommendation as the corrected set for useful feedback", async () => {
    await seedEvidence(current.stateDir);

    expect(await run([
      "evidence",
      "feedback",
      "--preflight",
      "run-1",
      "--label",
      "useful",
      "--json"
    ], current.context)).toBe(0);

    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      label: "useful",
      candidateIds: ["testing"]
    });
    expect((await readNormalizedPreflightEvidence(current.stateDir))[0]?.feedback)
      .toMatchObject({ label: "useful", candidateIds: ["testing"] });
  });

  it("requires a corrected candidate set for incomplete feedback", async () => {
    await seedEvidence(current.stateDir);

    expect(await run([
      "evidence",
      "feedback",
      "--preflight",
      "run-1",
      "--label",
      "incomplete"
    ], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain(
      "--candidate must provide the complete correct candidate set for incomplete feedback"
    );
  });
});
