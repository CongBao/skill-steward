import { mkdtemp, mkdir, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecord,
  readIntegrationRecords,
  type IntegrationRecord
} from "../src/integration-store.js";

function record(index: number): IntegrationRecord {
  return {
    schemaVersion: 1,
    id: `windows-${index}`,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: "C:\\Users\\runner\\.codex\\hooks.json",
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    createdAt: new Date(Date.UTC(2026, 6, 4) + index).toISOString()
  };
}

describe.skipIf(process.platform !== "win32")("Windows integration journal smoke", () => {
  it("appends, reads, and bounds records in an existing ACL-inheriting directory", async () => {
    expect(process.platform).toBe("win32");
    const state = await mkdtemp(join(tmpdir(), "steward-windows-journal-"));
    const directory = join(state, "integration-records");
    await mkdir(directory);

    for (let index = 0; index < 105; index += 1) {
      await appendIntegrationRecord(state, record(index));
    }

    const records = await readIntegrationRecords(state);
    expect(records).toHaveLength(100);
    expect(records.some(({ id }) => id === "windows-104")).toBe(true);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json")))
      .toHaveLength(100);
  });

  it("refuses a junctioned fragment directory without writing outside state", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-windows-junction-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-windows-outside-"));
    await symlink(outside, join(state, "integration-records"), "junction");

    await expect(appendIntegrationRecord(state, record(1))).rejects.toBeDefined();
    await expect(readIntegrationRecords(state)).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual([]);
  });
});
