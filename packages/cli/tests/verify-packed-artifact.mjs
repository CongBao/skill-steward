#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const REQUIRED_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/THIRD_PARTY_NOTICES.txt",
  "package/dist/third-party-manifest.json",
  "package/package.json"
];
const TRUSTED_FILES = [
  ["package/LICENSE", "LICENSE"],
  ["package/README.md", "README.md"],
  ["package/dist/THIRD_PARTY_NOTICES.txt", "dist/THIRD_PARTY_NOTICES.txt"],
  ["package/dist/third-party-manifest.json", "dist/third-party-manifest.json"]
];
const REQUIRED_RUNTIME_ROOTS = ["commander", "fastify", "react", "vite", "yaml", "zod"];
const defaultTrustedPackageDirectory = fileURLToPath(new URL("../", import.meta.url));

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
    throw new Error(`Unsafe tar path '${input}'`);
  }
  const segments = input.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new Error(`Unsafe tar path '${input}'`);
  const normalized = segments.join("/");
  if (normalized !== "package" && !normalized.startsWith("package/")) {
    throw new Error(`Tar entry is outside package/: '${input}'`);
  }
  return normalized;
}

export function parseTarEntries(compressed) {
  const archive = gunzipSync(compressed);
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
    if (seenPaths.has(path)) throw new Error(`Duplicate tar path '${path}'`);
    seenPaths.add(path);
    if (type === "0" || type === "\0" || type === "") {
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
}

async function trustedBaseline(trustedPackageDirectory) {
  const files = new Map();
  for (const [archivePath, relativePath] of TRUSTED_FILES) {
    const value = await readFile(join(trustedPackageDirectory, relativePath));
    if (value.length === 0) throw new Error(`Trusted expected file is empty: ${relativePath}`);
    files.set(archivePath, value);
  }
  const manifest = JSON.parse(
    files.get("package/dist/third-party-manifest.json").toString("utf8")
  );
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("Trusted expected dependency manifest is empty or invalid");
  }
  const identifiers = [];
  const names = new Set();
  for (const entry of manifest.packages) {
    if (
      typeof entry?.name !== "string"
      || typeof entry?.version !== "string"
      || typeof entry?.license !== "string"
      || !Array.isArray(entry?.attributions)
      || entry.attributions.length === 0
    ) {
      throw new Error("Trusted expected dependency manifest has incomplete attribution");
    }
    names.add(entry.name);
    identifiers.push(`${entry.name}@${entry.version}`);
  }
  const sorted = [...identifiers].sort(compare);
  if (new Set(identifiers).size !== identifiers.length || JSON.stringify(identifiers) !== JSON.stringify(sorted)) {
    throw new Error("Trusted expected dependency manifest is not a unique deterministic set");
  }
  for (const name of REQUIRED_RUNTIME_ROOTS) {
    if (!names.has(name)) throw new Error(`Trusted expected dependency manifest is missing ${name}`);
  }
  const notices = files.get("package/dist/THIRD_PARTY_NOTICES.txt").toString("utf8");
  if (notices.trim() === "# Third-Party Notices") {
    throw new Error("Trusted expected third-party notices are empty");
  }
  for (const identifier of identifiers) {
    if (!notices.includes(`## ${identifier}\n`)) {
      throw new Error(`Trusted expected notices do not cover ${identifier}`);
    }
  }
  return { files, identifiers };
}

export async function verifyPackedArtifact(path, options = {}) {
  const files = parseTarEntries(await readFile(path));
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) throw new Error(`Missing ${required}`);
  }
  const trusted = await trustedBaseline(
    options.trustedPackageDirectory ?? defaultTrustedPackageDirectory
  );
  for (const [archivePath, expected] of trusted.files) {
    if (!files.get(archivePath)?.equals(expected)) {
      throw new Error(`Packed ${archivePath} differs from the trusted expected build output`);
    }
  }
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
      throw new Error(`Third-party notices do not cover ${identifier}`);
    }
  }
  if (/(?:^|[\s('"`])(?:\/[Uu]sers\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:[\\/])/m.test(notices)) {
    throw new Error("Third-party notices contain an absolute local path");
  }
  if (JSON.stringify(identifiers) !== JSON.stringify(trusted.identifiers)) {
    throw new Error("Packed dependency manifest differs from the trusted expected package set");
  }
  return { files: files.size, packages: identifiers.length };
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
      throw new Error("Usage: verify-packed-artifact.mjs --dry-run <pack.json>");
    }
    const result = await verifyDryRun(args[1]);
    process.stdout.write(`Verified ${result.files} dry-run files.\n`);
  } else {
    if (args.length !== 1) {
      throw new Error("Usage: verify-packed-artifact.mjs <package.tgz>");
    }
    const result = await verifyPackedArtifact(args[0]);
    process.stdout.write(`Verified ${result.files} files and ${result.packages} third-party packages.\n`);
  }
}
