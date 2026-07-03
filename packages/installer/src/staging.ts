import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { InstallerError } from "./domain.js";

const PREVIEW_METADATA = "preview.json";
const previewIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const previewMetadataSchema = z.object({
  version: z.literal(1),
  id: previewIdSchema,
  createdAt: z.number().int().safe().nonnegative(),
  expiresAt: z.number().int().safe().positive()
}).strict().refine(
  ({ createdAt, expiresAt }) => expiresAt > createdAt,
  { path: ["expiresAt"], message: "Preview expiry must be after creation" }
);

interface PreviewMetadata {
  version: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface StagedPreview {
  id: string;
  directory: string;
  createdAt: number;
  expiresAt: number;
}

export interface StagingRegistryOptions {
  stateDirectory: string;
  now?: () => number;
  id?: () => string;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidState(message: string): InstallerError {
  return new InstallerError("UNSAFE_PREVIEW_STATE", message);
}

function parseId(input: string): string {
  const parsed = previewIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new InstallerError("INVALID_PREVIEW_ID", "Installation preview ID is unsafe");
  }
  return parsed.data;
}

async function inspectDirectory(path: string): Promise<Stats | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw invalidState("Installation staging paths must be physical directories");
    }
    return metadata;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function inspectRegularFile(path: string): Promise<Stats> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw invalidState("Installation preview metadata must be a regular non-symlink file");
    }
    return metadata;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

export class StagingRegistry {
  readonly #stateDirectory: string;
  readonly #root: string;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #previews = new Map<string, StagedPreview>();

  constructor(options: StagingRegistryOptions) {
    this.#stateDirectory = resolve(options.stateDirectory);
    this.#root = resolve(this.#stateDirectory, "staging");
    if (dirname(this.#root) !== this.#stateDirectory) {
      throw invalidState("Installation staging root escapes state");
    }
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  async create({ ttlMs }: { ttlMs: number }): Promise<StagedPreview> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new InstallerError("INVALID_TTL", "Preview TTL must be a positive integer");
    }
    const id = parseId(this.#id());
    const createdAt = this.#now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new InstallerError("INVALID_PREVIEW_TIME", "Preview time must be a safe timestamp");
    }
    const expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new InstallerError("INVALID_TTL", "Preview expiry exceeds the supported range");
    }

    await this.#ensureRoot(true);
    const directory = this.#previewPath(id);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        throw new InstallerError("PREVIEW_CONFLICT", "Installation preview already exists");
      }
      throw error;
    }

    const metadata: PreviewMetadata = { version: 1, id, createdAt, expiresAt };
    try {
      await this.#writeMetadata(directory, metadata);
      const preview = { id, directory, createdAt, expiresAt };
      this.#previews.set(id, preview);
      return preview;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async resolve(inputId: string): Promise<StagedPreview> {
    const id = parseId(inputId);
    const preview = await this.#readPreview(id);
    if (this.#now() > preview.expiresAt) {
      await this.expire(id);
      throw new InstallerError("PREVIEW_EXPIRED", "Installation preview has expired");
    }
    this.#previews.set(id, preview);
    return preview;
  }

  async expire(inputId: string): Promise<void> {
    const id = parseId(inputId);
    const root = await this.#ensureRoot(false);
    if (root === undefined) {
      this.#previews.delete(id);
      return;
    }
    const directory = this.#previewPath(id);
    const before = await inspectDirectory(directory);
    if (before === undefined) {
      this.#previews.delete(id);
      return;
    }
    await this.#readPreview(id);

    const owned = resolve(root, `.expired-${id}-${randomUUID()}`);
    if (dirname(owned) !== root) throw invalidState("Expired preview path escapes staging");
    try {
      await rename(directory, owned);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        this.#previews.delete(id);
        return;
      }
      throw error;
    }
    const after = await inspectDirectory(owned);
    if (
      after === undefined
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw invalidState("Installation preview changed while it was being expired");
    }
    await rm(owned, { recursive: true, force: false });
    this.#previews.delete(id);
  }

  #previewPath(id: string): string {
    const directory = resolve(this.#root, id);
    if (dirname(directory) !== this.#root) {
      throw new InstallerError("INVALID_PREVIEW_ID", "Installation preview path escapes staging");
    }
    return directory;
  }

  async #ensureRoot(create: boolean): Promise<string | undefined> {
    let state = await inspectDirectory(this.#stateDirectory);
    if (state === undefined && create) {
      await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
      state = await inspectDirectory(this.#stateDirectory);
    }
    if (state === undefined) return undefined;

    let root = await inspectDirectory(this.#root);
    if (root === undefined && create) {
      try {
        await mkdir(this.#root, { mode: 0o700 });
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }
      root = await inspectDirectory(this.#root);
    }
    if (root === undefined) return undefined;
    await chmod(this.#root, 0o700);
    return this.#root;
  }

  async #readPreview(id: string): Promise<StagedPreview> {
    const root = await this.#ensureRoot(false);
    if (root === undefined) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    const directory = this.#previewPath(id);
    if (await inspectDirectory(directory) === undefined) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    const [physicalRoot, physicalDirectory] = await Promise.all([
      realpath(root),
      realpath(directory)
    ]);
    if (dirname(physicalDirectory) !== physicalRoot) {
      throw invalidState("Installation preview is not physically contained in staging");
    }

    const metadataPath = resolve(directory, PREVIEW_METADATA);
    if (dirname(metadataPath) !== directory) {
      throw invalidState("Installation preview metadata escapes its directory");
    }
    const pathMetadata = await inspectRegularFile(metadataPath);
    let handle;
    try {
      handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedMetadata = await handle.stat();
      if (
        !openedMetadata.isFile()
        || openedMetadata.dev !== pathMetadata.dev
        || openedMetadata.ino !== pathMetadata.ino
      ) {
        throw invalidState("Installation preview metadata changed while it was read");
      }
      const source = await handle.readFile({ encoding: "utf8" });
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(source) as unknown;
      } catch {
        throw new InstallerError(
          "INVALID_PREVIEW_METADATA",
          "Installation preview metadata is invalid"
        );
      }
      const parsed = previewMetadataSchema.safeParse(parsedJson);
      if (!parsed.success || parsed.data.id !== id) {
        throw new InstallerError(
          "INVALID_PREVIEW_METADATA",
          "Installation preview metadata is invalid"
        );
      }
      return {
        id,
        directory,
        createdAt: parsed.data.createdAt,
        expiresAt: parsed.data.expiresAt
      };
    } catch (error) {
      if (isFileSystemError(error, "ELOOP")) {
        throw invalidState("Installation preview metadata must not be a symlink");
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async #writeMetadata(directory: string, metadata: PreviewMetadata): Promise<void> {
    const destination = resolve(directory, PREVIEW_METADATA);
    const temporary = resolve(directory, `.preview-${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(previewMetadataSchema.parse(metadata), null, 2)}\n`;
    let created = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw invalidState("Installation preview metadata already exists");
        }
        throw error;
      }
      await unlink(temporary);
      created = false;
    } finally {
      if (created) await unlinkIfPresent(temporary);
    }
  }
}
