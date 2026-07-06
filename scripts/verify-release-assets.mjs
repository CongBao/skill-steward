#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkReleaseContract } from "./release-contract.mjs";
import {
  MAX_PACKAGE_BYTES,
  RELEASE_CHECKSUMS,
  RELEASE_MANIFEST,
  RELEASE_REPOSITORY,
  boundedDiagnostic,
  canonicalJsonBytes,
  compareCodepoints,
  exactKeys,
  nativeTarget,
  packageAssetFilename,
  parseSha512Integrity,
  sha256,
  sha512Integrity,
  validateSourceCommit
} from "./release-assets.mjs";
import { verifyPackedArtifactBytes } from "./verify-cli-package.mjs";
import { verifyNativeRenamePackageBytes } from "./verify-native-rename-package.mjs";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_KEYS = [
  "schemaVersion",
  "repository",
  "sourceCommit",
  "provenanceScope",
  "version",
  "channel",
  "npmTag",
  "githubPrerelease",
  "packages"
];
const PACKAGE_KEYS = ["name", "role", "version", "filename", "npmIntegrity", "sha256", "size"];
const MAX_CONTROL_BYTES = 1024 * 1024;

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readStableRegularFile(path, maximum) {
  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > BigInt(maximum)) {
    throw new Error("RELEASE_ASSET_FILE_INVALID: asset must be one bounded regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(beforePath, before)) {
      throw new Error("RELEASE_ASSET_FILE_CHANGED: asset identity changed before read");
    }
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, size - offset), offset);
      if (bytesRead === 0) throw new Error("RELEASE_ASSET_FILE_CHANGED: asset ended during read");
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
      throw new Error("RELEASE_ASSET_FILE_CHANGED: asset grew during read");
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(after, afterPath)) {
      throw new Error("RELEASE_ASSET_FILE_CHANGED: asset identity changed during read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function gitHead(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024
  });
  return validateSourceCommit(result.status === 0 ? result.stdout.trim() : "");
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("RELEASE_MANIFEST_INVALID: manifest is not valid UTF-8 JSON");
  }
  if (!exactKeys(manifest, MANIFEST_KEYS) || !Buffer.from(bytes).equals(canonicalJsonBytes(manifest))) {
    throw new Error("RELEASE_MANIFEST_INVALID: manifest is not the exact canonical schema");
  }
  return manifest;
}

function expectedInventory(release) {
  return [
    RELEASE_CHECKSUMS,
    RELEASE_MANIFEST,
    ...release.packages.map(({ name }) => packageAssetFilename(name, release.version))
  ].sort(compareCodepoints);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function verifyReleaseAssets({
  repositoryRoot = defaultRepositoryRoot,
  directory,
  expectedSourceCommit,
  verifyPackages = true
}) {
  const expectedCommit = validateSourceCommit(expectedSourceCommit);
  if (gitHead(repositoryRoot) !== expectedCommit) {
    throw new Error("RELEASE_SOURCE_COMMIT_MISMATCH: expected source commit differs from checkout HEAD");
  }
  if (typeof directory !== "string" || directory === "") {
    throw new Error("RELEASE_ASSET_DIRECTORY_INVALID: release asset directory is required");
  }
  const requestedRoot = resolve(directory);
  const metadata = await lstat(requestedRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("RELEASE_ASSET_DIRECTORY_INVALID: release asset directory must be physical");
  }
  const root = await realpath(requestedRoot);
  const release = checkReleaseContract(repositoryRoot);
  const namesBefore = (await readdir(root, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("RELEASE_ASSET_INVENTORY_INVALID: every asset must be a regular file");
      }
      return entry.name;
    })
    .sort(compareCodepoints);
  const inventory = expectedInventory(release);
  if (!isDeepStrictEqual(namesBefore, inventory)) {
    throw new Error("RELEASE_ASSET_INVENTORY_INVALID: expected the exact nine release files");
  }

  const bytesByName = new Map();
  for (const name of namesBefore) {
    bytesByName.set(name, await readStableRegularFile(
      join(root, name),
      name.endsWith(".tgz") ? MAX_PACKAGE_BYTES : MAX_CONTROL_BYTES
    ));
  }
  const namesAfter = (await readdir(root)).sort(compareCodepoints);
  const metadataAfter = await lstat(root, { bigint: true });
  if (!isDeepStrictEqual(namesAfter, namesBefore) || !sameIdentity(metadata, metadataAfter)) {
    throw new Error("RELEASE_ASSET_INVENTORY_CHANGED: asset directory changed during verification");
  }

  const manifestBytes = bytesByName.get(RELEASE_MANIFEST);
  const manifest = parseManifest(manifestBytes);
  if (
    manifest.schemaVersion !== 1
    || manifest.repository !== RELEASE_REPOSITORY
    || manifest.sourceCommit !== expectedCommit
    || manifest.provenanceScope !== "npm-registry-byte-assembly"
    || manifest.version !== release.version
    || manifest.channel !== release.channel
    || manifest.npmTag !== release.npmTag
    || manifest.githubPrerelease !== release.githubPrerelease
    || !Array.isArray(manifest.packages)
    || manifest.packages.length !== release.packages.length
  ) {
    throw new Error("RELEASE_MANIFEST_MISMATCH: manifest differs from release contract or checkout");
  }

  const checksumRecords = [];
  for (let index = 0; index < release.packages.length; index += 1) {
    const expected = release.packages[index];
    const record = manifest.packages[index];
    const filename = packageAssetFilename(expected.name, release.version);
    if (
      !exactKeys(record, PACKAGE_KEYS)
      || record.name !== expected.name
      || record.role !== expected.role
      || record.version !== release.version
      || record.filename !== filename
      || !Number.isSafeInteger(record.size)
      || record.size < 1
      || typeof record.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(record.sha256)
    ) {
      throw new Error("RELEASE_MANIFEST_PACKAGE_INVALID: package record differs from the fixed release set");
    }
    parseSha512Integrity(record.npmIntegrity);
    const bytes = bytesByName.get(filename);
    if (
      bytes.length !== record.size
      || sha256(bytes) !== record.sha256
      || sha512Integrity(bytes) !== record.npmIntegrity
    ) {
      throw new Error(`RELEASE_ASSET_DIGEST_MISMATCH: ${filename} bytes differ from the manifest`);
    }
    if (verifyPackages) {
      if (expected.role === "cli") await verifyPackedArtifactBytes(bytes);
      else verifyNativeRenamePackageBytes(bytes, ...nativeTarget(expected.name));
    }
    checksumRecords.push({ filename, value: record.sha256 });
  }
  checksumRecords.push({ filename: RELEASE_MANIFEST, value: sha256(manifestBytes) });
  checksumRecords.sort((left, right) => compareCodepoints(left.filename, right.filename));
  const expectedChecksums = `${checksumRecords
    .map(({ filename, value }) => `${value}  ${filename}`)
    .join("\n")}\n`;
  const checksumBytes = bytesByName.get(RELEASE_CHECKSUMS);
  if (!checksumBytes.equals(Buffer.from(expectedChecksums, "utf8"))) {
    throw new Error("RELEASE_CHECKSUMS_INVALID: SHA256SUMS differs from exact release bytes");
  }

  const assets = namesBefore.map((filename) => {
    const bytes = bytesByName.get(filename);
    return Object.freeze({ filename, bytes, sha256: sha256(bytes), size: bytes.length });
  });
  return Object.freeze({
    manifest: deepFreeze(manifest),
    assets: Object.freeze(assets),
    files: assets.length,
    packageContentsVerified: verifyPackages
  });
}

async function main() {
  const args = process.argv.slice(2);
  const envelopeOnly = args[0] === "--envelope-only";
  const values = args.slice(envelopeOnly ? 1 : 0);
  if (values.length !== 3 || values[0] !== "--source-commit") {
    throw new Error("Usage: verify-release-assets.mjs [--envelope-only] --source-commit <sha> <directory>");
  }
  const result = await verifyReleaseAssets({
    expectedSourceCommit: values[1],
    directory: values[2],
    verifyPackages: !envelopeOnly
  });
  process.stdout.write(`Verified ${result.files} exact release assets.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${boundedDiagnostic(
      error instanceof Error ? error.message : "Release asset verification failed",
      2_048
    )}\n`);
    process.exitCode = 1;
  });
}
