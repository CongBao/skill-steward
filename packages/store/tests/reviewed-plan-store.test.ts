import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fileSystemObservation = vi.hoisted(() => ({
  publishRaceDestination: undefined as string | undefined,
  cleanupDirectory: undefined as string | undefined,
  cleanupInspectedPaths: [] as string[],
  cleanupUsedStreamingDirectory: false
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
    open: async (...args: Parameters<typeof actual.open>) => {
      if (
        fileSystemObservation.cleanupDirectory !== undefined
        && typeof args[1] === "number"
        && String(args[0]).startsWith(`${fileSystemObservation.cleanupDirectory}/`)
      ) {
        fileSystemObservation.cleanupInspectedPaths.push(String(args[0]));
      }
      return actual.open(...args);
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
  writeReviewedPlan,
  type ReviewedPlanEnvelope,
  type ReviewedPlanKind
} from "../src/reviewed-plan-store.js";

const createdAt = "2026-07-03T00:00:00.000Z";
const expiresAt = "2026-07-03T00:05:00.000Z";

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
  return mkdtemp(join(tmpdir(), prefix));
}

describe("reviewed plan store", () => {
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

  it("does not remove a write lock owned by another process", async () => {
    const stateDir = await state("steward-reviewed-lock-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    const lock = join(directory, ".locked.write.lock");
    await writeFile(lock, "other-owner", { encoding: "utf8", mode: 0o600 });

    await expect(writeReviewedPlan(stateDir, envelope("locked")))
      .rejects.toMatchObject({ code: "REVIEWED_PLAN_CONFLICT" });
    await expect(readFile(lock, "utf8")).resolves.toBe("other-owner");
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

  it("discards pending and claimed leftovers without touching other files", async () => {
    const stateDir = await state("steward-reviewed-discard-");
    await writeReviewedPlan(stateDir, envelope("discard-me"));
    const directory = join(stateDir, "reviewed-plans");
    await rename(
      join(directory, "discard-me.json"),
      join(directory, "discard-me.interrupted.claimed")
    );
    await writeFile(join(directory, "keep.json"), "keep", { mode: 0o600 });

    await discardReviewedPlan(stateDir, "discard-me");

    expect(await readdir(directory)).toEqual(["keep.json"]);
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

  it("processes at most 1000 pending JSON files per cleanup", async () => {
    const stateDir = await state("steward-reviewed-cleanup-bound-");
    const directory = join(stateDir, "reviewed-plans");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const expired = envelope("placeholder", "integration", {
      expiresAt: "2026-07-03T00:00:30.000Z"
    });
    await Promise.all(Array.from({ length: 1001 }, async (_, index) => {
      const id = `expired-${String(index).padStart(4, "0")}`;
      await writeFile(join(directory, `${id}.json`), `${JSON.stringify({
        ...expired,
        id
      })}\n`, { mode: 0o600 });
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
        new Date("2026-07-03T00:01:00.000Z")
      );
    } finally {
      fileSystemObservation.cleanupDirectory = undefined;
    }

    expect(removed).toBe(1000);
    expect(fileSystemObservation.cleanupUsedStreamingDirectory).toBe(true);
    expect(fileSystemObservation.cleanupInspectedPaths).toHaveLength(1000);
    expect(fileSystemObservation.cleanupInspectedPaths.every((path) =>
      path.endsWith(".json")
    )).toBe(true);
    const remaining = await readdir(directory);
    expect(remaining.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(remaining).toContain("unrelated.txt");
    expect(remaining).toContain("leftover.claimed");
  });
});
