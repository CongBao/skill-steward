import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecord,
  latestIntegrationRecord,
  readIntegrationRecords,
  type IntegrationRecord
} from "../src/integration-store.js";

const writerFixture = fileURLToPath(
  new URL("./fixtures/integration-writer.mjs", import.meta.url)
);

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function writer(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerFixture, ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

function record(id: string, createdAt: string): IntegrationRecord {
  return {
    schemaVersion: 1,
    id,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: "/tmp/home/.codex/hooks.json",
    backupPath: "/tmp/home/.codex/hooks.backup.json",
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    createdAt
  };
}

describe("integration store", () => {
  it("writes private bounded records and returns the latest Harness record", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-store-"));
    await appendIntegrationRecord(state, record("one", "2026-07-03T00:00:00.000Z"), { limit: 2 });
    await appendIntegrationRecord(state, record("two", "2026-07-03T01:00:00.000Z"), { limit: 2 });
    await appendIntegrationRecord(state, record("three", "2026-07-03T02:00:00.000Z"), { limit: 2 });
    const records = await readIntegrationRecords(state);
    expect(records.map(({ id }) => id)).toEqual(["three", "two"]);
    const fragments = await readdir(join(state, "integration-records"));
    expect(fragments.length).toBe(3);
    await expect(Promise.all(fragments.map(async (file) =>
      (await stat(join(state, "integration-records", file))).mode & 0o777
    ))).resolves.toEqual([0o600, 0o600, 0o600]);
  });

  it("orders same-process apply then remove when domain timestamps are fixed", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-order-"));
    const createdAt = "2026-07-03T00:00:00.000Z";
    await appendIntegrationRecord(state, record("apply", createdAt));
    await appendIntegrationRecord(state, {
      ...record("remove", createdAt),
      action: "remove",
      status: "removed"
    });
    await expect(latestIntegrationRecord(state, "codex")).resolves.toMatchObject({
      id: "remove",
      status: "removed"
    });
  });

  it("merges legacy JSON records behind newly committed fragments", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-legacy-"));
    const legacy = record("legacy", "2026-07-03T00:00:00.000Z");
    await writeFile(join(state, "integrations.json"), `${JSON.stringify({
      schemaVersion: 1,
      records: [legacy]
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await appendIntegrationRecord(
      state,
      record("fragment", "2026-07-03T01:00:00.000Z")
    );
    expect((await readIntegrationRecords(state)).map(({ id }) => id))
      .toEqual(["fragment", "legacy"]);
  });

  it("bounds immutable fragment storage to the newest 100 records", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-bound-"));
    for (let index = 0; index < 105; index += 1) {
      await appendIntegrationRecord(
        state,
        record(
          `record-${index}`,
          new Date(Date.UTC(2026, 6, 3) + index * 60_000).toISOString()
        )
      );
    }
    expect(await readIntegrationRecords(state)).toHaveLength(100);
    expect(await readdir(join(state, "integration-records"))).toHaveLength(100);
  });

  it("preserves different-Harness records across real concurrent processes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-concurrent-"));
    const barrier = join(state, "barrier");
    const readyA = join(state, "ready-a");
    const readyB = join(state, "ready-b");
    const count = 40;
    const writers = [
      writer([state, "codex", "codex", readyA, barrier, String(count)]),
      writer([state, "claude-code", "claude", readyB, barrier, String(count)])
    ];
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(writers);

    const records = await readIntegrationRecords(state);
    expect(records).toHaveLength(count * 2);
    expect(new Set(records.map(({ id }) => id)).size).toBe(count * 2);
    expect(records.some(({ id }) => id === "codex-039")).toBe(true);
    expect(records.some(({ id }) => id === "claude-039")).toBe(true);
  }, 15_000);

  it("preserves same-Harness no-op records across real concurrent processes", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-same-"));
    const barrier = join(state, "barrier");
    const readyA = join(state, "ready-a");
    const readyB = join(state, "ready-b");
    const count = 20;
    const writers = [
      writer([state, "codex", "left", readyA, barrier, String(count)]),
      writer([state, "codex", "right", readyB, barrier, String(count)])
    ];
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(writers);

    const records = await readIntegrationRecords(state);
    expect(records).toHaveLength(count * 2);
    expect(new Set(records.map(({ id }) => id))).toEqual(new Set([
      ...Array.from({ length: count }, (_, index) => `left-${String(index).padStart(3, "0")}`),
      ...Array.from({ length: count }, (_, index) => `right-${String(index).padStart(3, "0")}`)
    ]));
    await expect(latestIntegrationRecord(state, "codex")).resolves.toMatchObject({
      harness: "codex",
      status: "installed"
    });
  }, 15_000);
});
