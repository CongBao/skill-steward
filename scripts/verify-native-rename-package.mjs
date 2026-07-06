import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkReleaseContract } from "./release-contract.mjs";
import { parseTarEntries } from "./verify-cli-package.mjs";

const exactFiles = ["LICENSE", "README.md", "package.json", "rename_noreplace.node"];
const exactArchiveFiles = exactFiles.map((file) => `package/${file}`);

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

export function verifyNativeRenamePackageBytes(bytes, platform, arch, libc, options = {}) {
  if (!Buffer.isBuffer(bytes) || !platform || !arch || !libc) {
    throw new Error("Native package bytes, platform, architecture, and libc are required");
  }
  const expectedName = `@skill-steward/rename-noreplace-${platform}-${arch}${
    platform === "linux" ? `-${libc}` : ""
  }`;
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const release = checkReleaseContract(repositoryRoot);
  const expectedManifest = JSON.parse(readFileSync(join(
    repositoryRoot,
    "packages",
    expectedName.slice("@skill-steward/".length),
    "package.json"
  ), "utf8"));
  const expectedLibc = platform === "linux" ? [libc === "gnu" ? "glibc" : libc] : undefined;
  const files = parseTarEntries(bytes, options.maximumUnpackedBytes);
  if (!exactArray([...files.keys()].sort(), exactArchiveFiles)) {
    throw new Error("Native package archive members are not the exact four regular files");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get("package/package.json")));
  } catch {
    throw new Error("Native package metadata or payload is incomplete");
  }
  const metadataValid = isDeepStrictEqual(manifest, expectedManifest)
    && manifest.name === expectedName
    && manifest.version === release.version
    && manifest.type === "commonjs"
    && manifest.main === "rename_noreplace.node"
    && exactArray(manifest.os, [platform])
    && exactArray(manifest.cpu, [arch])
    && (expectedLibc === undefined ? manifest.libc === undefined : exactArray(manifest.libc, expectedLibc))
    && exactArray(manifest.files, ["rename_noreplace.node", "README.md", "LICENSE"])
    && manifest.publishConfig?.access === "public"
    && manifest.engines?.node === ">=22";
  if (
    !metadataValid
    || !files.get("package/rename_noreplace.node")?.length
    || !files.get("package/README.md")?.toString("utf8").trim()
    || !files.get("package/LICENSE")?.toString("utf8").includes("MIT License")
  ) {
    throw new Error("Native package metadata or payload is incomplete");
  }
  return manifest;
}

export function verifyNativeRenamePackage(artifact, platform, arch, libc) {
  if (!artifact || !platform || !arch || !libc || !artifact.endsWith(".tgz")) {
    throw new Error("Usage: verify-native-rename-package.mjs <artifact.tgz> <platform> <arch> <libc>");
  }
  try {
    return verifyNativeRenamePackageBytes(readFileSync(artifact), platform, arch, libc);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native package ")) {
      error.message = error.message.replace("Native package ", `Native package ${basename(artifact)} `);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyNativeRenamePackage(...process.argv.slice(2));
}
