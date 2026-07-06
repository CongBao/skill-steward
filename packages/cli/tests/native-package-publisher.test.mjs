import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkReleaseContract } from "../../../scripts/release-contract.mjs";

const roots = [];
const publisher = resolve(process.cwd(), "../..", "scripts/publish-native-rename-packages.mjs");
const release = checkReleaseContract(resolve(process.cwd(), "../.."));
const targets = [
  ["darwin-arm64", "darwin", "arm64", undefined],
  ["darwin-x64", "darwin", "x64", undefined],
  ["linux-arm64-gnu", "linux", "arm64", "glibc"],
  ["linux-arm64-musl", "linux", "arm64", "musl"],
  ["linux-x64-gnu", "linux", "x64", "glibc"],
  ["linux-x64-musl", "linux", "x64", "musl"]
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packageSet(root, { firstVersion } = {}) {
  const artifacts = [];
  const integrities = {};
  for (const [suffix, platform, arch, libc] of targets) {
    const parent = join(root, suffix);
    const packageRoot = join(parent, "package");
    await mkdir(packageRoot, { recursive: true });
    const name = `@skill-steward/rename-noreplace-${suffix}`;
    const manifest = JSON.parse(await readFile(
      resolve(process.cwd(), `../rename-noreplace-${suffix}/package.json`),
      "utf8"
    ));
    if (firstVersion && artifacts.length === 0) manifest.version = firstVersion;
    await Promise.all([
      writeFile(join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`),
      writeFile(join(packageRoot, "rename_noreplace.node"), `native-${suffix}`),
      writeFile(join(packageRoot, "README.md"), `# ${suffix}\n`),
      writeFile(join(packageRoot, "LICENSE"), "MIT License\n")
    ]);
    const artifact = join(root, `${suffix}.tgz`);
    execFileSync("tar", [
      "-czf",
      artifact,
      "-C",
      parent,
      "package/LICENSE",
      "package/README.md",
      "package/package.json",
      "package/rename_noreplace.node"
    ]);
    artifacts.push(artifact);
    integrities[`${name}@${release.version}`] = `sha512-${createHash("sha512")
      .update(await readFile(artifact))
      .digest("base64")}`;
  }
  return { artifacts, integrities };
}

async function fakeNpm(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "npm");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
  const published = JSON.parse(process.env.PUBLISHED_INTEGRITIES || "{}");
  if (Object.hasOwn(published, args[1])) {
    process.stdout.write(JSON.stringify(published[args[1]]) + "\\n");
    process.exit(0);
  }
  process.stderr.write("npm ERR! code E404\\n");
  process.exit(1);
}
if (args[0] === "publish") process.exit(0);
process.exit(2);
`);
  await chmod(executable, 0o755);
  return bin;
}

async function runPublisher(root, artifacts, published, { checkOnly = false } = {}) {
  const bin = await fakeNpm(root);
  const log = join(root, "npm-calls.jsonl");
  const result = spawnSync(process.execPath, [publisher, ...(checkOnly ? ["--check-only"] : []), ...artifacts], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      NPM_CALL_LOG: log,
      PUBLISHED_INTEGRITIES: JSON.stringify(published)
    }
  });
  const calls = await readFile(log, "utf8")
    .then((value) => value.trim().split("\n").filter(Boolean).map(JSON.parse))
    .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  return { result, calls };
}

it("preflights all six registry integrities and resumes only byte-identical publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-native-publisher-"));
  roots.push(root);
  const { artifacts, integrities } = await packageSet(root);

  const checked = await runPublisher(join(root, "checked"), artifacts, {}, { checkOnly: true });
  expect(checked.result.status).toBe(0);
  expect(checked.result.stdout).toContain("Verified 6 native package tarballs");
  expect(checked.calls).toEqual([]);

  const fresh = await runPublisher(join(root, "fresh"), artifacts, {});
  expect(fresh.result.status).toBe(0);
  expect(fresh.calls.filter(([command]) => command === "view")).toHaveLength(6);
  const freshPublishes = fresh.calls.filter(([command]) => command === "publish");
  expect(freshPublishes).toHaveLength(6);
  for (const call of freshPublishes) {
    expect(call).toContain("--tag");
    expect(call).toContain(release.npmTag);
    expect(call).toContain("--registry=https://registry.npmjs.org");
  }
  for (const call of fresh.calls.filter(([command]) => command === "view")) {
    expect(call).toContain("--registry=https://registry.npmjs.org");
  }

  const resumed = await runPublisher(join(root, "resumed"), artifacts, integrities);
  expect(resumed.result.status).toBe(0);
  expect(resumed.calls.filter(([command]) => command === "publish")).toHaveLength(0);

  const mismatched = { ...integrities };
  const last = Object.keys(mismatched).sort().at(-1);
  mismatched[last] = "sha512-different";
  const refused = await runPublisher(join(root, "refused"), artifacts, mismatched);
  expect(refused.result.status).not.toBe(0);
  expect(refused.result.stderr).toContain("exists with different bytes");
  expect(refused.calls.filter(([command]) => command === "view")).toHaveLength(6);
  expect(refused.calls.filter(([command]) => command === "publish")).toHaveLength(0);

  const driftRoot = join(root, "drift-artifacts");
  await mkdir(driftRoot, { recursive: true });
  const drifted = await packageSet(driftRoot, { firstVersion: "0.5.0-alpha.3" });
  const contractRefused = await runPublisher(join(root, "contract-refused"), drifted.artifacts, {});
  expect(contractRefused.result.status).not.toBe(0);
  expect(contractRefused.calls).toEqual([]);
});
