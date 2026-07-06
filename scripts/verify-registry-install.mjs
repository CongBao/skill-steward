#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReleaseContract } from "./release-contract.mjs";

const registry = "https://registry.npmjs.org";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const retryDelays = [2_000, 5_000, 10_000, 20_000, 30_000];

export function expectedNativePackageName(platform, arch, libc) {
  if (platform === "win32") return null;
  const suffix = platform === "linux" ? `-${libc}` : "";
  const name = `@skill-steward/rename-noreplace-${platform}-${arch}${suffix}`;
  const supported = new Set([
    "@skill-steward/rename-noreplace-darwin-arm64",
    "@skill-steward/rename-noreplace-darwin-x64",
    "@skill-steward/rename-noreplace-linux-arm64-gnu",
    "@skill-steward/rename-noreplace-linux-arm64-musl",
    "@skill-steward/rename-noreplace-linux-x64-gnu",
    "@skill-steward/rename-noreplace-linux-x64-musl"
  ]);
  if (!supported.has(name)) {
    throw new Error(`Registry smoke has no native contract target for ${platform}/${arch}/${libc}`);
  }
  return name;
}

function runtimeLibc(platform) {
  if (platform !== "linux") return "none";
  const report = process.report.getReport();
  return report.header.glibcVersionRuntime === undefined ? "musl" : "gnu";
}

async function defaultRun(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: options.shell ?? false,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error ? `${result.stderr ?? ""}\n${result.error.message}` : result.stderr ?? ""
  };
}

async function defaultNativePackageCheck(name, context) {
  const requireFromCli = createRequire(join(context.packageRoot, "package.json"));
  const manifest = JSON.parse(await readFile(requireFromCli.resolve(`${name}/package.json`), "utf8"));
  const binding = requireFromCli(name);
  const expectedMetadata = `skill-steward.owned-tree-native.v2:${context.platform}:${context.arch}:${context.libc}`;
  if (
    manifest.name !== name
    || manifest.version !== context.version
    || binding === null
    || typeof binding !== "object"
    || typeof binding.metadata !== "function"
    || typeof binding.renameNoReplace !== "function"
    || typeof binding.removeAt !== "function"
    || binding.metadata() !== expectedMetadata
  ) {
    throw new Error(`Installed native package is not loadable with expected metadata: ${name}`);
  }
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${boundedDiagnostic(`${result.stdout}\n${result.stderr}`)}`);
  }
  return result.stdout;
}

function boundedDiagnostic(value) {
  return String(value)
    .trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (
      character === "\n" || character === "\t"
        ? character
        : `\\u{${character.codePointAt(0).toString(16)}}`
    ))
    .slice(0, 2_048);
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

export async function verifyRegistryInstall({
  platform = process.platform,
  arch = process.arch,
  libc = runtimeLibc(platform),
  run = defaultRun,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  nativePackageCheck = defaultNativePackageCheck,
  output = process.stdout
} = {}) {
  const release = checkReleaseContract(repositoryRoot);
  const root = await mkdtemp(join(tmpdir(), "skill-steward-registry-smoke-"));
  const prefix = join(root, "prefix");
  const home = join(root, "home");
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const cache = join(root, "npm-cache");
  const skillDirectory = join(workspace, ".agents", "skills", "testing");
  const environment = {
    ...process.env,
    CI: "true",
    NO_COLOR: "1",
    HOME: home,
    USERPROFILE: home,
    SKILL_STEWARD_HOME: state,
    npm_config_cache: cache
  };
  const installArgs = [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--registry=${registry}`,
    `skill-steward@${release.version}`
  ];

  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(state, { recursive: true, mode: 0o700 }),
      mkdir(cache, { recursive: true }),
      mkdir(skillDirectory, { recursive: true })
    ]);
    await writeFile(join(skillDirectory, "SKILL.md"), `---
name: testing
description: Review TypeScript changes for missing tests and test coverage.
---

# Testing

Use when reviewing code changes for missing tests and regressions.
`, "utf8");

    let installed = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      const result = await run("npm", installArgs, { cwd: workspace, env: environment });
      if (result.status === 0) {
        installed = true;
        break;
      }
      const failure = boundedDiagnostic(`${result.stdout}\n${result.stderr}`);
      if (!/\bE404\b/u.test(failure) || attempt === retryDelays.length) {
        throw new Error(`Registry installation failed: ${failure.trim()}`);
      }
      await sleep(retryDelays[attempt]);
    }
    if (!installed) throw new Error("Registry installation did not converge within the bounded retry window");

    const packageRoot = platform === "win32"
      ? join(prefix, "node_modules", "skill-steward")
      : join(prefix, "lib", "node_modules", "skill-steward");
    const nativePackage = expectedNativePackageName(platform, arch, libc);
    if (nativePackage !== null) {
      if (!release.packages.some(({ name, role }) => role === "native" && name === nativePackage)) {
        throw new Error(`Runtime native package is outside the release contract: ${nativePackage}`);
      }
      await nativePackageCheck(nativePackage, {
        packageRoot,
        platform,
        arch,
        libc,
        version: release.version
      });
    }

    const binary = platform === "win32"
      ? join(prefix, "skill-steward.cmd")
      : join(prefix, "bin", "skill-steward");
    const runCli = async (args, label) => assertSuccess(await run(binary, args, {
      cwd: workspace,
      env: environment,
      shell: platform === "win32"
    }), label);

    if (!/Usage:\s+skill-steward/u.test(await runCli([], "Installed CLI"))) {
      throw new Error("Installed CLI bare output is not useful");
    }
    if ((await runCli(["--version"], "Installed CLI version")).trim() !== release.version) {
      throw new Error("Installed CLI version differs from the release contract");
    }
    if (!/Launch the local Skill Steward dashboard/u.test(
      await runCli(["dashboard", "--help"], "Installed dashboard help")
    )) {
      throw new Error("Installed dashboard help is incomplete");
    }
    const scan = parseJson(await runCli(["scan", "--json"], "Installed scan"), "Installed scan");
    if (!scan.skills?.some((skill) => skill.name === "testing" && skill.scope === "project")) {
      throw new Error("Installed scan did not find the synthetic project Skill");
    }
    const preflightArgs = [
      "preflight",
      "--task",
      "Review this TypeScript change for missing tests",
      "--harness",
      "codex",
      "--compact-json"
    ];
    const preflight = parseJson(
      await runCli(preflightArgs, "Installed Preflight"),
      "Installed Preflight"
    );
    if (preflight.installedCoverage !== 1 || preflight.use?.[0]?.name !== "testing") {
      throw new Error("Installed Preflight did not reach recommendation value");
    }
    const stateMetadata = await lstat(state);
    if (
      !stateMetadata.isDirectory()
      || (platform !== "win32" && (stateMetadata.mode & 0o077) !== 0)
    ) {
      throw new Error("Registry smoke state directory is not private");
    }
    output.write(`Verified registry install ${release.version} on ${platform}/${arch}/${libc}\n`);
    return { version: release.version, platform, arch, libc, nativePackage };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: verify-registry-install.mjs\n");
    process.exitCode = 1;
  } else {
    verifyRegistryInstall().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Registry install verification failed"}\n`);
      process.exitCode = 1;
    });
  }
}
