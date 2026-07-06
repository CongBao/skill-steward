#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReleaseContract } from "./release-contract.mjs";
import { verifyPackedArtifact } from "./verify-cli-package.mjs";
import { verifyNativeRenamePackage } from "./verify-native-rename-package.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = new Map([
  ["darwin:arm64:none", {
    name: "@skill-steward/rename-noreplace-darwin-arm64",
    directory: "rename-noreplace-darwin-arm64"
  }],
  ["darwin:x64:none", {
    name: "@skill-steward/rename-noreplace-darwin-x64",
    directory: "rename-noreplace-darwin-x64"
  }],
  ["linux:arm64:gnu", {
    name: "@skill-steward/rename-noreplace-linux-arm64-gnu",
    directory: "rename-noreplace-linux-arm64-gnu"
  }],
  ["linux:arm64:musl", {
    name: "@skill-steward/rename-noreplace-linux-arm64-musl",
    directory: "rename-noreplace-linux-arm64-musl"
  }],
  ["linux:x64:gnu", {
    name: "@skill-steward/rename-noreplace-linux-x64-gnu",
    directory: "rename-noreplace-linux-x64-gnu"
  }],
  ["linux:x64:musl", {
    name: "@skill-steward/rename-noreplace-linux-x64-musl",
    directory: "rename-noreplace-linux-x64-musl"
  }]
]);

export function runtimeLibc(platform, report = process.report.getReport()) {
  if (platform !== "linux") return "none";
  return report?.header?.glibcVersionRuntime === undefined ? "musl" : "gnu";
}

export function candidateTarget(platform, arch, libc) {
  if (platform === "win32") return null;
  const target = targets.get(`${platform}:${arch}:${libc}`);
  if (target === undefined) {
    throw new Error(`LOCAL_CANDIDATE_TARGET_UNSUPPORTED: ${bounded(`${platform}/${arch}/${libc}`)}`);
  }
  return { ...target, platform, arch, libc };
}

function bounded(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 1_024);
}

function commandFailure(code, message, cause) {
  return new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
}

function validatedRegularFile(path, label, extensions) {
  if (!isAbsolute(path)) {
    throw commandFailure("LOCAL_CANDIDATE_PACKAGE_MANAGER_UNAVAILABLE", `${label} must be absolute`);
  }
  let physical;
  try {
    physical = realpathSync(path);
    if (!statSync(physical).isFile() || !extensions.has(extname(physical).toLowerCase())) {
      throw new Error("not a supported regular file");
    }
  } catch (error) {
    throw commandFailure(
      "LOCAL_CANDIDATE_PACKAGE_MANAGER_UNAVAILABLE",
      `${label} is missing or invalid`,
      error
    );
  }
  return physical;
}

export function packageManagerInvocation(command, args, {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath
} = {}) {
  if (command !== "npm" && command !== "pnpm") {
    throw commandFailure("LOCAL_CANDIDATE_PACKAGE_MANAGER_INVALID", "only npm and pnpm are supported");
  }
  if (platform !== "win32") return { command, args };

  const node = validatedRegularFile(
    execPath,
    "Windows Node executable",
    new Set([".exe"])
  );
  if (command === "pnpm") {
    const entry = validatedRegularFile(
      env.npm_execpath ?? "",
      "pnpm JavaScript entry point; run pnpm candidate:pack or pnpm candidate:install",
      new Set([".js", ".cjs", ".mjs"])
    );
    return { command: node, args: [entry, ...args] };
  }

  const entry = validatedRegularFile(
    join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    "npm JavaScript entry point",
    new Set([".js", ".cjs"])
  );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
  } catch (error) {
    throw commandFailure(
      "LOCAL_CANDIDATE_PACKAGE_MANAGER_UNAVAILABLE",
      "npm package metadata is missing or invalid",
      error
    );
  }
  if (manifest?.name !== "npm") {
    throw commandFailure("LOCAL_CANDIDATE_PACKAGE_MANAGER_UNAVAILABLE", "npm package identity is invalid");
  }
  return { command: node, args: [entry, ...args] };
}

function run(command, args, options = {}) {
  const invocation = packageManagerInvocation(command, args, options.invocationOptions);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `LOCAL_CANDIDATE_COMMAND_FAILED: ${bounded(command)} ${bounded(args.join(" "))}\n${bounded(result.stderr || result.stdout || result.error?.message || "unknown failure")}`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function existingEntries(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertPhysicalDirectoryAncestry(directory) {
  const { root } = parse(directory);
  let current = root;
  for (const segment of relative(root, directory).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("LOCAL_CANDIDATE_OUTPUT_UNSAFE: output ancestry must contain only physical directories");
    }
  }
}

async function prepareOutput(requestedDirectory) {
  if (requestedDirectory === undefined) {
    return mkdtemp(join(tmpdir(), "skill-steward-local-candidate-"));
  }
  const lexicalDirectory = resolve(requestedDirectory);
  if (lexicalDirectory === repositoryRoot || lexicalDirectory === resolve(repositoryRoot, "..")) {
    throw new Error("LOCAL_CANDIDATE_OUTPUT_UNSAFE: output cannot replace the repository");
  }
  let directory = lexicalDirectory;
  try {
    const metadata = await lstat(lexicalDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("LOCAL_CANDIDATE_OUTPUT_UNSAFE: output must be a physical directory");
    }
    directory = await realpath(lexicalDirectory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const missing = [];
    let ancestor = lexicalDirectory;
    while (true) {
      try {
        await lstat(ancestor);
        break;
      } catch (ancestorError) {
        if (!(ancestorError instanceof Error && "code" in ancestorError && ancestorError.code === "ENOENT")) {
          throw ancestorError;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    directory = join(await realpath(ancestor), ...missing);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPhysicalDirectoryAncestry(directory);
  const outputMetadata = await lstat(directory);
  if (process.platform !== "win32" && (outputMetadata.mode & 0o022) !== 0) {
    throw new Error("LOCAL_CANDIDATE_OUTPUT_UNSAFE: output must not be writable by group or other users");
  }
  const entries = await existingEntries(directory);
  if (entries.length > 0) {
    throw new Error("LOCAL_CANDIDATE_OUTPUT_NOT_EMPTY: choose an empty output directory");
  }
  return directory;
}

async function artifact(path, role, packageName, version) {
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return {
    role,
    packageName,
    version,
    file: basename(path),
    bytes: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function exactArtifact(entries, pattern, label) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`LOCAL_CANDIDATE_ARTIFACT_INVALID: expected one ${label} tarball`);
  }
  return matches[0];
}

export async function prepareLocalCandidate({
  outputDirectory,
  platform = process.platform,
  arch = process.arch,
  libc = runtimeLibc(platform),
  install = false,
  prefix
} = {}) {
  const output = await prepareOutput(outputDirectory);

  const release = checkReleaseContract(repositoryRoot);
  const target = candidateTarget(platform, arch, libc);
  const artifacts = [];
  const artifactPaths = new Map();
  if (target !== null) {
    const nativeDirectory = join(repositoryRoot, "packages", target.directory);
    run("pnpm", ["--filter", target.name, "build"]);
    run("npm", [
      "pack", "--ignore-scripts", "--pack-destination", output, "--no-audit", "--no-fund"
    ], { cwd: nativeDirectory });
    const entries = await readdir(output);
    const nativeName = exactArtifact(
      entries,
      new RegExp(`^skill-steward-${target.directory}-${release.version.replaceAll(".", "\\.")}\\.tgz$`, "u"),
      "native"
    );
    const nativePath = join(output, nativeName);
    verifyNativeRenamePackage(nativePath, platform, arch, libc);
    artifacts.push(await artifact(nativePath, "native", target.name, release.version));
    artifactPaths.set("native", nativePath);
  }

  run("pnpm", ["--filter", "skill-steward", "pack", "--pack-destination", output]);
  const entries = await readdir(output);
  const cliName = exactArtifact(
    entries,
    new RegExp(`^skill-steward-${release.version.replaceAll(".", "\\.")}\\.tgz$`, "u"),
    "CLI"
  );
  const cliPath = join(output, cliName);
  await verifyPackedArtifact(cliPath);
  artifacts.push(await artifact(cliPath, "cli", "skill-steward", release.version));
  artifactPaths.set("cli", cliPath);

  if (install) {
    const prefixArgs = prefix === undefined ? [] : ["--prefix", resolve(prefix)];
    const nativePath = artifactPaths.get("native");
    if (nativePath !== undefined) {
      run("npm", [
        "install", "--global", ...prefixArgs, "--ignore-scripts", "--no-audit", "--no-fund", nativePath
      ]);
    }
    run("npm", [
      "install", "--global", ...prefixArgs, "--ignore-scripts", "--omit=optional",
      "--no-audit", "--no-fund", cliPath
    ]);
    await verifyInstalledCandidate(release.version, target, prefixArgs);
  }

  const manifest = {
    schemaVersion: 1,
    version: release.version,
    platform,
    arch,
    libc,
    lifecycleWrites: target !== null,
    installed: install,
    artifacts
  };
  await writeFile(
    join(output, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return { ...manifest, outputDirectory: output };
}

async function exactInstalledManifest(path, expectedName, expectedVersion) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw commandFailure("LOCAL_CANDIDATE_INSTALL_VERIFICATION_FAILED", `${expectedName} metadata is missing`, error);
  }
  if (manifest?.name !== expectedName || manifest?.version !== expectedVersion) {
    throw commandFailure("LOCAL_CANDIDATE_INSTALL_VERIFICATION_FAILED", `${expectedName} version does not match the candidate`);
  }
  return manifest;
}

async function verifyInstalledCandidate(version, target, prefixArgs) {
  const rootResult = run("npm", ["root", "--global", ...prefixArgs]);
  const globalRoot = rootResult.stdout.trim();
  if (!isAbsolute(globalRoot)) {
    throw commandFailure("LOCAL_CANDIDATE_INSTALL_VERIFICATION_FAILED", "npm returned no absolute global package root");
  }
  const cliManifestPath = join(globalRoot, "skill-steward", "package.json");
  await exactInstalledManifest(cliManifestPath, "skill-steward", version);
  if (target === null) return;

  const nativeManifestPath = join(globalRoot, ...target.name.split("/"), "package.json");
  await exactInstalledManifest(nativeManifestPath, target.name, version);
  let binding;
  try {
    binding = createRequire(cliManifestPath)(target.name);
  } catch (error) {
    throw commandFailure("LOCAL_CANDIDATE_INSTALL_VERIFICATION_FAILED", "native helper cannot be loaded", error);
  }
  const expected = `skill-steward.owned-tree-native.v3:${version}:${target.platform}:${target.arch}:${target.libc}`;
  if (
    binding === null
    || typeof binding !== "object"
    || typeof binding.metadata !== "function"
    || binding.metadata() !== expected
  ) {
    throw commandFailure("LOCAL_CANDIDATE_INSTALL_VERIFICATION_FAILED", "native helper metadata does not match the candidate");
  }
}

function parseArguments(args) {
  let outputDirectory;
  let install = false;
  let prefix;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--output" && args[index + 1]) outputDirectory = args[++index];
    else if (argument === "--prefix" && args[index + 1]) prefix = args[++index];
    else if (argument === "--install") install = true;
    else if (argument === "--json") json = true;
    else throw new Error("Usage: prepare-local-candidate.mjs [--output <directory>] [--install] [--prefix <directory>] [--json]");
  }
  if (prefix !== undefined && !install) {
    throw new Error("LOCAL_CANDIDATE_PREFIX_WITHOUT_INSTALL: --prefix requires --install");
  }
  return { ...(outputDirectory === undefined ? {} : { outputDirectory }), install, prefix, json };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const result = await prepareLocalCandidate(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`Verified local candidate ${result.version} for ${result.platform}/${result.arch}/${result.libc}.\n`);
    process.stdout.write(`Artifacts: ${result.artifacts.map(({ file }) => join(result.outputDirectory, file)).join(", ")}\n`);
    if (result.installed) process.stdout.write("Installed the verified local candidate.\n");
    if (!result.lifecycleWrites) {
      process.stdout.write("Managed integration lifecycle writes remain unavailable on this platform.\n");
    }
  }
}
