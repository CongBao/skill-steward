import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { verifyNativeRenamePackageBytes } from "../../../scripts/verify-native-rename-package.mjs";

const roots = [];
const verifier = resolve(process.cwd(), "../..", "scripts/verify-native-rename-package.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture({
  cpu = "arm64",
  libc,
  extra = false,
  alternateRoot = false,
  preinstall = false
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "steward-native-verifier-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  const manifest = JSON.parse(await readFile(
    resolve(process.cwd(), "../rename-noreplace-darwin-arm64/package.json"),
    "utf8"
  ));
  manifest.cpu = [cpu];
  if (libc !== undefined) manifest.libc = [libc];
  if (preinstall) manifest.scripts.preinstall = "node malicious-install.js";
  await Promise.all([
    writeFile(join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(join(packageRoot, "rename_noreplace.node"), "native-bytes"),
    writeFile(join(packageRoot, "README.md"), "# Native helper\n"),
    writeFile(join(packageRoot, "LICENSE"), "MIT License\n")
  ]);
  if (extra) await writeFile(join(packageRoot, "unexpected.txt"), "unexpected\n");
  if (alternateRoot) {
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other/rename_noreplace.node"), "unverified-native-bytes");
  }
  const artifact = join(root, "package.tgz");
  const entries = [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    "package/rename_noreplace.node"
  ];
  if (extra) entries.push("package/unexpected.txt");
  if (alternateRoot) entries.push("other/rename_noreplace.node");
  execFileSync("tar", ["-czf", artifact, "-C", root, ...entries], {
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
  return artifact;
}

function verify(artifact) {
  return spawnSync(process.execPath, [verifier, artifact, "darwin", "arm64", "none"], {
    encoding: "utf8"
  });
}

it("accepts only the exact platform metadata and four-file native tarball", async () => {
  expect(verify(await fixture()).status).toBe(0);

  const extra = verify(await fixture({ extra: true }));
  expect(extra.status).not.toBe(0);
  expect(extra.stderr).toContain("archive members are not the exact four regular files");

  const alternateRoot = verify(await fixture({ alternateRoot: true }));
  expect(alternateRoot.status).not.toBe(0);
  expect(alternateRoot.stderr).toMatch(/outside package|exact four regular files/i);

  const wrongCpu = verify(await fixture({ cpu: "x64" }));
  expect(wrongCpu.status).not.toBe(0);
  expect(wrongCpu.stderr).toContain("metadata or payload is incomplete");

  const unexpectedLibc = verify(await fixture({ libc: "glibc" }));
  expect(unexpectedLibc.status).not.toBe(0);
  expect(unexpectedLibc.stderr).toContain("metadata or payload is incomplete");

  const installScript = verify(await fixture({ preinstall: true }));
  expect(installScript.status).not.toBe(0);
  expect(installScript.stderr).toContain("metadata or payload is incomplete");
});

it("verifies the exact native bytes with a bounded unpacked size", async () => {
  const artifact = await fixture();
  expect(verifyNativeRenamePackageBytes(
    await readFile(artifact),
    "darwin",
    "arm64",
    "none"
  )).toMatchObject({
    name: "@skill-steward/rename-noreplace-darwin-arm64"
  });
  expect(() => verifyNativeRenamePackageBytes(
    gzipSync(Buffer.alloc(2_048)),
    "darwin",
    "arm64",
    "none",
    { maximumUnpackedBytes: 1_024 }
  )).toThrow(/unpacked.*limit/i);
});
