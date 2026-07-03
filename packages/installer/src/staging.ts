import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { InstallerError } from "./domain.js";

const PREVIEW_METADATA = "preview.json";
const MAX_CLEANUP_CANDIDATES = 1_000;
const MAX_METADATA_BYTES = 16 * 1_024;
const TOMBSTONE_GRACE_MS = 60 * 60 * 1_000;
const PREVIEW_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const previewIdSchema = z.string().regex(new RegExp(`^${PREVIEW_ID_PATTERN}$`));
const tombstoneNamePattern = new RegExp(
  `^\\.expired-(${PREVIEW_ID_PATTERN})-([0-9]{1,16})-(${UUID_PATTERN})$`
);
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

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  physicalPath: string;
}

interface PreviewState {
  preview: StagedPreview;
  rootIdentity: DirectoryIdentity;
  previewIdentity: DirectoryIdentity;
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

function requireUsableIdentity(metadata: BigIntStats, kind: string): FileIdentity {
  if (metadata.dev === 0n || metadata.ino === 0n) {
    throw invalidState(`${kind} filesystem identity is unavailable`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectDirectory(path: string): Promise<DirectoryIdentity | undefined> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw invalidState("Installation staging paths must be physical directories");
  }
  const identity = requireUsableIdentity(before, "Installation staging directory");
  let physicalPath: string;
  let after: BigIntStats;
  try {
    physicalPath = await realpath(path);
    after = await lstat(path, { bigint: true });
  } catch (error) {
    throw invalidState(
      isFileSystemError(error, "ENOENT")
        ? "Installation staging directory disappeared during inspection"
        : "Installation staging directory could not be inspected safely"
    );
  }
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw invalidState("Installation staging paths must remain physical directories");
  }
  const afterIdentity = requireUsableIdentity(after, "Installation staging directory");
  if (!sameIdentity(identity, afterIdentity)) {
    throw invalidState("Installation staging directory changed during inspection");
  }
  return { ...identity, physicalPath };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity
): Promise<DirectoryIdentity> {
  const actual = await inspectDirectory(path);
  if (
    actual === undefined
    || !sameIdentity(actual, expected)
    || actual.physicalPath !== expected.physicalPath
  ) {
    throw invalidState("Installation staging directory ownership changed");
  }
  return actual;
}

async function inspectRegularFile(path: string): Promise<FileIdentity> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw invalidState("Installation preview metadata must be a regular non-symlink file");
  }
  if (metadata.size > BigInt(MAX_METADATA_BYTES)) {
    throw new InstallerError(
      "INVALID_PREVIEW_METADATA",
      "Installation preview metadata exceeds the size limit"
    );
  }
  return requireUsableIdentity(metadata, "Installation preview metadata");
}

async function unlinkOwnedFile(path: string, expected: FileIdentity): Promise<void> {
  try {
    const actual = await inspectRegularFile(path);
    if (!sameIdentity(actual, expected)) {
      throw invalidState("Installation staging file ownership changed");
    }
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
    const createdAt = this.#safeNow();
    const expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new InstallerError("INVALID_TTL", "Preview expiry exceeds the supported range");
    }

    const rootIdentity = await this.#ensureRoot(true);
    if (rootIdentity === undefined) {
      throw invalidState("Installation staging root is unavailable");
    }
    const directory = this.#previewPath(id);
    let previewIdentity: DirectoryIdentity | undefined;
    try {
      await assertDirectoryIdentity(this.#root, rootIdentity);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw new InstallerError("PREVIEW_CONFLICT", "Installation preview already exists");
        }
        throw error;
      }
      await assertDirectoryIdentity(this.#root, rootIdentity);
      previewIdentity = await this.#inspectContainedPreview(rootIdentity, id);
      const metadata: PreviewMetadata = { version: 1, id, createdAt, expiresAt };
      await this.#writeMetadata(rootIdentity, previewIdentity, directory, metadata);
      return { id, directory, createdAt, expiresAt };
    } catch (error) {
      if (previewIdentity !== undefined) {
        try {
          await this.#removeOwnedDirectory(rootIdentity, previewIdentity, id);
        } catch {
          // Preserve the original failure and never delete state whose ownership changed.
        }
      }
      throw error;
    }
  }

  async resolve(inputId: string): Promise<StagedPreview> {
    const state = await this.#readPreview(parseId(inputId));
    if (this.#safeNow() >= state.preview.expiresAt) {
      await this.#removeOwnedDirectory(
        state.rootIdentity,
        state.previewIdentity,
        state.preview.id
      );
      throw new InstallerError("PREVIEW_EXPIRED", "Installation preview has expired");
    }
    return state.preview;
  }

  async expire(inputId: string): Promise<void> {
    const id = parseId(inputId);
    let state: PreviewState;
    try {
      state = await this.#readPreview(id);
    } catch (error) {
      if (error instanceof InstallerError && error.code === "PREVIEW_NOT_FOUND") return;
      throw error;
    }
    await this.#removeOwnedDirectory(
      state.rootIdentity,
      state.previewIdentity,
      state.preview.id
    );
  }

  async cleanupExpired(): Promise<number> {
    const rootIdentity = await this.#ensureRoot(false);
    if (rootIdentity === undefined) return 0;
    await assertDirectoryIdentity(this.#root, rootIdentity);
    let removed = 0;
    let inspected = 0;
    for await (const entry of await opendir(this.#root)) {
      inspected += 1;
      if (inspected > MAX_CLEANUP_CANDIDATES) break;
      const parsedId = previewIdSchema.safeParse(entry.name);
      const tombstone = tombstoneNamePattern.exec(entry.name);
      if (!parsedId.success && tombstone === null) continue;
      try {
        await assertDirectoryIdentity(this.#root, rootIdentity);
        if (parsedId.success) {
          const state = await this.#readPreview(parsedId.data, rootIdentity);
          if (this.#safeNow() < state.preview.expiresAt) continue;
          if (await this.#removeOwnedDirectory(
            state.rootIdentity,
            state.previewIdentity,
            state.preview.id
          )) {
            removed += 1;
          }
          continue;
        }

        const id = tombstone?.[1];
        const claimTime = Number(tombstone?.[2]);
        if (
          id === undefined
          || !Number.isSafeInteger(claimTime)
          || claimTime < 0
          || this.#safeNow() - claimTime <= TOMBSTONE_GRACE_MS
        ) {
          continue;
        }
        const path = resolve(this.#root, entry.name);
        if (dirname(path) !== this.#root) continue;
        const state = await this.#readPreviewAt(id, path, rootIdentity);
        if (await this.#removeClaimedTombstone(
          state.rootIdentity,
          state.previewIdentity,
          path
        )) {
          removed += 1;
        }
      } catch {
        // Invalid, raced, or unreadable candidates are retained unless ownership is proven.
        await assertDirectoryIdentity(this.#root, rootIdentity);
      }
    }
    await assertDirectoryIdentity(this.#root, rootIdentity);
    return removed;
  }

  #safeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new InstallerError("INVALID_PREVIEW_TIME", "Preview time must be a safe timestamp");
    }
    return now;
  }

  #previewPath(id: string): string {
    const directory = resolve(this.#root, id);
    if (dirname(directory) !== this.#root) {
      throw new InstallerError("INVALID_PREVIEW_ID", "Installation preview path escapes staging");
    }
    return directory;
  }

  async #ensureRoot(create: boolean): Promise<DirectoryIdentity | undefined> {
    let stateIdentity = await inspectDirectory(this.#stateDirectory);
    if (stateIdentity === undefined && create) {
      await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
      stateIdentity = await inspectDirectory(this.#stateDirectory);
    }
    if (stateIdentity === undefined) return undefined;

    let rootIdentity = await inspectDirectory(this.#root);
    if (rootIdentity === undefined && create) {
      try {
        await mkdir(this.#root, { mode: 0o700 });
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }
      rootIdentity = await inspectDirectory(this.#root);
    }
    if (rootIdentity === undefined) return undefined;
    if (dirname(rootIdentity.physicalPath) !== stateIdentity.physicalPath) {
      throw invalidState("Installation staging root is not physically contained in state");
    }
    await chmod(this.#root, 0o700);
    await Promise.all([
      assertDirectoryIdentity(this.#stateDirectory, stateIdentity),
      assertDirectoryIdentity(this.#root, rootIdentity)
    ]);
    return rootIdentity;
  }

  async #inspectContainedPreview(
    rootIdentity: DirectoryIdentity,
    id: string
  ): Promise<DirectoryIdentity> {
    return this.#inspectContainedDirectory(rootIdentity, this.#previewPath(id));
  }

  async #inspectContainedDirectory(
    rootIdentity: DirectoryIdentity,
    directory: string
  ): Promise<DirectoryIdentity> {
    await assertDirectoryIdentity(this.#root, rootIdentity);
    if (dirname(directory) !== this.#root) {
      throw invalidState("Installation preview path escapes staging");
    }
    const previewIdentity = await inspectDirectory(directory);
    if (previewIdentity === undefined) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    await assertDirectoryIdentity(this.#root, rootIdentity);
    if (dirname(previewIdentity.physicalPath) !== rootIdentity.physicalPath) {
      throw invalidState("Installation preview is not physically contained in staging");
    }
    return previewIdentity;
  }

  async #readPreview(
    id: string,
    knownRoot?: DirectoryIdentity
  ): Promise<PreviewState> {
    const rootIdentity = knownRoot ?? await this.#ensureRoot(false);
    if (rootIdentity === undefined) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    return this.#readPreviewAt(id, this.#previewPath(id), rootIdentity);
  }

  async #readPreviewAt(
    id: string,
    directory: string,
    rootIdentity: DirectoryIdentity
  ): Promise<PreviewState> {
    await assertDirectoryIdentity(this.#root, rootIdentity);
    const previewIdentity = await this.#inspectContainedDirectory(rootIdentity, directory);
    const metadataPath = resolve(directory, PREVIEW_METADATA);
    if (dirname(metadataPath) !== directory) {
      throw invalidState("Installation preview metadata escapes its directory");
    }
    const fileIdentity = await inspectRegularFile(metadataPath);
    await Promise.all([
      assertDirectoryIdentity(this.#root, rootIdentity),
      assertDirectoryIdentity(directory, previewIdentity)
    ]);

    let handle;
    let source: string;
    try {
      handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedMetadata = await handle.stat({ bigint: true });
      if (!openedMetadata.isFile()) {
        throw invalidState("Installation preview metadata must remain a regular file");
      }
      const openedIdentity = requireUsableIdentity(
        openedMetadata,
        "Installation preview metadata"
      );
      if (!sameIdentity(fileIdentity, openedIdentity)) {
        throw invalidState("Installation preview metadata changed while it was read");
      }
      source = await handle.readFile({ encoding: "utf8" });
    } catch (error) {
      if (isFileSystemError(error, "ELOOP")) {
        throw invalidState("Installation preview metadata must not be a symlink");
      }
      throw error;
    } finally {
      await handle?.close();
    }

    await Promise.all([
      assertDirectoryIdentity(this.#root, rootIdentity),
      assertDirectoryIdentity(directory, previewIdentity)
    ]);
    const finalFileIdentity = await inspectRegularFile(metadataPath);
    if (!sameIdentity(fileIdentity, finalFileIdentity)) {
      throw invalidState("Installation preview metadata ownership changed");
    }

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
      preview: {
        id,
        directory,
        createdAt: parsed.data.createdAt,
        expiresAt: parsed.data.expiresAt
      },
      rootIdentity,
      previewIdentity
    };
  }

  async #removeOwnedDirectory(
    rootIdentity: DirectoryIdentity,
    previewIdentity: DirectoryIdentity,
    id: string
  ): Promise<boolean> {
    const directory = this.#previewPath(id);
    await Promise.all([
      assertDirectoryIdentity(this.#root, rootIdentity),
      assertDirectoryIdentity(directory, previewIdentity)
    ]);
    const owned = resolve(
      this.#root,
      `.expired-${id}-${this.#safeNow()}-${randomUUID()}`
    );
    if (dirname(owned) !== this.#root) {
      throw invalidState("Expired preview path escapes staging");
    }
    try {
      await rename(directory, owned);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    }
    await assertDirectoryIdentity(this.#root, rootIdentity);
    const ownedIdentity = await inspectDirectory(owned);
    const expectedOwnedPhysical = resolve(rootIdentity.physicalPath, basename(owned));
    if (
      ownedIdentity === undefined
      || !sameIdentity(ownedIdentity, previewIdentity)
      || ownedIdentity.physicalPath !== expectedOwnedPhysical
    ) {
      throw invalidState("Installation preview changed before cleanup could claim it");
    }
    if (dirname(ownedIdentity.physicalPath) !== rootIdentity.physicalPath) {
      throw invalidState("Claimed installation preview escapes staging");
    }
    await Promise.all([
      assertDirectoryIdentity(this.#root, rootIdentity),
      assertDirectoryIdentity(owned, ownedIdentity)
    ]);
    await rm(owned, { recursive: true, force: false });
    return true;
  }

  async #removeClaimedTombstone(
    rootIdentity: DirectoryIdentity,
    tombstoneIdentity: DirectoryIdentity,
    path: string
  ): Promise<boolean> {
    try {
      await Promise.all([
        assertDirectoryIdentity(this.#root, rootIdentity),
        assertDirectoryIdentity(path, tombstoneIdentity)
      ]);
      if (dirname(tombstoneIdentity.physicalPath) !== rootIdentity.physicalPath) {
        throw invalidState("Cleanup tombstone escapes installation staging");
      }
      await rm(path, { recursive: true, force: false });
      return true;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async #writeMetadata(
    rootIdentity: DirectoryIdentity,
    previewIdentity: DirectoryIdentity,
    directory: string,
    metadata: PreviewMetadata
  ): Promise<void> {
    const destination = resolve(directory, PREVIEW_METADATA);
    const temporary = resolve(directory, `.preview-${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(previewMetadataSchema.parse(metadata), null, 2)}\n`;
    await Promise.all([
      assertDirectoryIdentity(this.#root, rootIdentity),
      assertDirectoryIdentity(directory, previewIdentity)
    ]);
    const handle = await open(temporary, "wx", 0o600);
    let temporaryIdentity: FileIdentity | undefined;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      const openedMetadata = await handle.stat({ bigint: true });
      temporaryIdentity = requireUsableIdentity(openedMetadata, "Preview metadata temporary");
    } finally {
      await handle.close();
    }
    try {
      await Promise.all([
        assertDirectoryIdentity(this.#root, rootIdentity),
        assertDirectoryIdentity(directory, previewIdentity)
      ]);
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw invalidState("Installation preview metadata already exists");
        }
        throw error;
      }
      await Promise.all([
        assertDirectoryIdentity(this.#root, rootIdentity),
        assertDirectoryIdentity(directory, previewIdentity)
      ]);
      const destinationIdentity = await inspectRegularFile(destination);
      if (!sameIdentity(temporaryIdentity, destinationIdentity)) {
        throw invalidState("Installation preview metadata publication changed ownership");
      }
    } finally {
      if (temporaryIdentity !== undefined) {
        try {
          await Promise.all([
            assertDirectoryIdentity(this.#root, rootIdentity),
            assertDirectoryIdentity(directory, previewIdentity)
          ]);
          await unlinkOwnedFile(temporary, temporaryIdentity);
        } catch {
          // Retain uncertain temporary state rather than unlinking another file.
        }
      }
    }
  }
}
