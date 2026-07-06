import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { checkReleaseContract } from "../../../scripts/release-contract.mjs";

const execFileAsync = promisify(execFile);
const roots = [];
const repositoryRoot = resolve(process.cwd(), "../..");
const publisher = join(repositoryRoot, "scripts", "publish-cli-package.mjs");
const release = checkReleaseContract(repositoryRoot);
const cliPackage = join(repositoryRoot, "packages", "cli");
const registry = "https://registry.npmjs.org";
const nativeSpecs = release.packages
  .filter(({ role }) => role === "native")
  .map(({ name }) => `${name}@${release.version}`);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packCli(root) {
  const directory = join(root, "artifacts");
  const cache = join(root, "npm-cache");
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(cache, { recursive: true })
  ]);
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    {
      cwd: cliPackage,
      env: { ...process.env, npm_config_cache: cache },
      maxBuffer: 10 * 1024 * 1024
    }
  );
  const [{ filename }] = JSON.parse(stdout);
  return join(directory, filename);
}

async function packCliWithPnpm(root) {
  const directory = join(root, "pnpm-artifacts");
  await mkdir(directory, { recursive: true });
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "skill-steward",
      "pack",
      "--config.ignore-scripts=true",
      "--pack-destination",
      directory
    ],
    { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 }
  );
  const artifacts = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  expect(artifacts).toHaveLength(1);
  return join(directory, artifacts[0]);
}

async function copyWorkspaceManifests(destination) {
  for (const group of ["packages", "apps"]) {
    const sourceGroup = join(repositoryRoot, group);
    const destinationGroup = join(destination, group);
    await mkdir(destinationGroup, { recursive: true });
    for (const entry of await readdir(sourceGroup, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = join(destinationGroup, entry.name);
      await mkdir(target, { recursive: true });
      await cp(join(sourceGroup, entry.name, "package.json"), join(target, "package.json"));
    }
  }
}

async function fakeNpm(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "npm");
  await writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALL_LOG, JSON.stringify(args) + "\\n");
const published = JSON.parse(process.env.PUBLISHED_INTEGRITIES || "{}");
if (args[0] === "view") {
  if (args[1] === process.env.FAILURE_SPEC) {
    process.stderr.write("npm ERR! code E500\\n");
    process.exit(1);
  }
  if (Object.prototype.hasOwnProperty.call(published, args[1])) {
    process.stdout.write(JSON.stringify(published[args[1]]) + "\\n");
    process.exit(0);
  }
  process.stderr.write("npm ERR! code E404\\n");
  process.exit(1);
}
if (args[0] === "publish") process.exit(0);
process.exit(2);
`, "utf8");
  await chmod(script, 0o755);
  return script;
}

async function runPublisher(root, args, published = {}, failureSpec) {
  const npmCli = await fakeNpm(root);
  const log = join(root, "npm-calls.jsonl");
  const result = spawnSync(process.execPath, [publisher, "--npm-cli", npmCli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "",
      NPM_CALL_LOG: log,
      PUBLISHED_INTEGRITIES: JSON.stringify(published),
      FAILURE_SPEC: failureSpec ?? ""
    }
  });
  const calls = await readFile(log, "utf8")
    .then((value) => value.trim().split("\n").filter(Boolean).map(JSON.parse))
    .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  return { result, calls };
}

function readyNatives() {
  return Object.fromEntries(nativeSpecs.map((spec, index) => [
    spec,
    `sha512-${Buffer.from(`native-${index}`).toString("base64")}`
  ]));
}

it("publishes only one contract-bound CLI after complete native and byte-identity preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-cli-publisher-"));
  roots.push(root);
  const artifact = await packCli(root);
  const cliSpec = `skill-steward@${release.version}`;
  const localIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(artifact))
    .digest("base64")}`;

  const checked = await runPublisher(join(root, "checked"), ["--check-only", artifact]);
  expect(checked.result.status).toBe(0);
  expect(checked.result.stdout).toContain(`Verified ${cliSpec}`);
  expect(checked.calls).toEqual([]);

  const trustedPackageDirectory = join(root, "trusted-package-tree");
  await mkdir(trustedPackageDirectory, { recursive: true });
  await Promise.all([
    cp(join(cliPackage, "LICENSE"), join(trustedPackageDirectory, "LICENSE")),
    cp(join(cliPackage, "README.md"), join(trustedPackageDirectory, "README.md")),
    cp(join(cliPackage, "package.json"), join(trustedPackageDirectory, "package.json")),
    cp(join(cliPackage, "dist"), join(trustedPackageDirectory, "dist"), { recursive: true })
  ]);
  const copiedWorkspaceRoot = join(root, "copied-workspace");
  await copyWorkspaceManifests(copiedWorkspaceRoot);
  await mkdir(join(copiedWorkspaceRoot, "packages", "not-a-package"));
  const pnpmArtifact = await packCliWithPnpm(root);
  const artifactBound = await runPublisher(join(root, "artifact-bound"), [
    "--check-only",
    "--trusted-package-directory",
    trustedPackageDirectory,
    "--workspace-root",
    copiedWorkspaceRoot,
    pnpmArtifact
  ]);
  expect(artifactBound.result.status, artifactBound.result.stderr).toBe(0);
  expect(artifactBound.calls).toEqual([]);

  if (process.platform !== "win32") {
    const symlinkWorkspaceRoot = join(root, "symlink-workspace");
    await copyWorkspaceManifests(symlinkWorkspaceRoot);
    const forgedPackage = join(symlinkWorkspaceRoot, "packages", "forged-package");
    await mkdir(forgedPackage);
    await symlink(join(repositoryRoot, "package.json"), join(forgedPackage, "package.json"));
    const symlinkRejected = await runPublisher(join(root, "symlink-rejected"), [
      "--check-only",
      "--trusted-package-directory",
      trustedPackageDirectory,
      "--workspace-root",
      symlinkWorkspaceRoot,
      pnpmArtifact
    ]);
    expect(symlinkRejected.result.status).not.toBe(0);
    expect(symlinkRejected.result.stderr).toContain("must be a regular file");

    const directorySymlinkWorkspaceRoot = join(root, "directory-symlink-workspace");
    await copyWorkspaceManifests(directorySymlinkWorkspaceRoot);
    await symlink(
      join(repositoryRoot, "packages", "engine"),
      join(directorySymlinkWorkspaceRoot, "packages", "forged-directory"),
      "dir"
    );
    const directorySymlinkRejected = await runPublisher(join(root, "directory-symlink-rejected"), [
      "--check-only",
      "--trusted-package-directory",
      trustedPackageDirectory,
      "--workspace-root",
      directorySymlinkWorkspaceRoot,
      pnpmArtifact
    ]);
    expect(directorySymlinkRejected.result.status).not.toBe(0);
    expect(directorySymlinkRejected.result.stderr).toContain("workspace entry must not be a symbolic link");
  }

  for (const invalidArgs of [[], [artifact, artifact]]) {
    const invalid = await runPublisher(join(root, `invalid-${invalidArgs.length}`), invalidArgs);
    expect(invalid.result.status).not.toBe(0);
    expect(invalid.calls).toEqual([]);
  }

  const missing = await runPublisher(join(root, "native-missing"), [artifact], {
    ...readyNatives(),
    [nativeSpecs.at(-1)]: undefined
  });
  expect(missing.result.status).not.toBe(0);
  expect(missing.calls.some(([command, spec]) => command === "view" && spec === cliSpec)).toBe(false);
  expect(missing.calls.some(([command]) => command === "publish")).toBe(false);

  const malformed = await runPublisher(join(root, "native-malformed"), [artifact], {
    ...readyNatives(),
    [nativeSpecs[0]]: "sha1-not-accepted"
  });
  expect(malformed.result.status).not.toBe(0);
  expect(malformed.calls.some(([command]) => command === "publish")).toBe(false);

  const unavailable = await runPublisher(
    join(root, "native-unavailable"),
    [artifact],
    readyNatives(),
    nativeSpecs[1]
  );
  expect(unavailable.result.status).not.toBe(0);
  expect(unavailable.result.stderr).toContain("Could not verify");
  expect(unavailable.calls.some(([command]) => command === "publish")).toBe(false);

  const fresh = await runPublisher(join(root, "fresh"), [artifact], readyNatives());
  expect(fresh.result.status).toBe(0);
  expect(fresh.calls.filter(([command]) => command === "view")).toHaveLength(7);
  const publishes = fresh.calls.filter(([command]) => command === "publish");
  expect(publishes).toHaveLength(1);
  expect(publishes[0]).toEqual([
    "publish",
    artifact,
    "--access",
    "public",
    "--tag",
    release.npmTag,
    "--provenance",
    `--registry=${registry}`
  ]);

  const resumed = await runPublisher(join(root, "resumed"), [artifact], {
    ...readyNatives(),
    [cliSpec]: localIntegrity
  });
  expect(resumed.result.status).toBe(0);
  expect(resumed.result.stdout).toContain("Already published and byte-identical");
  expect(resumed.calls.some(([command]) => command === "publish")).toBe(false);

  const conflict = await runPublisher(join(root, "conflict"), [artifact], {
    ...readyNatives(),
    [cliSpec]: `sha512-${Buffer.from("different").toString("base64")}`
  });
  expect(conflict.result.status).not.toBe(0);
  expect(conflict.result.stderr).toContain("different bytes");
  expect(conflict.calls.some(([command]) => command === "publish")).toBe(false);

  const invalidArtifact = join(root, "invalid.tgz");
  await writeFile(invalidArtifact, "not a tarball", "utf8");
  const rejected = await runPublisher(join(root, "invalid-artifact"), [invalidArtifact]);
  expect(rejected.result.status).not.toBe(0);
  expect(rejected.calls).toEqual([]);
}, 30_000);
