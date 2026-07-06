import { mkdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { checkReleaseContract } from "../../../scripts/release-contract.mjs";
import {
  expectedNativePackageName,
  verifyRegistryInstall
} from "../../../scripts/verify-registry-install.mjs";
import { resolve } from "node:path";

const release = checkReleaseContract(resolve(process.cwd(), "../.."));
const silentOutput = { write() {} };

function successfulOutput(args) {
  if (args.length === 0) return "Usage: skill-steward";
  if (args[0] === "--version") return `${release.version}\n`;
  if (args[0] === "dashboard") return "Launch the local Skill Steward dashboard";
  if (args[0] === "scan") return JSON.stringify({ skills: [{ name: "testing", scope: "project" }] });
  if (args[0] === "preflight") {
    return JSON.stringify({ installedCoverage: 1, use: [{ name: "testing" }] });
  }
  throw new Error(`Unexpected installed CLI arguments: ${args.join(" ")}`);
}

function fakeRunner(installFailures = []) {
  const calls = [];
  let installs = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "npm") {
      const failure = installFailures[installs];
      installs += 1;
      if (failure) return { status: 1, stdout: "", stderr: failure };
      return { status: 0, stdout: "installed", stderr: "" };
    }
    await mkdir(options.env.SKILL_STEWARD_HOME, { recursive: true, mode: 0o700 });
    return { status: 0, stdout: successfulOutput(args), stderr: "" };
  };
  return { run, calls };
}

it.each([
  ["linux", "x64", "gnu", "@skill-steward/rename-noreplace-linux-x64-gnu"],
  ["linux", "arm64", "musl", "@skill-steward/rename-noreplace-linux-arm64-musl"],
  ["darwin", "arm64", "none", "@skill-steward/rename-noreplace-darwin-arm64"],
  ["darwin", "x64", "none", "@skill-steward/rename-noreplace-darwin-x64"],
  ["win32", "x64", "none", null]
])("installs and exercises the exact registry CLI on %s/%s/%s", async (
  platform,
  arch,
  libc,
  expectedNative
) => {
  expect(expectedNativePackageName(platform, arch, libc)).toBe(expectedNative);
  const { run, calls } = fakeRunner();
  const nativePackageCheck = vi.fn(async () => undefined);
  const result = await verifyRegistryInstall({
    platform,
    arch,
    libc,
    run,
    sleep: async () => undefined,
    nativePackageCheck,
    output: silentOutput
  });

  expect(result).toMatchObject({ version: release.version, platform, nativePackage: expectedNative });
  const install = calls[0];
  expect(install.command).toBe("npm");
  expect(install.args).toContain(`skill-steward@${release.version}`);
  expect(install.args).toContain("--global");
  expect(install.args).toContain("--ignore-scripts");
  expect(install.args).toContain("--registry=https://registry.npmjs.org");
  if (expectedNative) {
    expect(nativePackageCheck).toHaveBeenCalledWith(expectedNative, expect.any(Object));
  } else {
    expect(nativePackageCheck).not.toHaveBeenCalled();
  }
  expect(calls.slice(1).map(({ args }) => args)).toEqual([
    [],
    ["--version"],
    ["dashboard", "--help"],
    ["scan", "--json"],
    [
      "preflight",
      "--task",
      "Review this TypeScript change for missing tests",
      "--harness",
      "codex",
      "--compact-json"
    ]
  ]);
});

it("retries only bounded registry E404 convergence failures", async () => {
  const converging = fakeRunner([
    "npm ERR! code E404",
    "npm ERR! code E404"
  ]);
  const sleep = vi.fn(async () => undefined);
  await verifyRegistryInstall({
    platform: "win32",
    arch: "x64",
    libc: "none",
    run: converging.run,
    sleep,
    output: silentOutput
  });
  expect(converging.calls.filter(({ command }) => command === "npm")).toHaveLength(3);
  expect(sleep).toHaveBeenCalledTimes(2);

  const unavailable = fakeRunner(["npm ERR! code E500"]);
  await expect(verifyRegistryInstall({
    platform: "win32",
    arch: "x64",
    libc: "none",
    run: unavailable.run,
    sleep: async () => undefined,
    output: silentOutput
  })).rejects.toThrow("Registry installation failed");
  expect(unavailable.calls.filter(({ command }) => command === "npm")).toHaveLength(1);
});
