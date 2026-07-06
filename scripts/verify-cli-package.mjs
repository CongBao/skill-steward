#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  manifestPackagesFromAudit,
  sha256,
  validateRuntimeAuditSnapshot
} from "../packages/cli/runtime-audit.mjs";
import { checkReleaseContract } from "./release-contract.mjs";
import { boundedDiagnostic, MAX_UNPACKED_PACKAGE_BYTES } from "./release-assets.mjs";

const BLOCK_SIZE = 512;
const REQUIRED_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/THIRD_PARTY_NOTICES.txt",
  "package/dist/third-party-manifest.json",
  "package/package.json"
];
const defaultTrustedPackageDirectory = fileURLToPath(new URL("../packages/cli/", import.meta.url));
const runtimeAuditPath = fileURLToPath(new URL("../packages/cli/runtime-audit.json", import.meta.url));
const release = checkReleaseContract(fileURLToPath(new URL("../", import.meta.url)));
const PNPM_REMOVED_LIFECYCLES = new Set([
  "postpack",
  "postpublish",
  "prepack",
  "prepare",
  "prepublishOnly",
  "publish"
]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function field(block, start, length) {
  return block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function octal(block, start, length) {
  const value = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`Invalid tar octal field '${value}'`);
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function checksum(block) {
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return sum;
}

function parsePax(source) {
  const values = {};
  let offset = 0;
  while (offset < source.length) {
    const separator = source.indexOf(0x20, offset);
    if (separator < 0) throw new Error("Malformed PAX record length");
    const lengthBytes = source.subarray(offset, separator);
    if (!/^[1-9][0-9]*$/.test(lengthBytes.toString("ascii"))) {
      throw new Error("Malformed PAX record length");
    }
    const length = Number.parseInt(lengthBytes.toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > source.length) {
      throw new Error("Malformed PAX record size");
    }
    if (source[offset + length - 1] !== 0x0a) {
      throw new Error("Malformed PAX record newline terminator");
    }
    const record = source.subarray(separator + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("Malformed PAX record value");
    const key = record.slice(0, equals);
    if (/\0|\r|\n/.test(key)) throw new Error("Malformed PAX record key");
    values[key] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function safeArchivePath(input) {
  if (
    input.includes("\0")
    || input.includes("\\")
    || input.startsWith("/")
    || /^[A-Za-z]:/.test(input)
  ) {
    throw new Error(`Unsafe tar path '${boundedDiagnostic(input, 512)}'`);
  }
  const segments = input.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new Error(`Unsafe tar path '${boundedDiagnostic(input, 512)}'`);
  const normalized = segments.join("/");
  if (normalized !== "package" && !normalized.startsWith("package/")) {
    throw new Error(`Tar entry is outside package/: '${boundedDiagnostic(input, 512)}'`);
  }
  return normalized;
}

export function parseTarEntries(compressed, maximumUnpackedBytes = MAX_UNPACKED_PACKAGE_BYTES) {
  let archive;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: maximumUnpackedBytes });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("Tar archive exceeds the unpacked byte limit");
    }
    throw error;
  }
  if (archive.length % BLOCK_SIZE !== 0) {
    throw new Error("Tar archive has a partial trailing block");
  }
  const files = new Map();
  const seenPaths = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  let ended = false;
  let nextPath;
  let globalPax = {};
  let localPax = {};
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (ended) {
      if (!header.every((byte) => byte === 0)) {
        throw new Error("Tar archive contains non-zero trailing data after end markers");
      }
      continue;
    }
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) ended = true;
      continue;
    }
    if (zeroBlocks > 0) throw new Error("Tar archive is missing two consecutive end markers");
    const expectedChecksum = octal(header, 148, 8);
    if (checksum(header) !== expectedChecksum) throw new Error("Tar header checksum mismatch");
    const type = String.fromCharCode(header[156] || 0);
    const metadata = { ...globalPax, ...localPax };
    const headerSize = octal(header, 124, 12);
    const size = !["x", "g", "L"].includes(type) && metadata.size !== undefined
      ? Number(metadata.size)
      : headerSize;
    if (!Number.isSafeInteger(size) || size < 0 || `${size}` !== `${metadata.size ?? size}`) {
      throw new Error("Invalid PAX entry size");
    }
    const rawName = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;
    if (offset + size > archive.length) throw new Error("Tar entry exceeds archive size");
    const content = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (type === "x") {
      localPax = parsePax(content);
      continue;
    }
    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(content) };
      continue;
    }
    if (type === "L") {
      nextPath = content.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (!["0", "\0", "", "5"].includes(type)) {
      throw new Error(`Unsupported tar entry type '${type}'`);
    }
    const path = safeArchivePath(metadata.path ?? nextPath ?? headerPath);
    localPax = {};
    nextPath = undefined;
    if (seenPaths.has(path)) throw new Error(`Duplicate tar path '${boundedDiagnostic(path, 512)}'`);
    seenPaths.add(path);
    if (type === "5") {
      files.set(path, Buffer.alloc(0));
    } else if (type === "0" || type === "\0" || type === "") {
      files.set(path, Buffer.from(content));
    }
  }
  if (!ended) throw new Error("Tar archive is missing two end marker blocks");
  return files;
}

function jsonFile(files, path) {
  const source = files.get(path);
  if (!source) throw new Error(`Missing ${path}`);
  return JSON.parse(source.toString("utf8"));
}

function assertMetadata(packageJson) {
  if (packageJson.repository?.url !== "git+https://github.com/CongBao/skill-steward.git") {
    throw new Error("Packed package repository metadata is incomplete");
  }
  if (packageJson.homepage !== "https://github.com/CongBao/skill-steward#readme") {
    throw new Error("Packed package homepage metadata is incomplete");
  }
  if (packageJson.bugs?.url !== "https://github.com/CongBao/skill-steward/issues") {
    throw new Error("Packed package bugs metadata is incomplete");
  }
  if (packageJson.author?.name !== "CongBao" || packageJson.author?.email !== "bao_cong@outlook.com") {
    throw new Error("Packed package author metadata is incomplete");
  }
  if (packageJson.publishConfig?.access !== "public" || packageJson.engines?.node !== ">=22") {
    throw new Error("Packed package publication metadata is incomplete");
  }
  const expectedNativeHelpers = {
    "@skill-steward/rename-noreplace-darwin-arm64": release.version,
    "@skill-steward/rename-noreplace-darwin-x64": release.version,
    "@skill-steward/rename-noreplace-linux-arm64-gnu": release.version,
    "@skill-steward/rename-noreplace-linux-arm64-musl": release.version,
    "@skill-steward/rename-noreplace-linux-x64-gnu": release.version,
    "@skill-steward/rename-noreplace-linux-x64-musl": release.version
  };
  if (JSON.stringify(packageJson.optionalDependencies) !== JSON.stringify(expectedNativeHelpers)) {
    throw new Error("Packed package native no-replace helpers are incomplete");
  }
}

async function regularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Trusted package tree is missing ${label}`);
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`Trusted package tree ${label} must be a regular file, not a symbolic link or other entry`);
  }
  return readFile(path);
}

export async function readTrustedPackageTree(packageDirectory) {
  const files = new Map();
  for (const name of ["LICENSE", "README.md", "package.json"]) {
    files.set(`package/${name}`, await regularFile(join(packageDirectory, name), name));
  }
  const dist = join(packageDirectory, "dist");
  let distMetadata;
  try {
    distMetadata = await lstat(dist);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Trusted package tree is missing dist/");
    }
    throw error;
  }
  if (!distMetadata.isDirectory() || distMetadata.isSymbolicLink()) {
    throw new Error("Trusted package tree dist/ must be a real directory");
  }
  async function visit(directory, archiveDirectory) {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compare(left.name, right.name))) {
      const path = join(directory, entry.name);
      const archivePath = `${archiveDirectory}/${entry.name}`;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Trusted package tree rejects symbolic link ${archivePath}`);
      }
      if (metadata.isDirectory()) {
        await visit(path, archivePath);
      } else if (metadata.isFile()) {
        files.set(archivePath, await readFile(path));
      } else {
        throw new Error(`Trusted package tree rejects non-regular entry ${archivePath}`);
      }
    }
  }
  await visit(dist, "package/dist");
  if (files.size === 3) {
    throw new Error("Trusted package tree dist/ contains no regular files");
  }
  return files;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(compare).map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

async function workspaceDependencyManifest(workspaceRoot, name) {
  const matches = [];
  for (const group of ["packages", "apps"]) {
    const groupPath = join(workspaceRoot, group);
    for (const entry of await readdir(groupPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Trusted pnpm workspace entry must not be a symbolic link: ${group}/${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupPath, entry.name, "package.json");
      let metadata;
      try {
        metadata = await lstat(manifestPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `Trusted pnpm workspace manifest ${group}/${entry.name}/package.json must be a regular file`
        );
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === name) matches.push(manifest);
    }
  }
  if (matches.length !== 1 || typeof matches[0].version !== "string" || matches[0].version === "") {
    throw new Error(`Trusted pnpm workspace dependency ${name} has no unique version`);
  }
  return matches[0];
}

async function pnpmPackedManifest(source, packageDirectory, workspaceRoot) {
  const expected = structuredClone(source);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (expected[field] === undefined) continue;
    for (const [name, specifier] of Object.entries(expected[field])) {
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
      if (!/^workspace:[*^~]$/.test(specifier)) {
        throw new Error(`Trusted package.json uses unsupported pnpm workspace specifier ${name}=${specifier}`);
      }
      const dependencyManifest = workspaceRoot
        ? await workspaceDependencyManifest(workspaceRoot, name)
        : JSON.parse(await readFile(join(
          packageDirectory,
          "node_modules",
          ...name.split("/"),
          "package.json"
        ), "utf8"));
      if (typeof dependencyManifest.version !== "string" || dependencyManifest.version === "") {
        throw new Error(`Trusted pnpm workspace dependency ${name} has no version`);
      }
      const selector = specifier.slice("workspace:".length);
      expected[field][name] = selector === "*"
        ? dependencyManifest.version
        : `${selector}${dependencyManifest.version}`;
    }
  }
  if (expected.scripts !== undefined) {
    expected.scripts = Object.fromEntries(
      Object.entries(expected.scripts).filter(([name]) => !PNPM_REMOVED_LIFECYCLES.has(name))
    );
  }
  return expected;
}

async function assertPackedManifest(actual, expected, packageDirectory, workspaceRoot) {
  if (actual.equals(expected)) return;
  let parsedActual;
  let parsedExpected;
  try {
    parsedActual = JSON.parse(actual.toString("utf8"));
    parsedExpected = JSON.parse(expected.toString("utf8"));
  } catch (error) {
    throw new Error("Packed package.json differs from expected bytes and is not valid JSON", {
      cause: error
    });
  }
  const pnpmExpected = await pnpmPackedManifest(parsedExpected, packageDirectory, workspaceRoot);
  if (
    JSON.stringify(canonicalJson(parsedActual))
    !== JSON.stringify(canonicalJson(pnpmExpected))
  ) {
    throw new Error("Packed package.json contains changes outside strict pnpm canonical normalization");
  }
}

async function assertExactPackageTree(files, expected, packageDirectory, workspaceRoot) {
  const paths = [...files.keys()].sort(compare);
  const expectedPaths = [...expected.keys()].sort(compare);
  if (paths.length !== expectedPaths.length || paths.some((path, index) => path !== expectedPaths[index])) {
    const missing = expectedPaths.filter((path) => !files.has(path));
    const extra = paths.filter((path) => !expected.has(path));
    throw new Error(
      `Packed package tree differs from expected files; missing=[${missing
        .slice(0, 5)
        .map((path) => boundedDiagnostic(path, 256))
        .join(", ")}], extra=[${extra
        .slice(0, 5)
        .map((path) => boundedDiagnostic(path, 256))
        .join(", ")}]`
    );
  }
  for (const [path, value] of expected) {
    if (path === "package/package.json") {
      await assertPackedManifest(files.get(path), value, packageDirectory, workspaceRoot);
    } else if (!files.get(path).equals(value)) {
      throw new Error(`Packed package tree bytes differ from expected ${path}`);
    }
  }
}

async function sourceControlledAudit() {
  const snapshot = JSON.parse(await readFile(runtimeAuditPath, "utf8"));
  try {
    return validateRuntimeAuditSnapshot(snapshot);
  } catch (error) {
    throw new Error("Source-controlled full runtime audit is invalid", { cause: error });
  }
}

export async function verifyPackedArtifactBytes(bytes, {
  trustedPackageDirectory = defaultTrustedPackageDirectory,
  workspaceRoot
} = {}) {
  const files = parseTarEntries(bytes);
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) throw new Error(`Missing ${required}`);
  }
  await assertExactPackageTree(
    files,
    await readTrustedPackageTree(trustedPackageDirectory),
    trustedPackageDirectory,
    workspaceRoot
  );
  const audit = await sourceControlledAudit();
  const packageJson = jsonFile(files, "package/package.json");
  assertMetadata(packageJson);
  const manifest = jsonFile(files, "package/dist/third-party-manifest.json");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error("Third-party manifest is invalid");
  }
  const identifiers = manifest.packages.map((entry) => {
    if (
      typeof entry?.name !== "string"
      || typeof entry?.version !== "string"
      || typeof entry?.license !== "string"
      || entry.license.trim() === ""
    ) {
      throw new Error("Third-party manifest contains an invalid package");
    }
    return `${entry.name}@${entry.version}`;
  });
  const sorted = [...identifiers].sort(compare);
  if (new Set(identifiers).size !== identifiers.length || JSON.stringify(identifiers) !== JSON.stringify(sorted)) {
    throw new Error("Third-party manifest must be unique and deterministically sorted");
  }
  const notices = files.get("package/dist/THIRD_PARTY_NOTICES.txt").toString("utf8");
  for (const identifier of identifiers) {
    if (!notices.includes(`## ${identifier}\n`)) {
      throw new Error(`Third-party notices do not cover ${boundedDiagnostic(identifier, 512)}`);
    }
  }
  if (/(?:^|[\s('"`])(?:\/[Uu]sers\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:[\\/])/m.test(notices)) {
    throw new Error("Third-party notices contain an absolute local path");
  }
  if (sha256(notices) !== audit.noticesSha256) {
    throw new Error("Packed notices differ from the source-controlled full runtime audit");
  }
  if (JSON.stringify(manifest.packages) !== JSON.stringify(manifestPackagesFromAudit(audit))) {
    throw new Error("Packed manifest differs from the source-controlled full runtime audit");
  }
  return { files: files.size, packages: identifiers.length };
}

export async function verifyPackedArtifact(path, options) {
  return verifyPackedArtifactBytes(await readFile(path), options);
}

export async function verifyDryRun(path) {
  const result = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(result) || !Array.isArray(result[0]?.files)) {
    throw new Error("npm pack dry-run JSON is invalid");
  }
  const files = new Set(result[0].files.map((entry) => entry?.path));
  for (const required of REQUIRED_FILES) {
    const relative = required.replace(/^package\//, "");
    if (!files.has(relative)) throw new Error(`Dry-run is missing ${relative}`);
  }
  return { files: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--dry-run") {
    if (args.length !== 2) {
      throw new Error("Usage: verify-cli-package.mjs --dry-run <pack.json>");
    }
    const result = await verifyDryRun(args[1]);
    process.stdout.write(`Verified ${result.files} dry-run files.\n`);
  } else {
    if (args.length !== 1) {
      throw new Error("Usage: verify-cli-package.mjs <package.tgz>");
    }
    const result = await verifyPackedArtifact(args[0]);
    process.stdout.write(`Verified ${result.files} files and ${result.packages} third-party packages.\n`);
  }
}
