import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_METADATA_BYTES,
  parseJsoncObject,
  parseJsonObject,
  parseTomlObject,
  readBoundedText,
  readJsonObject,
  readJsoncObject,
  readTomlObject,
  resolveContainedComponent
} from "../src/inventory/metadata.js";
import {
  readBoundedTextInternal,
  type MetadataFileHandle,
  type MetadataIo,
  type MetadataStat
} from "../src/inventory/metadata-internal.js";

const TEST_NO_FOLLOW = 0x20_000;

function metadataStat(
  device: number,
  inode: number,
  size: number,
  options: { file?: boolean; symlink?: boolean } = {}
): MetadataStat {
  return {
    dev: device,
    ino: inode,
    birthtimeMs: 1_234,
    size,
    isFile: () => options.file ?? true,
    isSymbolicLink: () => options.symlink ?? false
  };
}

function metadataHandle(
  stat: () => Promise<MetadataStat>,
  read: MetadataFileHandle["read"],
  close: () => Promise<void> = async () => undefined
): MetadataFileHandle {
  return { stat, read, close };
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("deterministic bounded metadata races", () => {
  const path = "/plugin/metadata.json";
  const safe = metadataStat(1, 10, 13);
  const outside = metadataStat(2, 20, 20);

  it("refuses an outside symlink swapped after lstat when no-follow is supported", async () => {
    let pathState: "safe" | "outside-symlink" = "safe";
    let openFlags = 0;
    const events: string[] = [];
    const followedHandle = metadataHandle(
      async () => {
        events.push("handle-stat");
        return outside;
      },
      async () => {
        events.push("read");
        return { bytesRead: 0 };
      }
    );
    const io: MetadataIo = {
      noFollowFlag: TEST_NO_FOLLOW,
      lstat: async () => {
        events.push("lstat");
        expect(pathState).toBe("safe");
        return safe;
      },
      open: async (_path, flags) => {
        pathState = "outside-symlink";
        openFlags = flags;
        events.push("swap-to-outside-symlink", "open-no-follow");
        void followedHandle;
        throw codedError("ELOOP");
      }
    };

    await expect(readBoundedTextInternal(path, {}, io)).rejects.toMatchObject({
      code: "METADATA_SYMLINK_REFUSED"
    });
    expect(pathState).toBe("outside-symlink");
    expect(openFlags & TEST_NO_FOLLOW).toBe(TEST_NO_FOLLOW);
    expect(events).toEqual([
      "lstat",
      "swap-to-outside-symlink",
      "open-no-follow"
    ]);
  });

  it.each([
    { label: "zero no-follow flag", noFollowFlag: 0, unsupportedCode: undefined },
    { label: "unsupported no-follow fallback", noFollowFlag: TEST_NO_FOLLOW, unsupportedCode: "EINVAL" }
  ])(
    "rejects a followed outside symlink before read with $label",
    async ({ noFollowFlag, unsupportedCode }) => {
      let pathState: "safe" | "outside-symlink" = "safe";
      let opens = 0;
      let reads = 0;
      let closes = 0;
      const followedHandle = metadataHandle(
        async () => outside,
        async () => {
          reads += 1;
          return { bytesRead: 0 };
        },
        async () => {
          closes += 1;
        }
      );
      const io: MetadataIo = {
        noFollowFlag,
        lstat: async () => safe,
        open: async () => {
          opens += 1;
          pathState = "outside-symlink";
          if (unsupportedCode && opens === 1) throw codedError(unsupportedCode);
          return followedHandle;
        }
      };

      await expect(readBoundedTextInternal(path, {}, io)).rejects.toMatchObject({
        code: "METADATA_IDENTITY_CHANGED"
      });
      expect(pathState).toBe("outside-symlink");
      expect(opens).toBe(unsupportedCode ? 2 : 1);
      expect(reads).toBe(0);
      expect(closes).toBe(1);
    }
  );

  it("rejects a different regular file swapped after lstat before any read", async () => {
    let pathState: "safe" | "different-regular" = "safe";
    let reads = 0;
    let closes = 0;
    const io: MetadataIo = {
      noFollowFlag: 0,
      lstat: async () => safe,
      open: async () => {
        pathState = "different-regular";
        return metadataHandle(
          async () => outside,
          async () => {
            reads += 1;
            return { bytesRead: 0 };
          },
          async () => {
            closes += 1;
          }
        );
      }
    };

    await expect(readBoundedTextInternal(path, {}, io)).rejects.toMatchObject({
      code: "METADATA_IDENTITY_CHANGED"
    });
    expect(pathState).toBe("different-regular");
    expect(reads).toBe(0);
    expect(closes).toBe(1);
  });

  it("uses the extra byte to reject growth after handle stat and before read", async () => {
    let handleStatReturned = false;
    let reads = 0;
    let closes = 0;
    const initial = metadataStat(1, 10, 1);
    const io: MetadataIo = {
      noFollowFlag: 0,
      lstat: async () => initial,
      open: async () => metadataHandle(
        async () => {
          handleStatReturned = true;
          return initial;
        },
        async (buffer, offset, length) => {
          expect(handleStatReturned).toBe(true);
          expect(length).toBe(MAX_METADATA_BYTES + 1);
          reads += 1;
          buffer.fill(0x78, offset, offset + length);
          return { bytesRead: length };
        },
        async () => {
          closes += 1;
        }
      )
    };

    await expect(readBoundedTextInternal(path, {}, io)).rejects.toMatchObject({
      code: "METADATA_TOO_LARGE"
    });
    expect(reads).toBe(1);
    expect(closes).toBe(1);
  });

  it("reads and parses valid metadata when the opened identity is unchanged", async () => {
    const content = Buffer.from('{"safe":true}');
    const unchanged = metadataStat(1, 10, content.length);
    let reads = 0;
    let closes = 0;
    const io: MetadataIo = {
      noFollowFlag: 0,
      lstat: async () => unchanged,
      open: async () => metadataHandle(
        async () => unchanged,
        async (buffer, offset, length, position) => {
          reads += 1;
          const bytesRead = content.copy(
            buffer,
            offset,
            position,
            Math.min(content.length, position + length)
          );
          return { bytesRead };
        },
        async () => {
          closes += 1;
        }
      )
    };

    const text = await readBoundedTextInternal(
      path,
      { expectedIdentity: { device: 1, inode: 10, birthtimeMs: 1_234 } },
      io
    );

    expect(parseJsonObject(text)).toEqual({ safe: true });
    expect(reads).toBe(2);
    expect(closes).toBe(1);
  });
});

describe("bounded inventory metadata", () => {
  const identity = async (path: string) => {
    const metadata = await lstat(path);
    return {
      device: metadata.dev,
      inode: metadata.ino,
      birthtimeMs: metadata.birthtimeMs
    };
  };

  it("rejects files larger than 256 KiB before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
    const path = join(root, "large.json");
    await writeFile(path, "x".repeat(256 * 1024 + 1));

    await expect(readBoundedText(path)).rejects.toMatchObject({
      code: "METADATA_TOO_LARGE"
    });
  });

  it("rejects directories and reports a stable error code", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));

    await expect(readBoundedText(root)).rejects.toMatchObject({
      code: "METADATA_NOT_FILE"
    });
  });

  it("parses JSONC and TOML objects", () => {
    expect(parseJsoncObject('{ // comment\n "enabled": true,\n}')).toEqual({
      enabled: true
    });
    expect(parseTomlObject('[plugins."review@vendor"]\nenabled = false')).toMatchObject({
      plugins: { "review@vendor": { enabled: false } }
    });
  });

  it("rejects malformed JSONC instead of returning a partial object", () => {
    expect(() => parseJsoncObject('{ "enabled": true, "broken": }')).toThrowError(
      expect.objectContaining({ code: "METADATA_INVALID_JSONC" })
    );
  });

  it("reads JSON, JSONC, and TOML object files without accepting arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
    const json = join(root, "plugin.json");
    const jsonc = join(root, "settings.jsonc");
    const toml = join(root, "config.toml");
    const array = join(root, "array.json");
    await writeFile(json, '{"skills":"skills"}');
    await writeFile(jsonc, '{ /* enabled */ "enabled": true }');
    await writeFile(toml, "[plugins.demo]\nenabled = true");
    await writeFile(array, "[]");

    await expect(readJsonObject(json)).resolves.toEqual({ skills: "skills" });
    await expect(readJsoncObject(jsonc)).resolves.toEqual({ enabled: true });
    await expect(readTomlObject(toml)).resolves.toMatchObject({
      plugins: { demo: { enabled: true } }
    });
    await expect(readJsonObject(array)).rejects.toMatchObject({
      code: "METADATA_NOT_OBJECT"
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a static final-component symlink",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
      const outside = join(root, "outside.json");
      const linked = join(root, "linked.json");
      await writeFile(outside, '{"canary":"outside"}');
      await symlink(outside, linked, "file");

      await expect(readJsonObject(linked)).rejects.toMatchObject({
        code: "METADATA_SYMLINK_REFUSED"
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "smoke rejects a captured identity whose path is already an outside symlink",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
      const path = join(root, "metadata.json");
      const outside = join(root, "outside.json");
      await writeFile(path, '{"safe":true}');
      const expectedIdentity = await identity(path);
      await writeFile(outside, '{"canary":"outside"}');
      await rm(path);
      await symlink(outside, path, "file");

      await expect(readJsonObject(path, { expectedIdentity })).rejects.toMatchObject({
        code: "METADATA_SYMLINK_REFUSED"
      });
    }
  );

  it("smoke rejects a captured identity whose path is already a different file", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
    const path = join(root, "metadata.toml");
    await writeFile(path, "safe = true\n");
    const expectedIdentity = await identity(path);
    await rm(path);
    await writeFile(path, 'canary = "outside"\n');

    await expect(readTomlObject(path, { expectedIdentity })).rejects.toMatchObject({
      code: "METADATA_IDENTITY_CHANGED"
    });
  });

  it("parses a valid file when its captured identity still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
    const path = join(root, "metadata.json");
    await writeFile(path, '{"safe":true}');
    const expectedIdentity = await identity(path);

    await expect(readJsonObject(path, { expectedIdentity })).resolves.toEqual({
      safe: true
    });
  });

  it("retains bounded growth rejection after identity capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-metadata-"));
    const path = join(root, "growing.json");
    await writeFile(path, "{");
    const expectedIdentity = await identity(path);
    await appendFile(path, "x".repeat(256 * 1024 + 1));

    await expect(readBoundedText(path, { expectedIdentity })).rejects.toMatchObject({
      code: "METADATA_TOO_LARGE"
    });
  });
});

describe("contained plugin component paths", () => {
  it("returns an existing component whose normalized and physical paths stay contained", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    const skills = join(plugin, "components", "skills");
    await mkdir(skills, { recursive: true });

    await expect(resolveContainedComponent(plugin, "components/skills")).resolves.toBe(
      await realpath(skills)
    );
  });

  it("rejects absolute and parent-escaping declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    await mkdir(plugin);

    await expect(resolveContainedComponent(plugin, "../outside")).rejects.toMatchObject({
      code: "COMPONENT_PATH_ESCAPE"
    });
    await expect(resolveContainedComponent(plugin, resolve(root, "outside"))).rejects.toMatchObject({
      code: "COMPONENT_PATH_ABSOLUTE"
    });
  });

  it("distinguishes a contained missing component from a path escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    await mkdir(plugin);

    await expect(resolveContainedComponent(plugin, "missing-skills")).rejects.toMatchObject({
      code: "COMPONENT_PATH_MISSING"
    });
  });

  it("bounds missing-component ancestor probes by the inventory depth maximum", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-depth-"));
    const plugin = join(root, "plugin");
    await mkdir(plugin);
    const deeplyNested = Array.from({ length: 200 }, () => "nested").join("/");

    await expect(
      resolveContainedComponent(plugin, deeplyNested)
    ).rejects.toMatchObject({ code: "COMPONENT_PATH_DEPTH_LIMIT" });
  });

  it("classifies an ENOTDIR leaf below a contained file as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    await mkdir(plugin);
    await writeFile(join(plugin, "manifest-file"), "metadata");

    await expect(
      resolveContainedComponent(plugin, "manifest-file/missing")
    ).rejects.toMatchObject({ code: "COMPONENT_PATH_MISSING" });
  });

  it.skipIf(process.platform === "win32")("rejects a missing leaf beneath an escaping symlink ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    const outside = join(root, "outside");
    await mkdir(plugin);
    await mkdir(outside);
    await symlink(outside, join(plugin, "link"), "dir");

    await expect(resolveContainedComponent(plugin, "link/missing")).rejects.toMatchObject({
      code: "COMPONENT_REALPATH_ESCAPE"
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink whose real path leaves the plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-component-"));
    const plugin = join(root, "plugin");
    const outside = join(root, "outside");
    await mkdir(plugin);
    await mkdir(outside);
    await symlink(outside, join(plugin, "skills"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveContainedComponent(plugin, "skills")).rejects.toMatchObject({
      code: "COMPONENT_REALPATH_ESCAPE"
    });
  });
});
