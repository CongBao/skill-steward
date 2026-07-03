import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  afterLstat: undefined as ((path: string) => Promise<void>) | undefined,
  afterClosePath: undefined as string | undefined,
  afterClose: undefined as (() => Promise<void>) | undefined,
  zeroIdentityPath: undefined as string | undefined,
  failRmContaining: undefined as string | undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      const result = await Reflect.apply(actual.lstat, actual, args);
      const path = String(args[0]);
      await hooks.afterLstat?.(path);
      if (path !== hooks.zeroIdentityPath) return result;
      return new Proxy(result as object, {
        get(target, property, receiver) {
          if (property === "dev" || property === "ino") {
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "bigint" ? 0n : 0;
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    open: async (...args: unknown[]) => {
      const handle = await Reflect.apply(actual.open, actual, args);
      if (String(args[0]) !== hooks.afterClosePath) return handle;
      return new Proxy(handle as object, {
        get(target, property, receiver) {
          if (property === "close") {
            return async () => {
              await Reflect.apply(
                Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown,
                target,
                []
              );
              const callback = hooks.afterClose;
              hooks.afterClose = undefined;
              hooks.afterClosePath = undefined;
              await callback?.();
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    },
    rm: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (hooks.failRmContaining && path.includes(hooks.failRmContaining)) {
        hooks.failRmContaining = undefined;
        throw new Error("simulated process termination before recursive cleanup");
      }
      return Reflect.apply(actual.rm, actual, args);
    }
  };
});

describe("StagingRegistry filesystem identity races", () => {
  it("refuses creation when the staging root is replaced after inspection", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const base = await fs.mkdtemp(join(tmpdir(), "steward-create-root-race-"));
    const stateDirectory = join(base, "state");
    const root = join(stateDirectory, "staging");
    const original = join(stateDirectory, "original-staging");
    const replacementTarget = join(base, "replacement-target");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(replacementTarget);
    let replaced = false;
    hooks.afterLstat = async (path) => {
      if (path !== root || replaced) return;
      replaced = true;
      hooks.afterLstat = undefined;
      await fs.rename(root, original);
      await fs.symlink(replacementTarget, root, "dir");
    };
    const { StagingRegistry } = await import("../src/staging.js");

    await expect(new StagingRegistry({
      stateDirectory,
      now: () => 1,
      id: () => "preview-root-race"
    }).create({ ttlMs: 100 })).rejects.toMatchObject({ code: "UNSAFE_PREVIEW_STATE" });
    await expect(fs.access(join(replacementTarget, "preview-root-race", "preview.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a replacement preview untouched when expiry loses ownership before rename", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const base = await fs.mkdtemp(join(tmpdir(), "steward-expire-preview-race-"));
    const stateDirectory = join(base, "state");
    const { StagingRegistry } = await import("../src/staging.js");
    const registry = new StagingRegistry({
      stateDirectory,
      now: () => 1,
      id: () => "preview-expire-race"
    });
    const preview = await registry.create({ ttlMs: 100 });
    const original = join(stateDirectory, "original-preview");
    const metadataPath = join(preview.directory, "preview.json");
    const metadata = await fs.readFile(metadataPath, "utf8");
    hooks.afterClosePath = metadataPath;
    hooks.afterClose = async () => {
      await fs.rename(preview.directory, original);
      await fs.mkdir(preview.directory);
      await fs.writeFile(metadataPath, metadata, { mode: 0o600 });
      await fs.writeFile(join(preview.directory, "replacement-sentinel"), "keep");
    };

    await expect(registry.expire(preview.id)).rejects.toMatchObject({
      code: "UNSAFE_PREVIEW_STATE"
    });
    await expect(fs.readFile(join(preview.directory, "replacement-sentinel"), "utf8"))
      .resolves.toBe("keep");
    await expect(fs.access(original)).resolves.toBeUndefined();
  });

  it("rejects unavailable zero filesystem identities", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const base = await fs.mkdtemp(join(tmpdir(), "steward-zero-identity-"));
    const stateDirectory = join(base, "state");
    const root = join(stateDirectory, "staging");
    await fs.mkdir(root, { recursive: true });
    hooks.zeroIdentityPath = root;
    const { StagingRegistry } = await import("../src/staging.js");

    await expect(new StagingRegistry({
      stateDirectory,
      now: () => 1,
      id: () => "preview-zero-identity"
    }).create({ ttlMs: 100 })).rejects.toMatchObject({ code: "UNSAFE_PREVIEW_STATE" });
    hooks.zeroIdentityPath = undefined;
    await expect(fs.access(join(root, "preview-zero-identity", "preview.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an old strict cleanup tombstone without stealing a fresh one", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const base = await fs.mkdtemp(join(tmpdir(), "steward-tombstone-recovery-"));
    const stateDirectory = join(base, "state");
    let now = 1_000;
    const { StagingRegistry } = await import("../src/staging.js");
    const preview = await new StagingRegistry({
      stateDirectory,
      now: () => now,
      id: () => "preview-crash-recovery"
    }).create({ ttlMs: 100 });
    hooks.failRmContaining = `.expired-${preview.id}-`;

    await expect(new StagingRegistry({ stateDirectory, now: () => now }).expire(preview.id))
      .rejects.toThrow("simulated process termination");
    const root = join(stateDirectory, "staging");
    const [tombstone] = (await fs.readdir(root)).filter((name) => name.startsWith(".expired-"));
    expect(tombstone).toMatch(new RegExp(
      `^\\.expired-${preview.id}-1000-[0-9a-f]{8}-[0-9a-f-]{27}$`
    ));
    if (!tombstone) throw new Error("tombstone missing");

    now = 1_000 + 60 * 60 * 1_000;
    await expect(new StagingRegistry({ stateDirectory, now: () => now }).cleanupExpired())
      .resolves.toBe(0);
    await expect(fs.access(join(root, tombstone))).resolves.toBeUndefined();

    now += 1;
    await expect(new StagingRegistry({ stateDirectory, now: () => now }).cleanupExpired())
      .resolves.toBe(1);
    await expect(fs.access(join(root, tombstone))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
