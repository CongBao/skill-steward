import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeRenamePackage } from "./verify-native-rename-package.mjs";
import { checkReleaseContract } from "./release-contract.mjs";

const targets = new Map([
  ["@skill-steward/rename-noreplace-darwin-arm64", ["darwin", "arm64", "none"]],
  ["@skill-steward/rename-noreplace-darwin-x64", ["darwin", "x64", "none"]],
  ["@skill-steward/rename-noreplace-linux-arm64-gnu", ["linux", "arm64", "gnu"]],
  ["@skill-steward/rename-noreplace-linux-arm64-musl", ["linux", "arm64", "musl"]],
  ["@skill-steward/rename-noreplace-linux-x64-gnu", ["linux", "x64", "gnu"]],
  ["@skill-steward/rename-noreplace-linux-x64-musl", ["linux", "x64", "musl"]]
]);
const registry = "https://registry.npmjs.org";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = checkReleaseContract(repositoryRoot);

function readManifest(artifact) {
  return JSON.parse(execFileSync(
    "tar",
    ["-xOf", artifact, "package/package.json"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  ));
}

function integrity(artifact) {
  return `sha512-${createHash("sha512").update(readFileSync(artifact)).digest("base64")}`;
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

const checkOnly = process.argv[2] === "--check-only";
const artifacts = process.argv.slice(checkOnly ? 3 : 2);
if (artifacts.length !== targets.size || artifacts.some((artifact) => !artifact.endsWith(".tgz"))) {
  throw new Error("Expected exactly six native package tarballs");
}

const verified = artifacts.map((artifact) => {
  const candidate = readManifest(artifact);
  const target = targets.get(candidate.name);
  if (!target) throw new Error(`Unexpected native package ${candidate.name ?? basename(artifact)}`);
  const manifest = verifyNativeRenamePackage(artifact, ...target);
  if (manifest.version !== release.version) {
    throw new Error(`Native package ${manifest.name} version differs from the release contract`);
  }
  return { artifact, manifest, integrity: integrity(artifact) };
});
if (new Set(verified.map(({ manifest }) => manifest.name)).size !== targets.size) {
  throw new Error("Native package set contains a duplicate or is incomplete");
}

verified.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
if (checkOnly) {
  process.stdout.write(`Verified ${verified.length} native package tarballs\n`);
  process.exit(0);
}

const publicationPlan = verified.map((item) => {
  const spec = `${item.manifest.name}@${item.manifest.version}`;
  const viewed = runNpm(["view", spec, "dist.integrity", "--json", `--registry=${registry}`]);
  if (viewed.status === 0) {
    const publishedIntegrity = JSON.parse(viewed.stdout.trim());
    if (publishedIntegrity !== item.integrity) {
      throw new Error(`Published ${spec} exists with different bytes; refusing to continue`);
    }
    process.stdout.write(`Already published and byte-identical: ${spec}\n`);
    return { ...item, spec, publish: false };
  }
  const viewFailure = `${viewed.stdout ?? ""}\n${viewed.stderr ?? ""}`;
  if (!/\bE404\b/u.test(viewFailure)) {
    throw new Error(`Could not verify whether ${spec} exists: ${viewFailure.trim()}`);
  }
  return { ...item, spec, publish: true };
});

for (const item of publicationPlan) {
  if (!item.publish) continue;
  const published = runNpm(
    [
      "publish",
      item.artifact,
      "--access",
      "public",
      "--tag",
      release.npmTag,
      "--provenance",
      `--registry=${registry}`
    ],
    { stdio: "inherit" }
  );
  if (published.status !== 0) {
    throw new Error(`Publishing ${item.spec} failed with exit ${published.status ?? "unknown"}`);
  }
}
