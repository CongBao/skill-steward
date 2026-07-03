import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as store from "../src/index.js";

type LeaseOptions = {
  waitMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  hardStaleMs?: number;
};

type WithLease = <T>(
  stateDirectory: string,
  operation: () => Promise<T>,
  options?: LeaseOptions
) => Promise<T>;

const withLease = (store as unknown as {
  withIntegrationMutationLease: WithLease;
}).withIntegrationMutationLease;
const withInstallationLease = (store as unknown as {
  withInstallationMutationLease: WithLease;
}).withInstallationMutationLease;
const leaseFixture = fileURLToPath(
  new URL("./fixtures/integration-lease-holder.mjs", import.meta.url)
);

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await delay(2);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function runHolder(
  stateDirectory: string,
  readyPath: string,
  releasePath: string
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [leaseFixture, stateDirectory, readyPath, releasePath], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function exitedChildPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    child.once("error", reject);
    child.once("exit", () => pid === undefined
      ? reject(new Error("Child process did not expose a PID"))
      : resolve(pid));
  });
}

describe("integration mutation lease", () => {
  it("serializes same-state work in the same process", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-serial-"));
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withLease(state, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push("first-enter");
      await firstGate;
      order.push("first-exit");
      active -= 1;
    }, { waitMs: 1_000, pollMs: 2, heartbeatMs: 5 });
    await waitFor(join(state, "integration-mutation.lease"));
    const second = withLease(state, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push("second-enter");
      active -= 1;
    }, { waitMs: 1_000, pollMs: 2, heartbeatMs: 5 });

    releaseFirst();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("reports busy within a bound and releases after an operation throws", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-busy-"));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withLease(state, () => firstGate, {
      waitMs: 1_000,
      pollMs: 2,
      heartbeatMs: 5
    });
    await waitFor(join(state, "integration-mutation.lease"));

    await expect(withLease(state, async () => undefined, {
      waitMs: 15,
      pollMs: 2,
      heartbeatMs: 5
    })).rejects.toMatchObject({ code: "INTEGRATION_BUSY" });
    releaseFirst();
    await first;

    await expect(withLease(state, async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    await expect(withLease(state, async () => "entered")).resolves.toBe("entered");
  });

  it("shares one portfolio lock with installations and reports the installation domain", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-installation-lease-busy-"));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withLease(state, () => firstGate, {
      waitMs: 1_000,
      pollMs: 2,
      heartbeatMs: 5
    });
    await waitFor(join(state, "integration-mutation.lease"));

    await expect(withInstallationLease(state, async () => undefined, {
      waitMs: 15,
      pollMs: 2,
      heartbeatMs: 5
    })).rejects.toMatchObject({
      code: "INSTALLATION_BUSY",
      message: expect.stringContaining("portfolio mutation")
    });
    releaseFirst();
    await first;
    await expect(withInstallationLease(state, async () => "entered"))
      .resolves.toBe("entered");
  });

  it("preserves a domain AggregateError when lease release succeeds", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-installation-domain-error-"));
    const domainError = new AggregateError(
      [new Error("destination rollback failed")],
      "installation domain failure"
    );

    const failure = await withInstallationLease(state, async () => {
      throw domainError;
    }).catch((error: unknown) => error);

    expect(failure).toBe(domainError);
  });

  it("still releases when work outlives its acquisition wait budget", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-long-work-"));

    await expect(withLease(state, async () => {
      await delay(20);
      throw new Error("late operation failure");
    }, {
      waitMs: 5,
      pollMs: 1,
      heartbeatMs: 2
    })).rejects.toThrow("late operation failure");
    await expect(withLease(state, async () => "released", {
      waitMs: 50,
      pollMs: 1
    })).resolves.toBe("released");
  });

  it("recovers a conservatively stale lease whose owner process is absent", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-stale-"));
    const leasePath = join(state, "integration-mutation.lease");
    const deadPid = await exitedChildPid();
    await writeFile(leasePath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000000",
      pid: deadPid,
      acquiredAt: "2026-07-04T00:00:00.000Z"
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);

    await expect(withLease(state, async () => "recovered", {
      waitMs: 100,
      pollMs: 2,
      staleMs: 10,
      hardStaleMs: 120_000
    })).resolves.toBe("recovered");
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not steal a soft-stale lease from a live process", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-live-"));
    const leasePath = join(state, "integration-mutation.lease");
    await writeFile(leasePath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000001",
      pid: process.pid,
      acquiredAt: "2026-07-04T00:00:00.000Z"
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);

    await expect(withLease(state, async () => undefined, {
      waitMs: 15,
      pollMs: 2,
      staleMs: 10,
      hardStaleMs: 120_000
    })).rejects.toMatchObject({ code: "INTEGRATION_BUSY" });
    await unlink(leasePath);
  });

  it("serializes concurrent stale recoverers with new acquire and release cycles", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-recovery-race-"));
    const leasePath = join(state, "integration-mutation.lease");
    const deadPid = await exitedChildPid();
    await writeFile(leasePath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000003",
      pid: deadPid,
      acquiredAt: "2026-07-04T00:00:00.000Z"
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);
    let active = 0;
    let maximum = 0;

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withLease(state, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(2);
        active -= 1;
        return index;
      }, {
        waitMs: 10_000,
        pollMs: 1,
        heartbeatMs: 2,
        staleMs: 10,
        hardStaleMs: 120_000
      })
    ));

    expect(maximum).toBe(1);
    expect(results.sort((left, right) => left - right))
      .toEqual(Array.from({ length: 12 }, (_, index) => index));
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers one stale recovery guard without stealing a new guard owner", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-stale-guard-"));
    const guardPath = join(state, "integration-mutation-recovery.guard");
    const deadPid = await exitedChildPid();
    await writeFile(guardPath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000004",
      pid: deadPid,
      acquiredAt: "2026-07-04T00:00:00.000Z"
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(guardPath, old, old);
    let active = 0;
    let maximum = 0;

    await Promise.all(Array.from({ length: 12 }, () =>
      withLease(state, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(2);
        active -= 1;
      }, {
        waitMs: 10_000,
        pollMs: 1,
        heartbeatMs: 2,
        staleMs: 10,
        hardStaleMs: 120_000
      })
    ));

    expect(maximum).toBe(1);
    await expect(access(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a lease whose owner token changed", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-owner-"));
    const leasePath = join(state, "integration-mutation.lease");
    const failure = await withLease(state, async () => {
      const metadata = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
      await writeFile(leasePath, `${JSON.stringify({
        ...metadata,
        token: "00000000-0000-4000-8000-000000000002"
      })}\n`, "utf8");
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "INTEGRATION_LEASE_LOST" });
    await expect(access(leasePath)).resolves.toBeUndefined();
    await unlink(leasePath);
  });

  it("serializes a real child process through the same source implementation", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-lease-process-"));
    const state = join(base, "state");
    await mkdir(state);
    const ready = join(base, "ready");
    const release = join(base, "release");
    const child = runHolder(state, ready, release);
    await waitFor(ready);

    await expect(withLease(state, async () => undefined, {
      waitMs: 20,
      pollMs: 2
    })).rejects.toMatchObject({ code: "INTEGRATION_BUSY" });
    await writeFile(release, "release\n", "utf8");
    await expect(child).resolves.toEqual({ code: 0, stderr: "" });
    await expect(withLease(state, async () => "parent-entered")).resolves.toBe("parent-entered");
    await rm(base, { recursive: true, force: true });
  });

  it("heartbeats the published inode while work is active", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-lease-heartbeat-"));
    const leasePath = join(state, "integration-mutation.lease");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withLease(state, () => gate, { heartbeatMs: 5 });
    await waitFor(leasePath);
    const before = (await stat(leasePath)).mtimeMs;
    await delay(20);
    const after = (await stat(leasePath)).mtimeMs;
    release();
    await held;
    expect(after).toBeGreaterThan(before);
  });
});
