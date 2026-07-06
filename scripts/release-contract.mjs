#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const PUBLIC_RELEASE_PACKAGES = Object.freeze([
  Object.freeze({ name: "skill-steward", path: "packages/cli", role: "cli" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-darwin-arm64", path: "packages/rename-noreplace-darwin-arm64", role: "native" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-darwin-x64", path: "packages/rename-noreplace-darwin-x64", role: "native" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-linux-arm64-gnu", path: "packages/rename-noreplace-linux-arm64-gnu", role: "native" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-linux-arm64-musl", path: "packages/rename-noreplace-linux-arm64-musl", role: "native" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-linux-x64-gnu", path: "packages/rename-noreplace-linux-x64-gnu", role: "native" }),
  Object.freeze({ name: "@skill-steward/rename-noreplace-linux-x64-musl", path: "packages/rename-noreplace-linux-x64-musl", role: "native" })
]);

const contractKeys = ["schemaVersion", "version", "channel", "npmTag", "githubPrerelease", "packages"];
const packageKeys = ["name", "path", "role"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta)\.(0|[1-9]\d*))?$/u;

function failure(code, message) {
  return new Error(`${code}: ${message}`);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function expectedChannel(version) {
  const match = versionPattern.exec(version);
  if (!match) throw failure("RELEASE_VERSION_INVALID", "version must be stable, alpha.N, or beta.N semantic version without build metadata");
  return match[4] ?? "stable";
}

export function parseReleaseContract(value) {
  if (!exactKeys(value, contractKeys)) {
    throw failure("RELEASE_CONTRACT_KEYS_INVALID", "release contract keys are not the exact supported schema");
  }
  if (value.schemaVersion !== 1 || typeof value.version !== "string") {
    throw failure("RELEASE_CONTRACT_KEYS_INVALID", "release contract schema or version field is invalid");
  }
  const derivedChannel = expectedChannel(value.version);
  const expectedTag = derivedChannel === "stable" ? "latest" : derivedChannel;
  if (
    value.channel !== derivedChannel
    || value.npmTag !== expectedTag
    || value.githubPrerelease !== (derivedChannel !== "stable")
  ) {
    throw failure("RELEASE_CHANNEL_MISMATCH", "semantic version, channel, npm tag, and GitHub prerelease intent disagree");
  }
  if (!Array.isArray(value.packages) || value.packages.length !== PUBLIC_RELEASE_PACKAGES.length) {
    throw failure("RELEASE_PACKAGE_SET_INVALID", "release contract must contain the exact seven public packages");
  }
  for (let index = 0; index < PUBLIC_RELEASE_PACKAGES.length; index += 1) {
    const item = value.packages[index];
    if (!exactKeys(item, packageKeys) || !isDeepStrictEqual(item, PUBLIC_RELEASE_PACKAGES[index])) {
      throw failure("RELEASE_PACKAGE_SET_INVALID", "release package names, paths, roles, and order are fixed");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    version: value.version,
    channel: value.channel,
    npmTag: value.npmTag,
    githubPrerelease: value.githubPrerelease,
    packages: PUBLIC_RELEASE_PACKAGES
  });
}

function readJson(path, code, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw failure(code, `${label} is missing or invalid JSON`);
  }
}

export function loadReleaseContract(repositoryRoot) {
  return parseReleaseContract(readJson(
    join(repositoryRoot, "release-contract.json"),
    "RELEASE_CONTRACT_INVALID",
    "release-contract.json"
  ));
}

function safePackageManifest(repositoryRoot, item) {
  const root = realpathSync(repositoryRoot);
  const packageDirectory = resolve(root, item.path);
  let directoryMetadata;
  let manifestMetadata;
  try {
    directoryMetadata = lstatSync(packageDirectory);
    manifestMetadata = lstatSync(join(packageDirectory, "package.json"));
  } catch {
    throw failure("RELEASE_PACKAGE_PATH_UNSAFE", `${item.path} is missing or not a physical package directory`);
  }
  const physicalDirectory = realpathSync(packageDirectory);
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || !manifestMetadata.isFile()
    || manifestMetadata.isSymbolicLink()
    || physicalDirectory !== packageDirectory
  ) {
    throw failure("RELEASE_PACKAGE_PATH_UNSAFE", `${item.path} must be a physical in-repository package directory`);
  }
  const path = join(packageDirectory, "package.json");
  return { path, manifest: readJson(path, "RELEASE_MANIFEST_INVALID", `${item.path}/package.json`) };
}

function workspaceManifestPaths(repositoryRoot) {
  const result = [join(repositoryRoot, "package.json")];
  for (const group of ["packages", "apps"]) {
    const groupPath = join(repositoryRoot, group);
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw failure(
          "RELEASE_PACKAGE_PATH_UNSAFE",
          `${group}/${entry.name} must not be a symbolic link`
        );
      }
      if (!entry.isDirectory()) continue;
      result.push(join(groupPath, entry.name, "package.json"));
    }
  }
  return result;
}

function inspectRepository(repositoryRoot, contract, allowVersionDrift) {
  const records = contract.packages.map((item) => ({ item, ...safePackageManifest(repositoryRoot, item) }));
  for (const { item, manifest } of records) {
    if (manifest.name !== item.name || manifest.private === true) {
      throw failure("RELEASE_PUBLIC_PACKAGE_SET_INVALID", `${item.path} identity or public status drifted`);
    }
    if (!allowVersionDrift && manifest.version !== contract.version) {
      throw failure("RELEASE_MANIFEST_VERSION_DRIFT", `${item.path} version does not match the release contract`);
    }
  }

  const expectedNames = contract.packages.map(({ name }) => name);
  const actualPublicNames = [];
  for (const path of workspaceManifestPaths(repositoryRoot)) {
    const manifest = readJson(path, "RELEASE_MANIFEST_INVALID", "workspace package.json");
    if (manifest.private !== true) actualPublicNames.push(manifest.name);
  }
  if (!isDeepStrictEqual([...actualPublicNames].sort(), [...expectedNames].sort())) {
    throw failure("RELEASE_PUBLIC_PACKAGE_SET_INVALID", "workspace public packages differ from the exact release package set");
  }

  const cli = records.find(({ item }) => item.role === "cli");
  const nativeNames = contract.packages.filter(({ role }) => role === "native").map(({ name }) => name);
  const dependencies = cli?.manifest.optionalDependencies;
  if (!dependencies || !isDeepStrictEqual(Object.keys(dependencies).sort(), [...nativeNames].sort())) {
    throw failure("RELEASE_NATIVE_DEPENDENCY_DRIFT", "CLI optional native dependency names differ from the release contract");
  }
  if (!allowVersionDrift && nativeNames.some((name) => dependencies[name] !== contract.version)) {
    throw failure("RELEASE_NATIVE_DEPENDENCY_DRIFT", "CLI optional native dependency versions differ from the release contract");
  }
  return records;
}

export function checkReleaseContract(repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const contract = loadReleaseContract(repositoryRoot);
  inspectRepository(repositoryRoot, contract, false);
  return contract;
}

export async function syncReleaseContract(repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const contract = loadReleaseContract(repositoryRoot);
  const records = inspectRepository(repositoryRoot, contract, true);
  const cli = records.find(({ item }) => item.role === "cli");
  const nativeNames = contract.packages.filter(({ role }) => role === "native").map(({ name }) => name);
  const changed = [];
  for (const record of records) {
    const next = { ...record.manifest, version: contract.version };
    if (record === cli) {
      next.optionalDependencies = Object.fromEntries(nativeNames.map((name) => [name, contract.version]));
    }
    if (!isDeepStrictEqual(next, record.manifest)) {
      const output = `${JSON.stringify(next, null, 2)}\n`;
      writeFileSync(record.path, output, { encoding: "utf8", mode: 0o644 });
      changed.push(`${record.item.path}/package.json`);
    }
  }
  checkReleaseContract(repositoryRoot);
  return changed;
}

async function main() {
  const command = process.argv[2] ?? "check";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "check") {
    const contract = checkReleaseContract(root);
    process.stdout.write(`Release contract valid: ${contract.version} (${contract.npmTag})\n`);
    return;
  }
  if (command === "sync") {
    const changed = await syncReleaseContract(root);
    process.stdout.write(changed.length ? `Synchronized ${changed.length} public package manifests\n` : "Release mirrors already synchronized\n");
    return;
  }
  throw failure("RELEASE_COMMAND_INVALID", "expected 'check' or 'sync'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "RELEASE_CONTRACT_FAILURE: unknown error"}\n`);
    process.exitCode = 1;
  });
}
