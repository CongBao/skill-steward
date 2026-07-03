import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  appendIntegrationRecord,
  latestIntegrationRecord,
  readIntegrationRecords,
  type IntegrationRecord
} from "../src/integration-store.js";

const publicationGate = vi.hoisted(() => ({
  armed: false,
  blocked: null as (() => void) | null,
  wait: null as Promise<void> | null,
  publishedPath: null as string | null,
  temporaryCtime: null as bigint | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async rename(...args: Parameters<typeof original.rename>) {
      const [temporary, published] = args;
      if (
        publicationGate.armed
        && String(temporary).includes("integration-records")
        && String(temporary).endsWith(".tmp")
      ) {
        publicationGate.armed = false;
        publicationGate.publishedPath = String(published);
        const oldTime = new Date("2000-01-01T00:00:00.000Z");
        await original.utimes(temporary, oldTime, oldTime);
        publicationGate.temporaryCtime = (
          await original.stat(temporary, { bigint: true })
        ).ctimeNs;
        publicationGate.blocked?.();
        if (publicationGate.wait) await publicationGate.wait;
      }
      return original.rename(...args);
    }
  };
});

const writerFixture = fileURLToPath(
  new URL("./fixtures/integration-writer.mjs", import.meta.url)
);
const readerFixture = fileURLToPath(
  new URL("./fixtures/integration-reader.mjs", import.meta.url)
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

function reader(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [readerFixture, ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`reader exited ${code}: ${stderr}`)));
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

  it("validates the legacy journal before publishing a fragment", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-bad-legacy-"));
    await writeFile(join(state, "integrations.json"), "not-json\n", "utf8");

    await expect(appendIntegrationRecord(
      state,
      record("not-published", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    await expect(access(join(state, "integration-records")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses directory and unreadable legacy journals before publishing", async () => {
    const directoryState = await mkdtemp(join(tmpdir(), "steward-integration-dir-legacy-"));
    await mkdir(join(directoryState, "integrations.json"));
    await expect(appendIntegrationRecord(
      directoryState,
      record("directory-legacy", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    await expect(access(join(directoryState, "integration-records")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const unreadableState = await mkdtemp(join(tmpdir(), "steward-integration-mode-legacy-"));
    const legacyPath = join(unreadableState, "integrations.json");
    await writeFile(legacyPath, '{"schemaVersion":1,"records":[]}\n', "utf8");
    await chmod(legacyPath, 0o000);
    try {
      await expect(appendIntegrationRecord(
        unreadableState,
        record("unreadable-legacy", "2026-07-03T00:00:00.000Z")
      )).rejects.toMatchObject({ code: "EACCES" });
      await expect(access(join(unreadableState, "integration-records")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(legacyPath, 0o600);
    }
  });

  it("secures the fragment directory and refuses unsafe storage paths", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-private-"));
    const recordsDirectory = join(state, "integration-records");
    await mkdir(recordsDirectory, { mode: 0o755 });
    await appendIntegrationRecord(state, record("private", "2026-07-03T00:00:00.000Z"));
    expect((await stat(recordsDirectory)).mode & 0o777).toBe(0o700);

    const symlinkState = await mkdtemp(join(tmpdir(), "steward-integration-link-"));
    const outside = await mkdtemp(join(tmpdir(), "steward-integration-outside-"));
    await symlink(outside, join(symlinkState, "integration-records"), "dir");
    await expect(readIntegrationRecords(symlinkState)).rejects.toBeDefined();
    await expect(appendIntegrationRecord(
      symlinkState,
      record("escaped", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual([]);

    const fileState = await mkdtemp(join(tmpdir(), "steward-integration-file-"));
    await writeFile(join(fileState, "integration-records"), "not a directory", "utf8");
    await expect(appendIntegrationRecord(
      fileState,
      record("blocked", "2026-07-03T00:00:00.000Z")
    )).rejects.toBeDefined();
  });

  it("does not hide malformed recognized fragments", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-corrupt-"));
    const directory = join(state, "integration-records");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, `1-${process.pid}-000000000001-00000000-0000-0000-0000-000000000000.json`),
      "not-json\n",
      { mode: 0o600 }
    );
    await expect(readIntegrationRecords(state)).rejects.toBeDefined();
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

  it("retains a late-published fragment whose temporary file had an old mtime", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-publish-order-"));
    for (let index = 0; index < 100; index += 1) {
      await appendIntegrationRecord(
        state,
        record(`seed-${index}`, new Date(Date.UTC(2026, 6, 3) + index).toISOString())
      );
    }
    let markBlocked!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    publicationGate.armed = true;
    publicationGate.blocked = markBlocked;
    publicationGate.wait = wait;
    publicationGate.publishedPath = null;
    publicationGate.temporaryCtime = null;
    const lateAppend = appendIntegrationRecord(
      state,
      record("late-publish", "2026-07-03T02:00:00.000Z")
    );
    await blocked;
    try {
      for (let index = 0; index <= 100; index += 1) {
        await appendIntegrationRecord(
          state,
          record(
            `newer-${index}`,
            new Date(Date.UTC(2026, 6, 3, 3) + index).toISOString()
          )
        );
      }
    } finally {
      release();
    }
    await lateAppend;
    const metadata = await stat(publicationGate.publishedPath!, { bigint: true });
    expect(metadata.ctimeNs).toBeGreaterThan(publicationGate.temporaryCtime!);

    const records = await readIntegrationRecords(state);
    expect(records.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "late-publish",
      "newer-100"
    ]));
    expect(records).toHaveLength(100);
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

  it("keeps readers healthy while real writers publish and clean more than 100 records", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-integration-read-race-"));
    for (let index = 0; index < 100; index += 1) {
      await appendIntegrationRecord(
        state,
        record(`seed-${index}`, new Date(Date.UTC(2026, 6, 3) + index).toISOString())
      );
    }
    const barrier = join(state, "barrier");
    const readyWriter = join(state, "ready-writer");
    const readyReaderA = join(state, "ready-reader-a");
    const readyReaderB = join(state, "ready-reader-b");
    const processes = [
      writer([state, "codex", "race", readyWriter, barrier, "140"]),
      reader([state, readyReaderA, barrier, "300"]),
      reader([state, readyReaderB, barrier, "300"])
    ];
    await Promise.all([waitFor(readyWriter), waitFor(readyReaderA), waitFor(readyReaderB)]);
    await writeFile(barrier, "go\n", "utf8");
    await Promise.all(processes);

    const records = await readIntegrationRecords(state);
    expect(records.some(({ id }) => id === "race-139")).toBe(true);
    expect(await readdir(join(state, "integration-records"))).toHaveLength(100);
  }, 30_000);
});
