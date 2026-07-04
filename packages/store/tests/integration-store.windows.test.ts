import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIntegrationRecord,
  readIntegrationRecords,
  type IntegrationRecord
} from "../src/integration-store.js";
import { withIntegrationMutationLease } from "../src/integration-mutation-lease.js";

function record(index: number): IntegrationRecord {
  const createdAt = new Date(Date.UTC(2026, 6, 4) + index).toISOString();
  return {
    schemaVersion: 2,
    id: `windows-${index}`,
    harness: "codex",
    action: "apply",
    status: "installed",
    targetPath: "C:\\Users\\runner\\.codex\\hooks.json",
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    companion: {
      action: "none",
      path: "C:\\Users\\runner\\.agents\\skills\\skill-steward-preflight",
      before: { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` },
      after: { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` },
      source: { fingerprint: `sha256:${"d".repeat(64)}` },
      proof: { category: "recorded" },
      installedFingerprint: `sha256:${"d".repeat(64)}`,
      consumers: ["codex"]
    },
    trigger: { planId: `windows-${index}`, harness: "codex", createdAt },
    createdAt
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
    const fragmentNames = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(fragmentNames).toHaveLength(100);
    const parentIdentities = await Promise.all([
      stat(state, { bigint: true }),
      stat(directory, { bigint: true })
    ]);
    expect(parentIdentities.every(({ ino }) => ino !== 0n)).toBe(true);
    const nativeIdentities = await Promise.all(fragmentNames.map((name) =>
      stat(join(directory, name), { bigint: true })
    ));
    expect(nativeIdentities.every(({ ino }) => ino !== 0n)).toBe(true);
  }, 30_000);

  it("refuses a junctioned fragment directory without writing outside state", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-windows-junction-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-windows-outside-"));
    await symlink(outside, join(state, "integration-records"), "junction");

    await expect(appendIntegrationRecord(state, record(1))).rejects.toBeDefined();
    await expect(readIntegrationRecords(state)).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual([]);
  });

  it("serializes and releases the hard-link mutation lease", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-windows-lease-"));
    let active = 0;
    let maximum = 0;

    await Promise.all(Array.from({ length: 4 }, () =>
      withIntegrationMutationLease(state, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }, { waitMs: 2_000, pollMs: 2, heartbeatMs: 2 })
    ));

    expect(maximum).toBe(1);
    await expect(access(join(state, "integration-mutation.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a stale mutation lease after its Windows owner exits", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-windows-stale-lease-"));
    const leasePath = join(state, "integration-mutation.lease");
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const pid = child.pid;
      child.once("error", reject);
      child.once("exit", () => pid === undefined
        ? reject(new Error("Child process did not expose a PID"))
        : resolve(pid));
    });
    await writeFile(leasePath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000010",
      pid: deadPid,
      acquiredAt: "2026-07-04T00:00:00.000Z"
    })}\n`);
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);

    await expect(withIntegrationMutationLease(state, async () => "recovered", {
      waitMs: 500,
      pollMs: 2,
      staleMs: 10,
      hardStaleMs: 120_000
    })).resolves.toBe("recovered");
  });
});
