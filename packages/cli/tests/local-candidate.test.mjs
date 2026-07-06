import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  candidateTarget,
  packageManagerInvocation,
  prepareLocalCandidate,
  runtimeLibc
} from "../../../scripts/prepare-local-candidate.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd(), "../..");
const release = JSON.parse(await readFile(join(root, "release-contract.json"), "utf8"));
const script = join(root, "scripts", "prepare-local-candidate.mjs");

it.each([
  ["darwin", "arm64", "none", "@skill-steward/rename-noreplace-darwin-arm64"],
  ["darwin", "x64", "none", "@skill-steward/rename-noreplace-darwin-x64"],
  ["linux", "arm64", "gnu", "@skill-steward/rename-noreplace-linux-arm64-gnu"],
  ["linux", "arm64", "musl", "@skill-steward/rename-noreplace-linux-arm64-musl"],
  ["linux", "x64", "gnu", "@skill-steward/rename-noreplace-linux-x64-gnu"],
  ["linux", "x64", "musl", "@skill-steward/rename-noreplace-linux-x64-musl"],
  ["win32", "x64", "none", null]
])("selects only the current %s/%s/%s candidate helper", (platform, arch, libc, name) => {
  expect(candidateTarget(platform, arch, libc)?.name ?? null).toBe(name);
});

it("detects GNU and musl without treating other platforms as Linux", () => {
  expect(runtimeLibc("darwin", {})).toBe("none");
  expect(runtimeLibc("win32", {})).toBe("none");
  expect(runtimeLibc("linux", { header: { glibcVersionRuntime: "2.39" } })).toBe("gnu");
  expect(runtimeLibc("linux", { header: {} })).toBe("musl");
});

it("rejects a Windows package-manager launch without verified JavaScript entries", () => {
  expect(() => packageManagerInvocation("pnpm", ["pack"], {
    platform: "win32",
    env: {},
    execPath: "/missing/node.exe"
  })).toThrow(/LOCAL_CANDIDATE_PACKAGE_MANAGER_UNAVAILABLE/u);
  expect(packageManagerInvocation("pnpm", ["pack"], { platform: "linux" }))
    .toEqual({ command: "pnpm", args: ["pack"] });
});

it("launches verified Windows npm and pnpm JavaScript entries without a shell", async () => {
  const base = await mkdtemp(join(tmpdir(), "steward-package-manager-"));
  const node = join(base, "node.exe");
  const pnpm = join(base, "pnpm.cjs");
  const npmDirectory = join(base, "node_modules", "npm");
  const npm = join(npmDirectory, "bin", "npm-cli.js");
  await mkdir(join(npmDirectory, "bin"), { recursive: true });
  await Promise.all([
    writeFile(node, "fixture\n"),
    writeFile(pnpm, "fixture\n"),
    writeFile(npm, "fixture\n"),
    writeFile(join(npmDirectory, "package.json"), JSON.stringify({ name: "npm" }))
  ]);
  const physicalNode = await realpath(node);
  const physicalPnpm = await realpath(pnpm);
  const physicalNpm = await realpath(npm);

  const pnpmInvocation = packageManagerInvocation("pnpm", ["pack"], {
    platform: "win32",
    env: { npm_execpath: pnpm, npm_node_execpath: node },
    execPath: node
  });
  expect(await realpath(pnpmInvocation.command)).toBe(physicalNode);
  expect(await realpath(pnpmInvocation.args[0])).toBe(physicalPnpm);
  expect(pnpmInvocation.args.slice(1)).toEqual(["pack"]);

  const npmInvocation = packageManagerInvocation("npm", ["root", "--global"], {
    platform: "win32",
    env: { npm_node_execpath: node },
    execPath: node
  });
  expect(await realpath(npmInvocation.command)).toBe(physicalNode);
  expect(await realpath(npmInvocation.args[0])).toBe(physicalNpm);
  expect(npmInvocation.args.slice(1)).toEqual(["root", "--global"]);
});

it("rejects a linked output directory without deleting its external contents", async () => {
  const base = await mkdtemp(join(tmpdir(), "steward-candidate-output-"));
  const external = join(base, "external");
  const linked = join(base, "linked-output");
  const sentinel = join(external, "sentinel.txt");
  await mkdir(external);
  await writeFile(sentinel, "keep\n", "utf8");
  await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");

  await expect(prepareLocalCandidate({
    outputDirectory: linked,
    platform: "win32",
    arch: "x64",
    libc: "none"
  })).rejects.toThrow(/LOCAL_CANDIDATE_OUTPUT_UNSAFE/u);
  await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
});

it.skipIf(process.platform === "win32")(
  "rejects an explicit output directory writable by other local users",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-candidate-permissions-"));
    const output = join(base, "shared-output");
    await mkdir(output);
    await chmod(output, 0o777);

    await expect(prepareLocalCandidate({
      outputDirectory: output,
      platform: "win32",
      arch: "x64",
      libc: "none"
    })).rejects.toThrow(/LOCAL_CANDIDATE_OUTPUT_UNSAFE/u);
  }
);

it.skipIf(process.platform === "win32")(
  "packs, verifies, and installs the exact local CLI and current helper over stale state",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-local-candidate-"));
    const outputDirectory = join(base, "artifacts");
    const prefix = join(base, "prefix");
    const home = join(base, "home");
    const state = join(base, "state");
    const cache = join(base, "npm-cache");
    const libc = runtimeLibc(process.platform, process.report.getReport());
    const target = candidateTarget(process.platform, process.arch, libc);
    expect(target).not.toBeNull();

    const staleDirectory = join(prefix, "lib", "node_modules", ...target.name.split("/"));
    await Promise.all([
      mkdir(staleDirectory, { recursive: true }),
      mkdir(home, { recursive: true })
    ]);
    await writeFile(join(staleDirectory, "package.json"), JSON.stringify({
      name: target.name,
      version: "0.5.0-alpha.4"
    }), "utf8");

    const prepared = await execFileAsync(process.execPath, [
      script,
      "--output", outputDirectory,
      "--install",
      "--prefix", prefix,
      "--json"
    ], {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache },
      maxBuffer: 20 * 1024 * 1024
    });
    const manifest = JSON.parse(prepared.stdout);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: release.version,
      platform: process.platform,
      arch: process.arch,
      libc,
      lifecycleWrites: true,
      installed: true,
      artifacts: [
        { role: "native", packageName: target.name, version: release.version },
        { role: "cli", packageName: "skill-steward", version: release.version }
      ]
    });
    expect(manifest.outputDirectory).toBe(await realpath(outputDirectory));
    expect(manifest.artifacts.every(({ file, path }) =>
      typeof file === "string" && path === undefined
    )).toBe(true);
    const storedManifest = JSON.parse(await readFile(
      join(outputDirectory, "candidate-manifest.json"),
      "utf8"
    ));
    expect(storedManifest.outputDirectory).toBeUndefined();
    expect(JSON.stringify(storedManifest)).not.toContain(base);

    const cliManifest = JSON.parse(await readFile(
      join(prefix, "lib", "node_modules", "skill-steward", "package.json"),
      "utf8"
    ));
    const nativeManifest = JSON.parse(await readFile(
      join(prefix, "lib", "node_modules", ...target.name.split("/"), "package.json"),
      "utf8"
    ));
    expect(cliManifest.version).toBe(release.version);
    expect(nativeManifest.version).toBe(release.version);

    const binary = join(prefix, "bin", "skill-steward");
    await expect(access(binary)).resolves.toBeUndefined();
    const plan = await execFileAsync(binary, [
      "integrate", "plan", "--harness", "codex", "--json"
    ], {
      cwd: base,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    });
    expect(JSON.parse(plan.stdout)).toMatchObject({
      harness: "codex",
      availability: { state: "available", available: true }
    });
  },
  180_000
);
