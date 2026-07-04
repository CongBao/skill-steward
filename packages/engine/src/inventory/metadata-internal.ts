import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { InventoryError, type InventoryPathIdentity } from "./domain.js";

export const MAX_METADATA_BYTES = 256 * 1024;

export interface SecureMetadataReadOptions {
  expectedIdentity?: InventoryPathIdentity;
}

/** @internal Test seam for deterministic filesystem transition coverage. */
export interface MetadataStat {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** @internal Test seam for deterministic filesystem transition coverage. */
export interface MetadataFileHandle {
  stat(): Promise<MetadataStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** @internal Test seam for deterministic filesystem transition coverage. */
export interface MetadataIo {
  readonly noFollowFlag: number;
  lstat(path: string): Promise<MetadataStat>;
  open(path: string, flags: number): Promise<MetadataFileHandle>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function identity(metadata: MetadataStat): InventoryPathIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    birthtimeMs: metadata.birthtimeMs
  };
}

function sameIdentity(
  left: InventoryPathIdentity,
  right: InventoryPathIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs;
}

function identityChanged(): InventoryError {
  return new InventoryError(
    "METADATA_IDENTITY_CHANGED",
    "Metadata file identity changed during secure read"
  );
}

function symlinkRefused(): InventoryError {
  return new InventoryError(
    "METADATA_SYMLINK_REFUSED",
    "Metadata path cannot be a symbolic link"
  );
}

function unreadable(path: string): InventoryError {
  return new InventoryError(
    "METADATA_UNREADABLE",
    `Cannot read metadata file: ${path}`
  );
}

async function openWithoutFollowingFinalSymlink(
  path: string,
  io: MetadataIo
): Promise<MetadataFileHandle> {
  try {
    return await io.open(path, constants.O_RDONLY | io.noFollowFlag);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw symlinkRefused();
    if (
      io.noFollowFlag !== 0 &&
      (errorCode(error) === "EINVAL" || errorCode(error) === "ENOTSUP")
    ) {
      return io.open(path, constants.O_RDONLY);
    }
    throw error;
  }
}

/** @internal Used directly only by deterministic filesystem transition tests. */
export async function readBoundedTextInternal(
  path: string,
  options: SecureMetadataReadOptions,
  io: MetadataIo
): Promise<string> {
  let before;
  try {
    before = await io.lstat(path);
  } catch {
    throw unreadable(path);
  }
  if (before.isSymbolicLink()) throw symlinkRefused();
  if (!before.isFile()) {
    throw new InventoryError(
      "METADATA_NOT_FILE",
      `Metadata path is not a file: ${path}`
    );
  }
  if (before.size > MAX_METADATA_BYTES) {
    throw new InventoryError(
      "METADATA_TOO_LARGE",
      `Metadata file exceeds 256 KiB: ${path}`
    );
  }
  const beforeIdentity = identity(before);
  if (
    options.expectedIdentity &&
    !sameIdentity(beforeIdentity, options.expectedIdentity)
  ) {
    throw identityChanged();
  }

  let handle;
  try {
    handle = await openWithoutFollowingFinalSymlink(path, io);
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw unreadable(path);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new InventoryError(
        "METADATA_NOT_FILE",
        `Metadata path is not a file: ${path}`
      );
    }
    const openedIdentity = identity(metadata);
    if (
      !sameIdentity(beforeIdentity, openedIdentity) ||
      (options.expectedIdentity &&
        !sameIdentity(options.expectedIdentity, openedIdentity))
    ) {
      throw identityChanged();
    }
    if (metadata.size > MAX_METADATA_BYTES) {
      throw new InventoryError(
        "METADATA_TOO_LARGE",
        `Metadata file exceeds 256 KiB: ${path}`
      );
    }

    // Always leave room for an over-limit byte. A file can grow after stat();
    // sizing from the snapshot could otherwise return a truncated prefix as valid.
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_METADATA_BYTES) {
      throw new InventoryError(
        "METADATA_TOO_LARGE",
        `Metadata file exceeds 256 KiB: ${path}`
      );
    }
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw unreadable(path);
  } finally {
    await handle.close();
  }
}

const productionNoFollowFlag = process.platform === "win32"
  ? 0
  : constants.O_NOFOLLOW ?? 0;

export const DEFAULT_METADATA_IO: MetadataIo = Object.freeze({
  noFollowFlag: productionNoFollowFlag,
  lstat: async (path: string) => lstat(path),
  open: async (path: string, flags: number) => {
    const handle = await open(path, flags);
    return {
      stat: async () => handle.stat(),
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          length,
          position
        );
        return { bytesRead };
      },
      close: async () => handle.close()
    };
  }
});
