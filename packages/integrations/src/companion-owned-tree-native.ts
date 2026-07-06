import { createRequire } from "node:module";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { getSystemErrorName } from "node:util";
import type {
  OwnedTreeDirectoryProof,
  OwnedTreeMutationOptions
} from "./companion-owned-tree-domain.js";
import {
  assertOwnedTreeDirectoryHandle,
  invalidOwnedTree,
  openOwnedTreeDirectoryHandle
} from "./companion-owned-tree-proof.js";

interface NativeRenameNoReplaceBinding {
  metadata(): unknown;
  renameNoReplace(parentFd: number, source: string, destination: string): unknown;
  removeAt(parentFd: number, name: string, directory: boolean): unknown;
}

interface NativeRenameNoReplaceManifest {
  name: string;
  version: string;
}

const nativeRequire = createRequire(import.meta.url);
const packageTargets = new Map<string, string>([
  ["darwin:arm64:none", "@skill-steward/rename-noreplace-darwin-arm64"],
  ["darwin:x64:none", "@skill-steward/rename-noreplace-darwin-x64"],
  ["linux:arm64:gnu", "@skill-steward/rename-noreplace-linux-arm64-gnu"],
  ["linux:x64:gnu", "@skill-steward/rename-noreplace-linux-x64-gnu"],
  ["linux:arm64:musl", "@skill-steward/rename-noreplace-linux-arm64-musl"],
  ["linux:x64:musl", "@skill-steward/rename-noreplace-linux-x64-musl"]
]);
const bindingCache = new Map<string, NativeRenameNoReplaceBinding>();

function runtimeLibc(platform: NodeJS.Platform): "none" | "gnu" | "musl" {
  if (platform !== "linux") return "none";
  const { header } = process.report.getReport() as {
    header: { glibcVersionRuntime?: string };
  };
  return header.glibcVersionRuntime === undefined ? "musl" : "gnu";
}

export function loadOwnedTreeNativeRenameBinding(input: {
  platform: NodeJS.Platform;
  arch: string;
  libc: "none" | "gnu" | "musl";
  runtimePlatform: NodeJS.Platform;
  runtimeArch: string;
  releaseVersion: string;
  requirePackage: (name: string) => unknown;
  requirePackageManifest: (name: string) => unknown;
}): NativeRenameNoReplaceBinding {
  if (input.platform !== input.runtimePlatform || input.arch !== input.runtimeArch) {
    throw invalidOwnedTree("Native no-replace helper target does not match this runtime");
  }
  const target = `${input.platform}:${input.arch}:${input.libc}`;
  const packageName = packageTargets.get(target);
  if (packageName === undefined) {
    throw invalidOwnedTree("Native no-replace helper is unavailable for this platform");
  }
  let packageManifest: unknown;
  try {
    packageManifest = input.requirePackageManifest(packageName);
  } catch (error) {
    throw invalidOwnedTree("Native no-replace helper package metadata is missing or unreadable", error);
  }
  if (
    packageManifest === null
    || typeof packageManifest !== "object"
    || (packageManifest as Partial<NativeRenameNoReplaceManifest>).name !== packageName
    || (packageManifest as Partial<NativeRenameNoReplaceManifest>).version !== input.releaseVersion
  ) {
    throw invalidOwnedTree("Native no-replace helper package version does not match Skill Steward");
  }
  let candidate: unknown;
  try {
    candidate = input.requirePackage(packageName);
  } catch (error) {
    throw invalidOwnedTree("Native no-replace helper package is missing or unloadable", error);
  }
  if (
    candidate === null
    || typeof candidate !== "object"
    || typeof (candidate as Partial<NativeRenameNoReplaceBinding>).metadata !== "function"
    || typeof (candidate as Partial<NativeRenameNoReplaceBinding>).renameNoReplace !== "function"
    || typeof (candidate as Partial<NativeRenameNoReplaceBinding>).removeAt !== "function"
  ) {
    throw invalidOwnedTree("Native no-replace helper exports are invalid");
  }
  const binding = candidate as NativeRenameNoReplaceBinding;
  const expectedMetadata = `skill-steward.owned-tree-native.v3:${input.releaseVersion}:${target}`;
  let metadata: unknown;
  try {
    metadata = binding.metadata();
  } catch (error) {
    throw invalidOwnedTree("Native no-replace helper metadata could not be verified", error);
  }
  if (metadata !== expectedMetadata) {
    throw invalidOwnedTree("Native no-replace helper metadata does not match this runtime");
  }
  return binding;
}

function loadNativeRenameNoReplace(
  platform: NodeJS.Platform,
  arch: string,
  releaseVersion?: string
): NativeRenameNoReplaceBinding {
  const libc = runtimeLibc(platform);
  const target = `${platform}:${arch}:${libc}`;
  const packageName = packageTargets.get(target);
  if (packageName === undefined) {
    throw invalidOwnedTree("Native no-replace helper is unavailable for this platform");
  }
  const expectedReleaseVersion = releaseVersion ?? runtimeReleaseVersion();
  const cacheKey = `${expectedReleaseVersion}:${target}`;
  const cached = bindingCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const binding = loadOwnedTreeNativeRenameBinding({
    platform,
    arch,
    libc,
    runtimePlatform: process.platform,
    runtimeArch: process.arch,
    releaseVersion: expectedReleaseVersion,
    requirePackage: nativeRequire,
    requirePackageManifest: (name) => nativeRequire(`${name}/package.json`)
  });
  bindingCache.set(cacheKey, binding);
  return binding;
}

function runtimeReleaseVersion(): string {
  let manifest: unknown;
  try {
    manifest = nativeRequire("../package.json");
  } catch (error) {
    throw invalidOwnedTree("Skill Steward package metadata is missing or unreadable", error);
  }
  if (manifest === null || typeof manifest !== "object") {
    throw invalidOwnedTree("Skill Steward package version could not be verified");
  }
  if (
    (manifest as { name?: unknown }).name === "skill-steward"
    && typeof (manifest as { version?: unknown }).version === "string"
  ) {
    return (manifest as { version: string }).version;
  }
  // Source-workspace tests execute this private package directly. Bind that path to the
  // independent public CLI manifest rather than deriving an expected version from the helper.
  if (
    (manifest as { name?: unknown }).name === "@skill-steward/integrations"
    && (manifest as { version?: unknown }).version === "0.0.0"
  ) {
    let cliManifest: unknown;
    try {
      cliManifest = nativeRequire("../../cli/package.json");
    } catch (error) {
      throw invalidOwnedTree("Workspace Skill Steward release version could not be verified", error);
    }
    if (
      cliManifest !== null
      && typeof cliManifest === "object"
      && (cliManifest as { name?: unknown }).name === "skill-steward"
      && typeof (cliManifest as { version?: unknown }).version === "string"
    ) {
      return (cliManifest as { version: string }).version;
    }
  }
  throw invalidOwnedTree("Skill Steward package version could not be verified");
}

/** Package-private production capability probe used before a reviewed tree mutation is offered. */
export function assertOwnedTreeNativeCapability(releaseVersion?: string): void {
  loadNativeRenameNoReplace(process.platform, process.arch, releaseVersion);
}

function nativeRenameError(errno: number): Error {
  let code = "UNKNOWN";
  try {
    code = getSystemErrorName(-errno);
  } catch {
    // Preserve UNKNOWN for an errno outside Node's platform table.
  }
  return Object.assign(new Error(`Atomic no-replace rename failed with ${code}`), { code });
}

const unavailableAtomicRenameCodes = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "UNKNOWN"
]);

function normalizeAtomicRenameError(error: unknown): unknown {
  const code = error !== null && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
  return typeof code === "string" && unavailableAtomicRenameCodes.has(code)
    ? invalidOwnedTree("Atomic no-replace rename is unavailable on this filesystem", error)
    : error;
}

export async function renameOwnedTreeNoReplace(
  parent: OwnedTreeDirectoryProof,
  source: string,
  destination: string,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const sourceName = strictOwnedTreeBasename(source);
  const destinationName = strictOwnedTreeBasename(destination);
  const handle = await openOwnedTreeDirectoryHandle(parent, options);
  try {
    await options.hooks?.beforeRenameNoReplace?.(source, destination);
    await assertOwnedTreeDirectoryHandle(handle, parent);
    if (options.hooks?.renamePath !== undefined) {
      await options.hooks.renamePath(source, destination);
    } else {
      const platform = options.hooks?.platform ?? process.platform;
      const binding = loadNativeRenameNoReplace(platform, process.arch);
      const result = binding.renameNoReplace(handle.fd, sourceName, destinationName);
      if (!Number.isInteger(result) || (result as number) < 0) {
        throw invalidOwnedTree("Native no-replace helper returned an invalid result");
      }
      if (result !== 0) throw nativeRenameError(result as number);
    }
    await assertOwnedTreeDirectoryHandle(handle, parent);
  } catch (error) {
    throw normalizeAtomicRenameError(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function strictOwnedTreeBasename(path: string): string {
  const name = basename(path);
  if (
    name !== path.slice(path.lastIndexOf("/") + 1)
    || name === ""
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")
    || Buffer.byteLength(name, "utf8") > 255
  ) {
    throw invalidOwnedTree("Native owned-tree mutation requires a strict bounded basename");
  }
  return name;
}

export async function removeOwnedTreeAt(
  handle: FileHandle,
  parent: OwnedTreeDirectoryProof,
  path: string,
  directory: boolean,
  options: OwnedTreeMutationOptions
): Promise<void> {
  const name = strictOwnedTreeBasename(path);
  try {
    await assertOwnedTreeDirectoryHandle(handle, parent);
    const hook = directory ? options.hooks?.rmdirPath : options.hooks?.unlinkPath;
    if (hook !== undefined) {
      await hook(path);
    } else {
      const platform = options.hooks?.platform ?? process.platform;
      const binding = loadNativeRenameNoReplace(platform, process.arch);
      const result = binding.removeAt(handle.fd, name, directory);
      if (!Number.isInteger(result) || (result as number) < 0) {
        throw invalidOwnedTree("Native owned-tree removal helper returned an invalid result");
      }
      if (result !== 0) throw nativeRenameError(result as number);
    }
    await assertOwnedTreeDirectoryHandle(handle, parent);
  } catch (error) {
    throw normalizeAtomicRenameError(error);
  }
}
