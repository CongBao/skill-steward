import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileSystemObservation = vi.hoisted(() => ({
  publishRaceDestination: undefined as string | undefined,
  cleanupDirectory: undefined as string | undefined,
  cleanupInspectedPaths: [] as string[],
  cleanupReadFailure: undefined as { id: string; code: "EACCES" | "EIO" } | undefined,
  cleanupReadPause: undefined as {
    id: string;
    reached: () => void;
    release: Promise<void>;
    releaseNow: () => void;
    triggered: boolean;
  } | undefined,
  cleanupUsedStreamingDirectory: false,
  exactFileIdentities: undefined as Map<string, { dev: bigint; ino: bigint }> | undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const createExternalDestination = async (source: unknown, destination: unknown) => {
    if (
      fileSystemObservation.publishRaceDestination === String(destination)
      && String(source).endsWith(".tmp")
    ) {
      fileSystemObservation.publishRaceDestination = undefined;
      await actual.writeFile(destination as string, "external-sentinel", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
    }
  };
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      await createExternalDestination(args[0], args[1]);
      return actual.link(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const metadata = await actual.lstat(...args);
      const identity = fileSystemObservation.exactFileIdentities?.get(String(args[0]));
      if (identity === undefined) return metadata;
      const bigint = typeof args[1] === "object"
        && args[1] !== null
        && "bigint" in args[1]
        && args[1].bigint === true;
      return new Proxy(metadata, {
        get(target, property) {
          if (property === "dev" || property === "ino") {
            return bigint ? identity[property] : Number(identity[property]);
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      const isPendingOrCleanup = (id: string) =>
        path.endsWith(`/${id}.json`)
        || (path.includes(`/.${id}.`) && path.endsWith(".cleanup"));
      if (
        typeof args[1] === "number"
        && fileSystemObservation.cleanupReadFailure !== undefined
        && isPendingOrCleanup(fileSystemObservation.cleanupReadFailure.id)
      ) {
        const error = new Error("injected cleanup read failure");
        Object.assign(error, { code: fileSystemObservation.cleanupReadFailure.code });
        throw error;
      }
      if (
        fileSystemObservation.cleanupDirectory !== undefined
        && typeof args[1] === "number"
        && String(args[0]).startsWith(`${fileSystemObservation.cleanupDirectory}/`)
      ) {
        fileSystemObservation.cleanupInspectedPaths.push(String(args[0]));
      }
      const handle = await actual.open(...args);
      const pause = fileSystemObservation.cleanupReadPause;
      if (
        typeof args[1] === "number"
        && pause !== undefined
        && !pause.triggered
        && isPendingOrCleanup(pause.id)
      ) {
        pause.triggered = true;
        const originalReadFile = handle.readFile.bind(handle);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "readFile") {
              return async (...readArgs: Parameters<typeof handle.readFile>) => {
                const source = await originalReadFile(...readArgs);
                pause.reached();
                await pause.release;
                return source;
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      return handle;
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (String(args[0]) === fileSystemObservation.cleanupDirectory) {
        fileSystemObservation.cleanupUsedStreamingDirectory = true;
      }
      return actual.opendir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await createExternalDestination(args[0], args[1]);
      return actual.rename(...args);
    }
  };
});

import {
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
  discardReviewedPlan,
  peekReviewedPlan,
  writeReviewedPlan,
  type ReviewedPlanEnvelope,
  type ReviewedPlanKind
} from "../src/reviewed-plan-store.js";

if (false) {
  // @ts-expect-error Claimed payloads remain unknown until a domain schema validates them.
  void claimReviewedPlan<{ trusted: true }>("state", {
    id: "plan",
    kind: "installation"
  });
}

const createdAt = "2026-07-03T00:00:00.000Z";
const expiresAt = "2026-07-03T00:05:00.000Z";
const residueUuid = "11111111-1111-4111-8111-111111111111";
const temporaryStateDirectories: string[] = [];

function envelope(
  id: string,
  kind: ReviewedPlanKind = "installation",
  overrides: Partial<ReviewedPlanEnvelope> = {}
): ReviewedPlanEnvelope {
  return {
    schemaVersion: 1,
    id,
    kind,
    createdAt,
    expiresAt,
    payload: { action: "apply", fingerprint: "sha256:private" },
    ...overrides
  };
}

async function state(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryStateDirectories.push(directory);
  return directory;
}

function pauseCleanupRead(id: string): {
  reached: Promise<void>;
  release: () => void;
} {
  let reachedNow = () => {};
  let releaseNow = () => {};
  const reached = new Promise<void>((resolve) => {
    reachedNow = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseNow = resolve;
  });
  fileSystemObservation.cleanupReadPause = {
    id,
    reached: reachedNow,
    release,
    releaseNow,
    triggered: false
  };
  return { reached, release: releaseNow };
}

afterEach(async () => {
  fileSystemObservation.publishRaceDestination = undefined;
  fileSystemObservation.cleanupDirectory = undefined;
  fileSystemObservation.cleanupInspectedPaths = [];
  fileSystemObservation.cleanupReadFailure = undefined;
  fileSystemObservation.cleanupReadPause?.releaseNow();
  fileSystemObservation.cleanupReadPause = undefined;
  fileSystemObservation.cleanupUsedStreamingDirectory = false;
  fileSystemObservation.exactFileIdentities = undefined;
  await Promise.all(temporaryStateDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("reviewed plan store", () => {
  it("peeks a strict reviewed plan without consuming its later claim", async () => {
    const stateDir = await state("steward-reviewed-peek-");
    const plan = envelope("peek-plan", "integration");
    await writeReviewedPlan(stateDir, plan);

    await expect(peekReviewedPlan(stateDir, {
      id: plan.id,
      kind: "integration",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toEqual(plan);
    await expect(claimReviewedPlan(stateDir, {
      id: plan.id,
      kind: "integration",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toEqual(plan);
  });

  it("stores and durably claims the distinct integration-disconnect kind", async () => {
    const stateDir = await state("steward-reviewed-disconnect-");
    const plan = envelope("disconnect-plan", "integration-disconnect");

    await writeReviewedPlan(stateDir, plan);
    vi.resetModules();
    const freshStore = await import("../src/reviewed-plan-store.js");
    await expect(freshStore.claimReviewedPlan(stateDir, {
      id: plan.id,
      kind: "integration-disconnect",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toEqual(plan);
    await expect(freshStore.claimReviewedPlan(stateDir, {
      id: plan.id,
      kind: "integration-disconnect",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("writes private files and lets a fresh module instance claim the payload", async () => {
    const stateDir = await state("steward-reviewed-plan-");
    const plan = envelope("plan-1");

    await writeReviewedPlan(stateDir, plan);

    const directory = join(stateDir, "reviewed-plans");
    const path = join(directory, "plan-1.json");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    vi.resetModules();
    const freshStore = await import("../src/reviewed-plan-store.js");
    await expect(freshStore.claimReviewedPlan(stateDir, {
      id: "plan-1",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toEqual(plan);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots nested payload data before yielding to caller mutation", async () => {
    const stateDir = await state("steward-reviewed-snapshot-");
    const payload = { review: { decision: "reviewed" } };
    const writing = writeReviewedPlan(stateDir, envelope("snapshot", "installation", {
      payload
    }));

    payload.review.decision = "mutated-after-write";
    await writing;

    await expect(claimReviewedPlan(stateDir, {
      id: "snapshot",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toMatchObject({ payload: { review: { decision: "reviewed" } } });
  });

  it("allows each reviewed plan to be claimed only once", async () => {
    const stateDir = await state("steward-reviewed-once-");
    await writeReviewedPlan(stateDir, envelope("once"));

    await claimReviewedPlan(stateDir, {
      id: "once",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    await expect(claimReviewedPlan(stateDir, {
      id: "once",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("restores a claimed plan when domain validation rejects its payload", async () => {
    const stateDir = await state("steward-reviewed-domain-reject-");
    const plan = envelope("domain-reject", "governance");
    const rejection = Object.assign(new Error("native plugin managed"), {
      code: "NATIVE_PLUGIN_MANAGED"
    });
    await writeReviewedPlan(stateDir, plan);

    await expect(claimReviewedPlan(stateDir, {
      id: plan.id,
      kind: plan.kind,
      now: new Date("2026-07-03T00:01:00.000Z"),
      validate: () => { throw rejection; }
    })).rejects.toBe(rejection);

    const pending = join(stateDir, "reviewed-plans", `${plan.id}.json`);
    await expect(readFile(pending, "utf8")).resolves.toContain("domain-reject");
    expect(await readdir(join(stateDir, "reviewed-plans"))).toEqual([
      "domain-reject.json"
    ]);
  });

  it("never overwrites a concurrent pending plan while restoring validator rejection", async () => {
    const stateDir = await state("steward-reviewed-domain-race-");
    const directory = join(stateDir, "reviewed-plans");
    const plan = envelope("domain-race", "governance", {
      payload: { generation: "old" }
    });
    const replacement = envelope("domain-race", "governance", {
      payload: { generation: "new" }
    });
    await writeReviewedPlan(stateDir, plan);

    await expect(claimReviewedPlan(stateDir, {
      id: plan.id,
      kind: plan.kind,
      now: new Date("2026-07-03T00:01:00.000Z"),
      validate: async () => {
        await writeFile(
          join(directory, `${plan.id}.json`),
          `${JSON.stringify(replacement, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 }
        );
        throw new Error("reject old generation");
      }
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });

    expect(JSON.parse(await readFile(
      join(directory, `${plan.id}.json`),
      "utf8"
    ))).toMatchObject({ payload: { generation: "new" } });
    expect((await readdir(directory)).filter((name) => name.endsWith(".claimed")))
      .toHaveLength(1);
  });

  it("consumes kind-mismatched and expired plans without returning their payload", async () => {
    const stateDir = await state("steward-reviewed-rejected-");
    await writeReviewedPlan(stateDir, envelope("wrong-kind"));
    await writeReviewedPlan(stateDir, envelope("expired", "governance", {
      expiresAt: "2026-07-03T00:00:30.000Z"
    }));

    await expect(claimReviewedPlan(stateDir, {
      id: "wrong-kind",
      kind: "governance",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_KIND_MISMATCH" });
    await expect(claimReviewedPlan(stateDir, {
      id: "expired",
      kind: "governance",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_EXPIRED" });

    expect(await readdir(join(stateDir, "reviewed-plans"))).toEqual([]);
  });

  it("removes a claimed file when strict parsing detects tampering", async () => {
    const stateDir = await state("steward-reviewed-tampered-");
    await writeReviewedPlan(stateDir, envelope("tampered"));
    const path = join(stateDir, "reviewed-plans", "tampered.json");
    await writeFile(path, "{\"schemaVersion\":1,\"payload\":\"secret\"}\n", "utf8");

    await expect(claimReviewedPlan(stateDir, {
      id: "tampered",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
    expect(await readdir(join(stateDir, "reviewed-plans"))).toEqual([]);
  });

  it("strictly validates the envelope and JSON-serializable payload", async () => {
    const stateDir = await state("steward-reviewed-schema-");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeReviewedPlan(stateDir, {
      ...envelope("extra"),
      unexpected: true
    } as ReviewedPlanEnvelope)).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
    await expect(writeReviewedPlan(stateDir, envelope("backwards", "installation", {
      expiresAt: createdAt
    }))).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
    await expect(writeReviewedPlan(stateDir, envelope("non-json", "installation", {
      payload: { omitted: undefined }
    }))).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
    await expect(writeReviewedPlan(stateDir, envelope("circular", "installation", {
      payload: circular
    }))).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
  });

  it("rejects unsafe IDs without reaching paths outside the reviewed-plan directory", async () => {
    const stateDir = await state("steward-reviewed-id-");
    const sentinel = join(stateDir, "outside.json");
    await writeFile(sentinel, "keep", "utf8");

    for (const id of ["../outside", "..", "/tmp/escape", "bad\\path", "bad\u0000id"]) {
      await expect(writeReviewedPlan(stateDir, envelope(id))).rejects.toMatchObject({
        code: "REVIEWED_PLAN_INVALID"
      });
      await expect(claimReviewedPlan(stateDir, {
        id,
        kind: "installation"
      })).rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
      await expect(discardReviewedPlan(stateDir, id)).rejects.toMatchObject({
        code: "REVIEWED_PLAN_INVALID"
      });
    }
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it("accepts 128-character IDs and rejects 129-character IDs on disk", async () => {
    const stateDir = await state("steward-reviewed-id-length-");
    const accepted = `a${"b".repeat(127)}`;
    const rejected = `a${"b".repeat(128)}`;

    await writeReviewedPlan(stateDir, envelope(accepted));
    await expect(stat(join(stateDir, "reviewed-plans", `${accepted}.json`)))
      .resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(writeReviewedPlan(stateDir, envelope(rejected)))
      .rejects.toMatchObject({ code: "REVIEWED_PLAN_INVALID" });
  });

  it("reports a conflict instead of overwriting a preexisting plan", async () => {
    const stateDir = await state("steward-reviewed-conflict-");
    const first = envelope("same", "installation", { payload: { version: 1 } });
    await writeReviewedPlan(stateDir, first);

    await expect(writeReviewedPlan(stateDir, envelope("same", "installation", {
      payload: { version: 2 }
    }))).rejects.toMatchObject({ code: "REVIEWED_PLAN_CONFLICT" });
    await expect(claimReviewedPlan(stateDir, {
      id: "same",
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toEqual(first);
  });

  it("atomically refuses an external destination created in the publish window", async () => {
    const stateDir = await state("steward-reviewed-publish-race-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const destination = join(directory, "publish-race.json");
    fileSystemObservation.publishRaceDestination = destination;

    let result = "resolved";
    try {
      await writeReviewedPlan(stateDir, envelope("publish-race"));
    } catch (error) {
      result = error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown-error";
    } finally {
      fileSystemObservation.publishRaceDestination = undefined;
    }

    expect(result).toBe("REVIEWED_PLAN_CONFLICT");
    expect(await readFile(destination, "utf8")).toBe("external-sentinel");
    expect(await readdir(directory)).toEqual(["publish-race.json"]);
  });

  it("ignores a legacy fixed write lock without deleting it", async () => {
    const stateDir = await state("steward-reviewed-lock-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const lock = join(directory, ".locked.write.lock");
    await writeFile(lock, "other-owner", { encoding: "utf8", mode: 0o600 });

    await expect(writeReviewedPlan(stateDir, envelope("locked"))).resolves.toBeUndefined();
    await expect(readFile(lock, "utf8")).resolves.toBe("other-owner");
  });

  it("lets exactly one concurrent writer publish without lock residue", async () => {
    const stateDir = await state("steward-reviewed-concurrent-write-");
    const attempts = await Promise.allSettled([
      writeReviewedPlan(stateDir, envelope("concurrent", "installation", {
        payload: { writer: 1 }
      })),
      writeReviewedPlan(stateDir, envelope("concurrent", "installation", {
        payload: { writer: 2 }
      }))
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "REVIEWED_PLAN_CONFLICT" }
    });
    expect(await readdir(join(stateDir, "reviewed-plans"))).toEqual([
      "concurrent.json"
    ]);
  });

  it("rejects symlinked reviewed-plan directories and files", async () => {
    const linkedState = await state("steward-reviewed-linked-dir-");
    const externalDirectory = await state("steward-reviewed-external-");
    await symlink(externalDirectory, join(linkedState, "reviewed-plans"), "dir");

    await expect(writeReviewedPlan(linkedState, envelope("linked-dir")))
      .rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
    expect(await readdir(externalDirectory)).toEqual([]);

    const linkedFileState = await state("steward-reviewed-linked-file-");
    const directory = join(linkedFileState, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const target = join(linkedFileState, "secret-target.json");
    await writeFile(target, "secret", { encoding: "utf8", mode: 0o600 });
    await symlink(target, join(directory, "linked-file.json"));

    await expect(claimReviewedPlan(linkedFileState, {
      id: "linked-file",
      kind: "installation"
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
    expect(await readFile(target, "utf8")).toBe("secret");
  });

  it("atomically discards only pending state and leaves active claimed files alone", async () => {
    const stateDir = await state("steward-reviewed-discard-");
    await writeReviewedPlan(stateDir, envelope("discard-me"));
    const directory = join(stateDir, "reviewed-plans");
    const claimed = `discard-me.123-${residueUuid}.claimed`;
    await writeFile(join(directory, claimed), "active", { mode: 0o600 });
    await writeFile(join(directory, "keep.json"), "keep", { mode: 0o600 });

    await discardReviewedPlan(stateDir, "discard-me");

    expect((await readdir(directory)).sort()).toEqual([claimed, "keep.json"]);
  });

  it("removes expired and invalid pending plans but leaves live and unrelated files", async () => {
    const stateDir = await state("steward-reviewed-cleanup-");
    await writeReviewedPlan(stateDir, envelope("expired", "evidence-policy", {
      expiresAt: "2026-07-03T00:00:30.000Z"
    }));
    await writeReviewedPlan(stateDir, envelope("live", "evidence-erase"));
    const directory = join(stateDir, "reviewed-plans");
    await writeFile(join(directory, "invalid.json"), "secret invalid JSON", { mode: 0o600 });
    await writeFile(join(directory, "note.txt"), "keep", { mode: 0o600 });
    await writeFile(join(directory, "leftover.claimed"), "keep", { mode: 0o600 });

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T00:01:00.000Z")
    )).resolves.toBe(2);
    expect((await readdir(directory)).sort()).toEqual([
      "leftover.claimed",
      "live.json",
      "note.txt"
    ]);
  });

  it.each(["EACCES", "EIO"] as const)(
    "fails closed and preserves a live plan when its read fails with %s",
    async (code) => {
      const stateDir = await state(`steward-reviewed-cleanup-${code.toLowerCase()}-`);
      await writeReviewedPlan(stateDir, envelope(`live-${code.toLowerCase()}`));
      const path = join(
        stateDir,
        "reviewed-plans",
        `live-${code.toLowerCase()}.json`
      );
      fileSystemObservation.cleanupReadFailure = {
        id: `live-${code.toLowerCase()}`,
        code
      };

      let failure: unknown;
      try {
        await cleanupExpiredReviewedPlans(
          stateDir,
          new Date("2026-07-03T00:01:00.000Z")
        );
      } catch (error) {
        failure = error;
      } finally {
        fileSystemObservation.cleanupReadFailure = undefined;
      }

      expect(failure).toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
      await expect(readFile(path, "utf8")).resolves.toContain(`live-${code.toLowerCase()}`);
    }
  );

  it("never unlinks a new plan published after cleanup read the old plan", async () => {
    const stateDir = await state("steward-reviewed-cleanup-replacement-");
    const id = "replacement-race";
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T00:00:30.000Z",
      payload: { generation: "old" }
    }));
    const pause = pauseCleanupRead(id);
    const cleaning = cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T00:01:00.000Z")
    );
    await pause.reached;

    const claimOutcome = await claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T00:00:10.000Z")
    }).then(
      () => "claimed",
      (error: unknown) => error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown"
    );
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      payload: { generation: "new" }
    }));
    pause.release();

    expect(claimOutcome).toBe("claimed");
    await expect(cleaning).resolves.toBe(0);
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    })).resolves.toMatchObject({ payload: { generation: "new" } });
  });

  it("never hides a live pending plan from its first concurrent claim", async () => {
    const stateDir = await state("steward-reviewed-cleanup-live-claim-");
    const id = "live-claim";
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      payload: { generation: "live" }
    }));
    const pause = pauseCleanupRead(id);
    const cleaning = cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T00:01:00.000Z")
    );
    await pause.reached;

    const claimOutcome = await claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T00:01:00.000Z")
    }).then(
      (plan) => plan.payload,
      (error: unknown) => error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown"
    );
    pause.release();

    await expect(cleaning).resolves.toBe(0);
    expect(claimOutcome).toEqual({ generation: "live" });
    expect(await readdir(join(stateDir, "reviewed-plans"))).toEqual([]);
  });

  it("does not replay a stale hard-link duplicate after its pending plan was claimed", async () => {
    const stateDir = await state("steward-reviewed-cleanup-replay-");
    const directory = join(stateDir, "reviewed-plans");
    const id = "single-use-crash";
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { nonce: "one-time" }
    }));
    const pending = join(directory, `${id}.json`);
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await link(pending, owned);
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);
    const [pendingMetadata, ownedMetadata] = await Promise.all([
      lstat(pending, { bigint: true }),
      lstat(owned, { bigint: true })
    ]);
    expect([pendingMetadata.dev, pendingMetadata.ino]).toEqual([
      ownedMetadata.dev,
      ownedMetadata.ino
    ]);

    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).resolves.toMatchObject({ payload: { nonce: "one-time" } });
    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).resolves.toBe(0);
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
    await expect(readFile(owned, "utf8")).resolves.toContain("one-time");
  });

  it("removes a stale same-inode cleanup duplicate while pending remains claimable once", async () => {
    const stateDir = await state("steward-reviewed-cleanup-duplicate-");
    const directory = join(stateDir, "reviewed-plans");
    const id = "same-inode";
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z"
    }));
    const pending = join(directory, `${id}.json`);
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await link(pending, owned);
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);
    fileSystemObservation.exactFileIdentities = new Map([
      [owned, { dev: 1n, ino: 42n }],
      [pending, { dev: 1n, ino: 42n }]
    ]);

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).resolves.toBe(1);
    fileSystemObservation.exactFileIdentities = undefined;
    await expect(lstat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).resolves.toMatchObject({ id });
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
  });

  it("retains a stale live cleanup artifact without making it claimable until expiry", async () => {
    const stateDir = await state("steward-reviewed-cleanup-live-residue-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const id = "stale-live";
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await writeFile(owned, `${JSON.stringify(envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { generation: "recovered" }
    }))}\n`, { mode: 0o600 });
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).resolves.toBe(0);
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).rejects.toMatchObject({ code: "REVIEWED_PLAN_NOT_FOUND" });
    await expect(readFile(owned, "utf8")).resolves.toContain("recovered");
    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T06:00:00.000Z")
    )).resolves.toBe(1);
    await expect(lstat(owned)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps stale live cleanup data when a newer pending plan blocks restore", async () => {
    const stateDir = await state("steward-reviewed-cleanup-newer-conflict-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const id = "newer-conflict";
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await writeFile(owned, `${JSON.stringify(envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { generation: "old-owned" }
    }))}\n`, { mode: 0o600 });
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { generation: "new-pending" }
    }));

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
    await expect(readFile(owned, "utf8")).resolves.toContain("old-owned");
    await expect(claimReviewedPlan(stateDir, {
      id,
      kind: "installation",
      now: new Date("2026-07-03T03:00:00.000Z")
    })).resolves.toMatchObject({ payload: { generation: "new-pending" } });
  });

  it("preserves different 64-bit file identities that collide as Numbers", async () => {
    const stateDir = await state("steward-reviewed-cleanup-bigint-identity-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const id = "bigint-identity";
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await writeFile(owned, `${JSON.stringify(envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { generation: "owned" }
    }))}\n`, { mode: 0o600 });
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z",
      payload: { generation: "pending" }
    }));
    const pending = join(directory, `${id}.json`);
    const ownedIno = 9_007_199_254_740_992n;
    const pendingIno = 9_007_199_254_740_993n;
    expect(Number(ownedIno)).toBe(Number(pendingIno));
    fileSystemObservation.exactFileIdentities = new Map([
      [owned, { dev: 1n, ino: ownedIno }],
      [pending, { dev: 1n, ino: pendingIno }]
    ]);

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
    fileSystemObservation.exactFileIdentities = undefined;
    await expect(readFile(owned, "utf8")).resolves.toContain("owned");
    await expect(readFile(pending, "utf8")).resolves.toContain("pending");
  });

  it("preserves live cleanup data when exact file identity is unavailable", async () => {
    const stateDir = await state("steward-reviewed-cleanup-zero-identity-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const id = "zero-identity";
    const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
    await writeFile(owned, `${JSON.stringify(envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z"
    }))}\n`, { mode: 0o600 });
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await utimes(owned, stale, stale);
    await writeReviewedPlan(stateDir, envelope(id, "installation", {
      expiresAt: "2026-07-03T05:00:00.000Z"
    }));
    const pending = join(directory, `${id}.json`);
    fileSystemObservation.exactFileIdentities = new Map([
      [owned, { dev: 0n, ino: 0n }],
      [pending, { dev: 0n, ino: 0n }]
    ]);

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).rejects.toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
    fileSystemObservation.exactFileIdentities = undefined;
    await expect(readFile(owned, "utf8")).resolves.toContain(id);
    await expect(readFile(pending, "utf8")).resolves.toContain(id);
  });

  it.each(["EACCES", "EIO"] as const)(
    "preserves stale cleanup data when reading it fails with %s",
    async (code) => {
      const stateDir = await state(`steward-reviewed-cleanup-owned-${code.toLowerCase()}-`);
      const directory = join(stateDir, "reviewed-plans");
      await mkdir(directory, { mode: 0o700 });
      const id = `owned-${code.toLowerCase()}`;
      const owned = join(directory, `.${id}.123-${residueUuid}.cleanup`);
      await writeFile(owned, `${JSON.stringify(envelope(id, "installation", {
        expiresAt: "2026-07-03T05:00:00.000Z"
      }))}\n`, { mode: 0o600 });
      const stale = new Date("2026-07-03T01:00:00.000Z");
      await utimes(owned, stale, stale);
      fileSystemObservation.cleanupReadFailure = { id, code };

      let failure: unknown;
      try {
        await cleanupExpiredReviewedPlans(
          stateDir,
          new Date("2026-07-03T03:00:00.000Z")
        );
      } catch (error) {
        failure = error;
      } finally {
        fileSystemObservation.cleanupReadFailure = undefined;
      }

      expect(failure).toMatchObject({ code: "REVIEWED_PLAN_UNSAFE_STATE" });
      await expect(readFile(owned, "utf8")).resolves.toContain(id);
    }
  );

  it("deletes stale cleanup artifacts only after validating expired or invalid data", async () => {
    const stateDir = await state("steward-reviewed-cleanup-owned-removable-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const expired = join(directory, `.owned-expired.123-${residueUuid}.cleanup`);
    const invalid = join(directory, `.owned-invalid.123-${residueUuid}.cleanup`);
    await writeFile(expired, `${JSON.stringify(envelope("owned-expired", "installation", {
      expiresAt: "2026-07-03T02:00:00.000Z"
    }))}\n`, { mode: 0o600 });
    await writeFile(invalid, "invalid", { mode: 0o600 });
    const stale = new Date("2026-07-03T01:00:00.000Z");
    await Promise.all([
      utimes(expired, stale, stale),
      utimes(invalid, stale, stale)
    ]);

    await expect(cleanupExpiredReviewedPlans(
      stateDir,
      new Date("2026-07-03T03:00:00.000Z")
    )).resolves.toBe(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes only stale strict crash residues after a one-hour grace window", async () => {
    const stateDir = await state("steward-reviewed-cleanup-residue-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const staleNames = [
      `.stale-temp.123-${residueUuid}.tmp`,
      `stale-claim.123-${residueUuid}.claimed`,
      `.stale-cleanup.123-${residueUuid}.cleanup`
    ];
    const freshNames = [
      `.fresh-temp.123-${residueUuid}.tmp`,
      `fresh-claim.123-${residueUuid}.claimed`,
      `.fresh-cleanup.123-${residueUuid}.cleanup`
    ];
    const unrelatedNames = [
      "manual.tmp",
      "manual.claimed",
      ".manual.lock",
      ".legacy.write.lock"
    ];
    for (const name of [...staleNames, ...freshNames, ...unrelatedNames]) {
      await writeFile(join(directory, name), "residue", { mode: 0o600 });
    }
    const now = new Date("2026-07-03T03:00:00.000Z");
    const stale = new Date("2026-07-03T01:00:00.000Z");
    const fresh = new Date("2026-07-03T02:30:00.000Z");
    await Promise.all(staleNames.map((name) => utimes(join(directory, name), stale, stale)));
    await Promise.all(freshNames.map((name) => utimes(join(directory, name), fresh, fresh)));

    await expect(cleanupExpiredReviewedPlans(stateDir, now)).resolves.toBe(3);
    expect((await readdir(directory)).sort()).toEqual(
      [...freshNames, ...unrelatedNames].sort()
    );
  });

  it("shares a 1000-candidate cleanup bound across pending plans and crash residues", async () => {
    const stateDir = await state("steward-reviewed-cleanup-bound-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await Promise.all(Array.from({ length: 501 }, async (_, index) => {
      const id = `invalid-${String(index).padStart(4, "0")}`;
      await writeFile(join(directory, `${id}.json`), "invalid", { mode: 0o600 });
    }));
    const stale = new Date("2026-07-03T00:00:00.000Z");
    await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      const id = `residue-${String(index).padStart(4, "0")}`;
      const path = join(directory, `.${id}.123-${residueUuid}.tmp`);
      await writeFile(path, "residue", { mode: 0o600 });
      await utimes(path, stale, stale);
    }));
    await writeFile(join(directory, "unrelated.txt"), "keep", { mode: 0o600 });
    await writeFile(join(directory, "leftover.claimed"), "keep", { mode: 0o600 });

    fileSystemObservation.cleanupDirectory = directory;
    fileSystemObservation.cleanupInspectedPaths = [];
    fileSystemObservation.cleanupUsedStreamingDirectory = false;
    let removed: number;
    try {
      removed = await cleanupExpiredReviewedPlans(
        stateDir,
        new Date("2026-07-03T02:00:00.000Z")
      );
    } finally {
      fileSystemObservation.cleanupDirectory = undefined;
    }

    expect(removed).toBe(1000);
    expect(fileSystemObservation.cleanupUsedStreamingDirectory).toBe(true);
    expect(fileSystemObservation.cleanupInspectedPaths.length).toBeLessThanOrEqual(1002);
    expect(fileSystemObservation.cleanupInspectedPaths.every((path) =>
      path.endsWith(".json") || path.endsWith(".cleanup")
    )).toBe(true);
    const remaining = await readdir(directory);
    expect(remaining.filter((name) =>
      name.endsWith(".json") || /^\.residue-.*\.tmp$/.test(name)
    )).toHaveLength(1);
    expect(remaining).toContain("unrelated.txt");
    expect(remaining).toContain("leftover.claimed");
  });
});
