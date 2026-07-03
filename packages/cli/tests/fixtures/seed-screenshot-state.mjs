#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binary = process.argv[2];
const base = resolve(process.argv[3] ?? "/tmp/skill-steward-screenshot-fixture");

if (!binary) {
  throw new Error("Usage: seed-screenshot-state.mjs <packed-skill-steward-binary> [fixture-directory]");
}

const home = join(base, "home");
const state = join(base, "state");
const workspace = join(base, "workspace");
const environment = { ...process.env, HOME: home, SKILL_STEWARD_HOME: state };

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value) {
  return `sha256:${hash(value)}`;
}

function pseudonym(value) {
  return `hmac-sha256:${hash(value)}`;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function run(args) {
  return execFileAsync(binary, args, { cwd: workspace, env: environment });
}

async function writeSkill(root, name, description, body) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8"
  );
}

await rm(base, { recursive: true, force: true });
await Promise.all([
  mkdir(join(home, ".agents", "skills"), { recursive: true }),
  mkdir(join(home, ".claude", "skills"), { recursive: true }),
  mkdir(join(home, ".codex"), { recursive: true }),
  mkdir(join(home, ".copilot", "hooks"), { recursive: true }),
  mkdir(state, { recursive: true, mode: 0o700 }),
  mkdir(workspace, { recursive: true })
]);

await Promise.all([
  writeSkill(
    join(home, ".agents", "skills"),
    "security-review",
    "Review authentication boundaries, secrets, and dependency risks",
    "Inspect the proposed change and report actionable security findings."
  ),
  writeSkill(
    join(home, ".agents", "skills"),
    "test-coverage",
    "Find missing behavioral tests and fragile regression boundaries",
    "Map changed behavior to focused tests before implementation."
  ),
  writeSkill(
    join(home, ".claude", "skills"),
    "release-safety",
    "Check release notes, compatibility, and rollback readiness",
    "Review release risk and verify a reversible rollout path."
  ),
  writeJson(join(home, ".codex", "hooks.json"), { unrelated: true }),
  writeJson(join(home, ".claude", "settings.json"), { unrelated: true }),
  writeJson(join(home, ".copilot", "hooks", "keep-me.json"), { unrelated: true })
]);

for (const harness of ["codex", "claude-code", "github-copilot"]) {
  await run(["integrate", "apply", "--harness", harness, "--confirm"]);
}

const scan = JSON.parse((await run(["scan", "--json"])).stdout);
const now = Date.now();
const day = 24 * 60 * 60 * 1_000;
const harnesses = ["codex", "claude-code", "github-copilot"];
const preflights = [];
const events = [];
const installations = [];

for (let index = 0; index < 120; index += 1) {
  const id = `synthetic-preflight-${String(index + 1).padStart(3, "0")}`;
  const createdAt = new Date(now - (index % 45) * day - index * 1_000).toISOString();
  const recordedAt = new Date(new Date(createdAt).getTime() + 500).toISOString();
  const harness = harnesses[index % harnesses.length];
  const installRecommended = index < 40;
  const label = index < 75 ? "useful" : index < 105 ? "incomplete" : "incorrect";
  const feedbackCandidates = label === "incomplete"
    ? ["security-review", "test-coverage"]
    : label === "useful"
      ? ["security-review"]
      : [];
  const candidates = ["security-review", "test-coverage", "catalog-quality"];

  preflights.push({
    schemaVersion: 3,
    id,
    createdAt,
    portfolioFingerprint: fingerprint(`portfolio-${index % 24}`),
    taskHash: fingerprint(`anonymous-task-${index}`),
    taskCharacterCount: 48 + (index % 32),
    taskTermCount: 7 + (index % 8),
    algorithmVersion: 3,
    harness,
    candidateIds: candidates,
    useCandidateIds: ["security-review"],
    installCandidateIds: installRecommended ? ["catalog-quality"] : [],
    candidateFeatures: [
      {
        candidateId: "security-review",
        availability: "installed",
        taskCoverage: 0.86,
        skillPrecision: 0.91,
        nameMatch: true,
        projectScopeFit: true,
        relevance: 0.89,
        uniqueCoverage: 0.72,
        riskPenalty: 0.04,
        redundancyPenalty: 0.08,
        installPenalty: 0,
        contextTokens: 210,
        decision: "use"
      },
      {
        candidateId: "test-coverage",
        availability: "installed",
        taskCoverage: 0.56,
        skillPrecision: 0.76,
        nameMatch: false,
        projectScopeFit: true,
        relevance: 0.64,
        uniqueCoverage: 0.42,
        riskPenalty: 0.03,
        redundancyPenalty: 0.24,
        installPenalty: 0,
        contextTokens: 180,
        decision: "excluded"
      },
      {
        candidateId: "catalog-quality",
        availability: "available",
        taskCoverage: 0.68,
        skillPrecision: 0.82,
        nameMatch: false,
        projectScopeFit: true,
        relevance: 0.73,
        uniqueCoverage: 0.61,
        riskPenalty: 0.05,
        redundancyPenalty: 0.11,
        installPenalty: 0.14,
        contextTokens: 240,
        decision: installRecommended ? "install" : "excluded"
      }
    ],
    feedback: {
      schemaVersion: 1,
      preflightId: id,
      recordedAt,
      label,
      candidateIds: feedbackCandidates
    }
  });

  events.push({
    schemaVersion: 1,
    id: `delivery-${index + 1}`,
    createdAt,
    kind: "preflight-delivered",
    harness,
    preflightId: id,
    algorithmVersion: 3,
    sessionKey: pseudonym(`session-${index % 36}`),
    turnKey: pseudonym(`turn-${index}`)
  });
  events.push({
    schemaVersion: 1,
    id: `turn-${index + 1}`,
    createdAt: recordedAt,
    kind: "turn-finished",
    harness,
    preflightId: id,
    sessionKey: pseudonym(`session-${index % 36}`),
    turnKey: pseudonym(`turn-${index}`),
    reason: index % 17 === 0 ? "error" : index % 13 === 0 ? "abort" : "complete"
  });
  if (index % 4 === 0) {
    events.push({
      schemaVersion: 1,
      id: `session-${index + 1}`,
      createdAt: recordedAt,
      kind: "session-ended",
      harness,
      sessionKey: pseudonym(`session-${index % 36}`),
      reason: index % 20 === 0 ? "user-exit" : "complete"
    });
  }

  if (index < 12) {
    installations.push({
      id: `synthetic-installation-${index + 1}`,
      status: "installed",
      action: "create",
      destination: join(base, "synthetic-installations", String(index + 1)),
      installedFingerprint: fingerprint(`installation-${index}`),
      previousFingerprint: null,
      backupDirectory: null,
      createdAt: recordedAt,
      provenance: {
        preflightId: id,
        candidateId: "catalog-quality",
        sourceId: "synthetic-catalog",
        sourceRevision: hash("synthetic-catalog-revision").slice(0, 40)
      }
    });
  }
}

await writeJson(join(state, "evidence-policy.json"), {
  schemaVersion: 1,
  mode: "learning",
  retentionDays: 90,
  maxEvents: 5_000
});
await writeJson(join(state, "preflights.json"), { schemaVersion: 3, records: preflights });
await writeFile(
  join(state, "evidence-events.jsonl"),
  `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  { mode: 0o600 }
);
await writeFile(
  join(state, "installations.jsonl"),
  `${installations.map((record) => JSON.stringify(record)).join("\n")}\n`,
  { mode: 0o600 }
);

const releaseSafety = scan.skills.find((skill) => skill.name === "release-safety");
if (!releaseSafety) throw new Error("Synthetic release-safety Skill was not discovered");
await run(["govern", "quarantine", "--skill", releaseSafety.id, "--confirm"]);

process.stdout.write(`${JSON.stringify({ base, home, state, workspace }, null, 2)}\n`);
