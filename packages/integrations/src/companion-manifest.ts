import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import {
  COMPANION_MANIFEST_MAX_DEPTH,
  COMPANION_MANIFEST_MAX_ENTRIES,
  COMPANION_MANIFEST_MAX_FILE_BYTES,
  COMPANION_MANIFEST_MAX_TOTAL_BYTES,
  compareCompanionPaths,
  createCompanionTreeManifest,
  type CompanionTreeEntry,
  type CompanionTreeManifest
} from "./companion-domain.js";

export type CompanionManifestErrorCode =
  | "COMPANION_TREE_CHANGED"
  | "COMPANION_TREE_COLLISION"
  | "COMPANION_TREE_ESCAPE"
  | "COMPANION_TREE_IO"
  | "COMPANION_TREE_MISSING"
  | "COMPANION_TREE_TRUNCATED"
  | "COMPANION_TREE_UNPROVABLE"
  | "COMPANION_TREE_UNSAFE";

export class CompanionManifestError extends Error {
  constructor(
    public readonly code: CompanionManifestErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CompanionManifestError";
  }
}

export interface CompanionManifestLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const companionManifestLimits: CompanionManifestLimits = {
  maxEntries: COMPANION_MANIFEST_MAX_ENTRIES,
  maxFileBytes: COMPANION_MANIFEST_MAX_FILE_BYTES,
  maxTotalBytes: COMPANION_MANIFEST_MAX_TOTAL_BYTES,
  maxDepth: COMPANION_MANIFEST_MAX_DEPTH
};

type CompanionStats = Stats;

export interface CompanionDirectoryHandle {
  read(): Promise<{ name: string } | null>;
  close(): Promise<void>;
}

export interface CompanionManifestOptions {
  boundary?: string;
  platform?: NodeJS.Platform;
  limits?: Partial<CompanionManifestLimits>;
  isReparsePoint?: (
    path: string,
    metadata: CompanionStats
  ) => boolean | Promise<boolean>;
  openDirectory?: (path: string) => Promise<CompanionDirectoryHandle>;
  lstatPath?: (path: string) => Promise<CompanionStats>;
  openFile?: (path: string, flags: number) => Promise<FileHandle>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function wrapIo(error: unknown, operation: string): CompanionManifestError {
  if (error instanceof CompanionManifestError) return error;
  return new CompanionManifestError(
    "COMPANION_TREE_IO",
    `Unable to ${operation} companion tree safely`,
    { cause: error }
  );
}

function manifestPlatform(platform: NodeJS.Platform): "posix" | "win32" {
  return platform === "win32" ? "win32" : "posix";
}

function securityMode(metadata: CompanionStats, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return (metadata.mode & 0o222) === 0 ? "win32:readonly" : "win32:writable";
  }
  return `posix:${(metadata.mode & 0o777).toString(8).padStart(4, "0")}`;
}

function metadataKind(metadata: CompanionStats): "directory" | "file" | "unsafe" {
  if (metadata.isSymbolicLink()) return "unsafe";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  return "unsafe";
}

function sameIdentity(left: CompanionStats, right: CompanionStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && metadataKind(left) === metadataKind(right);
}

function pathKey(relativePath: string): string {
  return relativePath.normalize("NFC").toLowerCase();
}

function validateLimits(input: Partial<CompanionManifestLimits> | undefined): CompanionManifestLimits {
  const limits = { ...companionManifestLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        `Companion manifest ${name} bound is invalid`
      );
    }
    const ceiling = companionManifestLimits[name as keyof CompanionManifestLimits];
    if (value > ceiling) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        `Companion manifest ${name} bound cannot exceed its security ceiling`
      );
    }
  }
  return limits;
}

async function assertSafeEntry(
  path: string,
  metadata: CompanionStats,
  options: CompanionManifestOptions
): Promise<"directory" | "file"> {
  const kind = metadataKind(metadata);
  const reparse = await options.isReparsePoint?.(path, metadata) ?? false;
  if (kind === "unsafe" || reparse) {
    throw new CompanionManifestError(
      "COMPANION_TREE_UNSAFE",
      "Companion tree contains a link, reparse point, or special entry"
    );
  }
  return kind;
}

function assertChildPath(root: string, boundary: string): string[] {
  const relativeRoot = relative(boundary, root);
  if (
    relativeRoot === ""
    || relativeRoot === ".."
    || relativeRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeRoot)
  ) {
    throw new CompanionManifestError(
      "COMPANION_TREE_ESCAPE",
      "Companion tree must be a child of its physical boundary"
    );
  }
  return relativeRoot.split(sep);
}

async function readMetadata(
  path: string,
  options: CompanionManifestOptions,
  missingCode: "COMPANION_TREE_MISSING" | "COMPANION_TREE_CHANGED",
  operation: string
): Promise<CompanionStats> {
  try {
    return await (options.lstatPath ?? lstat)(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new CompanionManifestError(
        missingCode,
        missingCode === "COMPANION_TREE_MISSING"
          ? "Companion tree does not exist"
          : "Companion tree changed during traversal"
      );
    }
    throw wrapIo(error, operation);
  }
}

async function assertPhysicalIdentity(
  path: string,
  initial: CompanionStats,
  options: CompanionManifestOptions
): Promise<void> {
  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion ancestor changed during physical identity validation"
      );
    }
    throw wrapIo(error, "resolve companion ancestor identity");
  }
  const physical = await readMetadata(
    physicalPath,
    options,
    "COMPANION_TREE_CHANGED",
    "inspect companion physical identity"
  );
  await assertSafeEntry(physicalPath, physical, options);
  if (!sameIdentity(initial, physical)) {
    throw new CompanionManifestError(
      "COMPANION_TREE_CHANGED",
      "Companion ancestor physical identity changed during inspection"
    );
  }
}

async function establishAncestorIdentities(
  root: string,
  boundary: string,
  options: CompanionManifestOptions,
  identities: Map<string, CompanionStats>
): Promise<void> {
  const components = assertChildPath(root, boundary);
  let current = boundary;
  const ancestorPaths = [boundary];
  for (const component of components.slice(0, -1)) {
    current = resolve(current, component);
    ancestorPaths.push(current);
  }
  for (const ancestor of ancestorPaths) {
    const metadata = await readMetadata(
      ancestor,
      options,
      "COMPANION_TREE_MISSING",
      "inspect companion ancestors"
    );
    if (await assertSafeEntry(ancestor, metadata, options) !== "directory") {
      throw new CompanionManifestError(
        "COMPANION_TREE_UNSAFE",
        "Companion ancestor must be a regular directory"
      );
    }
    await assertPhysicalIdentity(ancestor, metadata, options);
    identities.set(ancestor, metadata);
  }
}

function chainPaths(boundary: string, target: string): string[] {
  const relativeTarget = relative(boundary, target);
  if (relativeTarget === "") return [boundary];
  if (
    relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new CompanionManifestError(
      "COMPANION_TREE_ESCAPE",
      "Companion traversal escaped its physical boundary"
    );
  }
  const paths = [boundary];
  let current = boundary;
  for (const component of relativeTarget.split(sep)) {
    current = resolve(current, component);
    paths.push(current);
  }
  return paths;
}

async function validateKnownChain(
  boundary: string,
  target: string,
  options: CompanionManifestOptions,
  identities: Map<string, CompanionStats>
): Promise<void> {
  for (const path of chainPaths(boundary, target)) {
    const expected = identities.get(path);
    if (expected === undefined) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion ancestor identity was not established"
      );
    }
    const current = await readMetadata(
      path,
      options,
      "COMPANION_TREE_CHANGED",
      "revalidate companion ancestors"
    );
    if (await assertSafeEntry(path, current, options) !== "directory"
      || !sameIdentity(expected, current)) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion ancestor identity changed during traversal"
      );
    }
  }
}

async function readBoundedDirectory(
  path: string,
  limit: number,
  options: CompanionManifestOptions
): Promise<string[]> {
  let handle: CompanionDirectoryHandle;
  try {
    handle = await (options.openDirectory ?? opendir)(path);
  } catch (error) {
    throw wrapIo(error, "open companion directory");
  }
  try {
    const names: string[] = [];
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > limit) {
        throw new CompanionManifestError(
          "COMPANION_TREE_TRUNCATED",
          "Companion directory exceeds its entry bound"
        );
      }
    }
    return names;
  } catch (error) {
    throw wrapIo(error, "enumerate companion directory");
  } finally {
    try {
      await handle.close();
    } catch (error) {
      throw wrapIo(error, "close companion directory");
    }
  }
}

async function validateDirectoryIdentity(
  path: string,
  initial: CompanionStats,
  options: CompanionManifestOptions
): Promise<void> {
  const current = await readMetadata(
    path,
    options,
    "COMPANION_TREE_CHANGED",
    "revalidate companion directory"
  );
  if (await assertSafeEntry(path, current, options) !== "directory"
    || !sameIdentity(initial, current)) {
    throw new CompanionManifestError(
      "COMPANION_TREE_CHANGED",
      "Companion directory identity changed during traversal"
    );
  }
}

async function readBoundedFile(
  path: string,
  initial: CompanionStats,
  limit: number,
  options: CompanionManifestOptions,
  validateParent: () => Promise<void>
): Promise<Buffer> {
  const platform = options.platform ?? process.platform;
  const openFile = options.openFile ?? open;
  const flags = constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let handle: FileHandle;
  try {
    await validateParent();
    handle = await openFile(path, flags);
  } catch (error) {
    throw wrapIo(error, "open companion file");
  }
  try {
    const opened = await handle.stat();
    if (!sameIdentity(initial, opened) || !opened.isFile()) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion file identity changed before content read"
      );
    }
    await validateParent();
    const rechecked = await handle.stat();
    if (!sameIdentity(initial, rechecked) || !rechecked.isFile()) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion file identity changed before content read"
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (true) {
      const remaining = limit + 1 - total;
      if (remaining <= 0) {
        throw new CompanionManifestError(
          "COMPANION_TREE_TRUNCATED",
          "Companion file exceeds its byte bound"
        );
      }
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > limit) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        "Companion file exceeds its byte bound"
      );
    }
    const after = await handle.stat();
    if (!sameIdentity(initial, after) || total !== initial.size) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion file identity changed during content read"
      );
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    throw wrapIo(error, "read companion file");
  } finally {
    try {
      await handle.close();
    } catch (error) {
      throw wrapIo(error, "close companion file");
    }
  }
}

function validateNames(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (
      name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
    ) {
      throw new CompanionManifestError(
        "COMPANION_TREE_UNSAFE",
        "Companion directory contains an unsafe entry name"
      );
    }
    const key = pathKey(name);
    if (seen.has(key)) {
      throw new CompanionManifestError(
        "COMPANION_TREE_COLLISION",
        "Companion directory contains a case or normalization collision"
      );
    }
    seen.add(key);
  }
}

export async function inspectCompanionTree(
  inputRoot: string,
  options: CompanionManifestOptions = {}
): Promise<CompanionTreeManifest> {
  const root = resolve(inputRoot);
  const boundary = resolve(options.boundary ?? dirname(root));
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && options.isReparsePoint === undefined) {
    let rootMetadata: CompanionStats;
    try {
      rootMetadata = await (options.lstatPath ?? lstat)(root);
    } catch (error) {
      if (isMissing(error)) {
        throw new CompanionManifestError(
          "COMPANION_TREE_MISSING",
          "Companion tree does not exist"
        );
      }
      throw wrapIo(error, "inspect companion root availability");
    }
    if (metadataKind(rootMetadata) !== "directory") {
      throw new CompanionManifestError(
        "COMPANION_TREE_UNSAFE",
        "Companion root must be a physical directory"
      );
    }
    let recheckedRoot: CompanionStats;
    try {
      recheckedRoot = await (options.lstatPath ?? lstat)(root);
    } catch (error) {
      if (isMissing(error)) {
        throw new CompanionManifestError(
          "COMPANION_TREE_CHANGED",
          "Companion root changed during platform evidence validation"
        );
      }
      throw wrapIo(error, "revalidate companion root availability");
    }
    if (!sameIdentity(rootMetadata, recheckedRoot)) {
      throw new CompanionManifestError(
        "COMPANION_TREE_CHANGED",
        "Companion root identity changed during platform evidence validation"
      );
    }
    throw new CompanionManifestError(
      "COMPANION_TREE_UNPROVABLE",
      "Windows companion inspection requires a native reparse-point detector"
    );
  }
  const limits = validateLimits(options.limits);
  const identities = new Map<string, CompanionStats>();
  await establishAncestorIdentities(root, boundary, options, identities);

  const entries: CompanionTreeEntry[] = [];
  const seen = new Map<string, string>();
  let totalBytes = 0;

  const visit = async (path: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || entries.length >= limits.maxEntries) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        "Companion tree exceeds its traversal bounds"
      );
    }
    const key = pathKey(relativePath);
    if (seen.has(key)) {
      throw new CompanionManifestError(
        "COMPANION_TREE_COLLISION",
        "Companion tree contains a case or normalization path collision"
      );
    }
    seen.set(key, relativePath);

    await validateKnownChain(boundary, dirname(path), options, identities);
    const metadata = await readMetadata(
      path,
      options,
      relativePath === "." ? "COMPANION_TREE_MISSING" : "COMPANION_TREE_CHANGED",
      "inspect companion entry"
    );
    const kind = await assertSafeEntry(path, metadata, options);
    if (relativePath === "." && kind !== "directory") {
      throw new CompanionManifestError(
        "COMPANION_TREE_UNSAFE",
        "Companion root must be a regular directory"
      );
    }
    const mode = securityMode(metadata, platform);
    if (kind === "directory") {
      identities.set(path, metadata);
      entries.push({ relativePath, kind, bytes: 0, securityMode: mode });
      const firstNames = await readBoundedDirectory(path, limits.maxEntries, options);
      validateNames(firstNames);
      await validateDirectoryIdentity(path, metadata, options);
      const sortedNames = [...firstNames].sort(compareCompanionPaths);
      for (const name of sortedNames) {
        const childRelative = relativePath === "." ? name : `${relativePath}/${name}`;
        if (seen.has(pathKey(childRelative))) {
          throw new CompanionManifestError(
            "COMPANION_TREE_COLLISION",
            "Companion tree contains a case or normalization path collision"
          );
        }
        await validateKnownChain(boundary, path, options, identities);
        await visit(resolve(path, name), childRelative, depth + 1);
      }
      await validateKnownChain(boundary, path, options, identities);
      const secondNames = await readBoundedDirectory(path, limits.maxEntries, options);
      validateNames(secondNames);
      await validateDirectoryIdentity(path, metadata, options);
      const sortedSecond = [...secondNames].sort(compareCompanionPaths);
      if (JSON.stringify(sortedNames) !== JSON.stringify(sortedSecond)) {
        throw new CompanionManifestError(
          "COMPANION_TREE_CHANGED",
          "Companion directory entries changed during traversal"
        );
      }
      return;
    }
    if (metadata.size > limits.maxFileBytes) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        "Companion file exceeds its byte bound"
      );
    }
    totalBytes += metadata.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new CompanionManifestError(
        "COMPANION_TREE_TRUNCATED",
        "Companion tree exceeds its total byte bound"
      );
    }
    const content = await readBoundedFile(
      path,
      metadata,
      limits.maxFileBytes,
      options,
      () => validateKnownChain(boundary, dirname(path), options, identities)
    );
    entries.push({
      relativePath,
      kind,
      bytes: content.byteLength,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      securityMode: mode
    });
  };

  await visit(root, ".", 0);
  entries.sort((left, right) => compareCompanionPaths(left.relativePath, right.relativePath));
  return createCompanionTreeManifest(manifestPlatform(platform), entries);
}
