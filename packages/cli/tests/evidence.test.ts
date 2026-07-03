import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInstallationRecord } from "@skill-steward/installer";
import {
  appendEvidenceEvent,
  readEvidencePolicy
} from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

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

  it("reviews and explicitly applies a local evidence policy", async () => {
    expect(await run(["evidence", "policy", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      mode: "minimal",
      retentionDays: 30,
      maxEvents: 5_000
    });

    const args = [
      "evidence", "policy", "set",
      "--mode", "learning",
      "--retention-days", "45",
      "--max-events", "1000",
      "--json"
    ];
    expect(await run(args, current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      before: { mode: "minimal" },
      after: { mode: "learning", retentionDays: 45, maxEvents: 1_000 }
    });
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("minimal");

    expect(await run([...args, "--confirm"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({ mode: "learning" });
    expect((await readEvidencePolicy(current.stateDir)).mode).toBe("learning");
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
    expect(plan.paths).toHaveLength(3);
    expect(await access(join(current.stateDir, "preflights.json"))).toBeUndefined();
    expect(await run(["evidence", "erase", "--confirm", "--json"], current.context)).toBe(0);
    await expect(access(join(current.stateDir, "preflights.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "evidence-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "evidence-salt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(current.stateDir, "installations.jsonl"))).resolves.toBeUndefined();
  });
});
