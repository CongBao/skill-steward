import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const exactFiles = ["LICENSE", "README.md", "package.json", "rename_noreplace.node"];
const exactArchiveFiles = exactFiles.map((file) => `package/${file}`);

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

export function verifyNativeRenamePackage(artifact, platform, arch, libc) {
  if (!artifact || !platform || !arch || !libc || !artifact.endsWith(".tgz")) {
    throw new Error("Usage: verify-native-rename-package.mjs <artifact.tgz> <platform> <arch> <libc>");
  }
  const expectedName = `@skill-steward/rename-noreplace-${platform}-${arch}${
    platform === "linux" ? `-${libc}` : ""
  }`;
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const expectedManifest = JSON.parse(readFileSync(join(
    repositoryRoot,
    "packages",
    expectedName.slice("@skill-steward/".length),
    "package.json"
  ), "utf8"));
  const expectedLibc = platform === "linux" ? [libc === "gnu" ? "glibc" : libc] : undefined;
  const directory = mkdtempSync(join(tmpdir(), "steward-native-package-"));
  try {
    const archiveEntries = execFileSync("tar", ["-tzf", artifact], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).split("\n").filter(Boolean);
    const archiveDetails = execFileSync("tar", ["-tvzf", artifact], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).split("\n").filter(Boolean);
    if (
      !exactArray([...archiveEntries].sort(), exactArchiveFiles)
      || archiveDetails.length !== exactArchiveFiles.length
      || archiveDetails.some((line) => !line.startsWith("-"))
    ) {
      throw new Error(`Native package ${basename(artifact)} archive members are not the exact four regular files`);
    }
    execFileSync("tar", ["-xzf", artifact, "-C", directory, ...exactArchiveFiles]);
    const root = join(directory, "package");
    const files = readdirSync(root, { withFileTypes: true });
    if (
      files.some((entry) => !entry.isFile())
      || !exactArray(files.map((entry) => entry.name).sort(), exactFiles)
    ) {
      throw new Error(`Native package ${basename(artifact)} must contain exactly ${exactFiles.join(", ")}`);
    }
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const metadataValid = isDeepStrictEqual(manifest, expectedManifest)
      && manifest.name === expectedName
      && manifest.version === "0.5.0-alpha.4"
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
      || !readFileSync(join(root, "rename_noreplace.node")).length
      || !readFileSync(join(root, "README.md"), "utf8").trim()
      || !readFileSync(join(root, "LICENSE"), "utf8").includes("MIT License")
    ) {
      throw new Error(`Native package ${basename(artifact)} metadata or payload is incomplete`);
    }
    return manifest;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyNativeRenamePackage(...process.argv.slice(2));
}
