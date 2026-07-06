#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReleaseContract } from "./release-contract.mjs";
import {
  MAX_PACKAGE_BYTES,
  MAX_REGISTRY_METADATA_BYTES,
  RELEASE_CHECKSUMS,
  RELEASE_MANIFEST,
  RELEASE_REPOSITORY,
  boundedDiagnostic,
  canonicalJsonBytes,
  compareCodepoints,
  nativeTarget,
  packageAssetFilename,
  parseSha512Integrity,
  sha256,
  sha512Integrity,
  validateSourceCommit
} from "./release-assets.mjs";
import { verifyPackedArtifact } from "./verify-cli-package.mjs";
import { verifyNativeRenamePackage } from "./verify-native-rename-package.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";

const REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 30_000;
const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitHead(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return validateSourceCommit(value);
}

function validateRegistryTarball(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REGISTRY_TARBALL_URL_INVALID: registry tarball URL is malformed");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "registry.npmjs.org"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.origin !== REGISTRY
  ) {
    throw new Error("REGISTRY_TARBALL_URL_INVALID: registry tarball URL is outside the fixed public registry");
  }
  return url.href;
}

async function boundedResponseBytes(response, maximum, label) {
  if (!response || response.status !== 200 || response.redirected) {
    throw new Error(`${label}_HTTP_INVALID: expected one non-redirected HTTP 200 response`);
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    if (!/^(0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximum) {
      throw new Error(`${label}_TOO_LARGE: response exceeds the byte limit`);
    }
  }
  if (!response.body) throw new Error(`${label}_BODY_INVALID: response body is missing`);
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error(`${label}_TOO_LARGE: response exceeds the byte limit`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function registryRequest(fetchImpl, url, maximum, label, accept) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return await boundedResponseBytes(response, maximum, label);
  } catch (error) {
    throw new Error(`${label}_REQUEST_FAILED: ${boundedDiagnostic(error instanceof Error ? error.message : error, 1_024)}`);
  }
}

async function resolveMetadata(fetchImpl, item, version) {
  const url = `${REGISTRY}/${encodeURIComponent(item.name)}/${version}`;
  const bytes = await registryRequest(fetchImpl, url, MAX_REGISTRY_METADATA_BYTES, "REGISTRY_METADATA", "application/json");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`REGISTRY_METADATA_INVALID: ${item.name}@${version} metadata is not valid UTF-8 JSON`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.name !== item.name
    || value.version !== version
    || value.dist === null
    || typeof value.dist !== "object"
    || Array.isArray(value.dist)
  ) {
    throw new Error(`REGISTRY_METADATA_INVALID: ${item.name}@${version} identity differs from the release contract`);
  }
  return {
    item,
    tarball: validateRegistryTarball(value.dist.tarball),
    integrity: parseSha512Integrity(value.dist.integrity),
    filename: packageAssetFilename(item.name, version)
  };
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("RELEASE_OUTPUT_EXISTS: output directory already exists");
}

async function verifyPackage(path, metadata) {
  if (metadata.item.role === "cli") {
    await verifyPackedArtifact(path);
    return;
  }
  verifyNativeRenamePackage(path, ...nativeTarget(metadata.item.name));
}

export async function assembleReleaseAssets({
  repositoryRoot = defaultRepositoryRoot,
  outputDirectory,
  sourceCommit,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== "function") throw new Error("REGISTRY_FETCH_INVALID: fetch implementation is required");
  if (typeof outputDirectory !== "string" || outputDirectory === "") {
    throw new Error("RELEASE_OUTPUT_INVALID: output directory is required");
  }
  const expectedCommit = validateSourceCommit(sourceCommit);
  if (gitHead(repositoryRoot) !== expectedCommit) {
    throw new Error("RELEASE_SOURCE_COMMIT_MISMATCH: source commit differs from checkout HEAD");
  }
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_SHA !== expectedCommit) {
    throw new Error("RELEASE_SOURCE_COMMIT_MISMATCH: source commit differs from GITHUB_SHA");
  }
  const release = checkReleaseContract(repositoryRoot);
  const output = resolve(outputDirectory);
  await assertAbsent(output);
  await mkdir(dirname(output), { recursive: true });

  const resolved = [];
  for (const item of release.packages) {
    resolved.push(await resolveMetadata(fetchImpl, item, release.version));
  }

  const downloaded = [];
  for (const metadata of resolved) {
    const bytes = await registryRequest(
      fetchImpl,
      metadata.tarball,
      MAX_PACKAGE_BYTES,
      "REGISTRY_TARBALL",
      "application/octet-stream"
    );
    if (sha512Integrity(bytes) !== metadata.integrity) {
      throw new Error(`REGISTRY_INTEGRITY_MISMATCH: ${metadata.item.name}@${release.version} bytes differ from npm SRI`);
    }
    downloaded.push({ ...metadata, bytes });
  }

  const staging = await mkdtemp(join(dirname(output), ".skill-steward-release-"));
  try {
    const packageRecords = [];
    for (const item of downloaded) {
      const path = join(staging, item.filename);
      await writeFile(path, item.bytes, { mode: 0o644, flag: "wx" });
      await verifyPackage(path, item);
      packageRecords.push({
        name: item.item.name,
        role: item.item.role,
        version: release.version,
        filename: item.filename,
        npmIntegrity: item.integrity,
        sha256: sha256(item.bytes),
        size: item.bytes.length
      });
    }
    const manifest = {
      schemaVersion: 1,
      repository: RELEASE_REPOSITORY,
      sourceCommit: expectedCommit,
      provenanceScope: "npm-registry-byte-assembly",
      version: release.version,
      channel: release.channel,
      npmTag: release.npmTag,
      githubPrerelease: release.githubPrerelease,
      packages: packageRecords
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    await writeFile(join(staging, RELEASE_MANIFEST), manifestBytes, { mode: 0o644, flag: "wx" });
    const checksums = [
      ...packageRecords.map(({ filename, sha256: value }) => ({ filename, value })),
      { filename: RELEASE_MANIFEST, value: sha256(manifestBytes) }
    ].sort((left, right) => compareCodepoints(left.filename, right.filename));
    await writeFile(
      join(staging, RELEASE_CHECKSUMS),
      `${checksums.map(({ filename, value }) => `${value}  ${filename}`).join("\n")}\n`,
      { mode: 0o644, flag: "wx" }
    );
    await verifyReleaseAssets({
      repositoryRoot,
      directory: staging,
      expectedSourceCommit: expectedCommit
    });
    await assertAbsent(output);
    await rename(staging, output);
    return Object.freeze({ files: 9, manifest: Object.freeze(manifest) });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source-commit" || args[2] !== "--output") {
    throw new Error("Usage: assemble-release-assets.mjs --source-commit <sha> --output <directory>");
  }
  const result = await assembleReleaseAssets({ sourceCommit: args[1], outputDirectory: args[3] });
  process.stdout.write(`Assembled ${result.files} verified release assets.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${boundedDiagnostic(
      error instanceof Error ? error.message : "Release asset assembly failed",
      2_048
    )}\n`);
    process.exitCode = 1;
  });
}
