import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecord,
  readIntegrationRecords,
  type IntegrationRecord
} from "../src/integration-store.js";

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
    expect((await stat(join(state, "integrations.json"))).mode & 0o777).toBe(0o600);
  });
});
