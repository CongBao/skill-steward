import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const [targetPlatform, targetArch, targetLibc, mode] = process.argv.slice(2);
if (
  !["darwin", "linux"].includes(targetPlatform)
  || !["arm64", "x64"].includes(targetArch)
  || !["none", "gnu", "musl"].includes(targetLibc)
  || (targetPlatform === "darwin") !== (targetLibc === "none")
  || (mode !== undefined && mode !== "--verify-only")
) {
  throw new Error(
    "Usage: build-native-rename-noreplace.mjs <darwin|linux> <arm64|x64> <none|gnu|musl> [--verify-only]"
  );
}

const runtimeLibc = process.platform === "linux"
  ? process.report.getReport().header.glibcVersionRuntime === undefined ? "musl" : "gnu"
  : "none";
const matches = process.platform === targetPlatform
  && process.arch === targetArch
  && runtimeLibc === targetLibc;
if (!matches) process.exit(0);

const packageDirectory = process.cwd();
const workspaceDirectory = resolve(packageDirectory, "../..");
const output = join(packageDirectory, "rename_noreplace.node");
const token = `skill-steward.owned-tree-native.v2:${targetPlatform}:${targetArch}:${targetLibc}`;
if (mode !== "--verify-only") {
  const nodeRoot = dirname(dirname(process.execPath));
  const includeDirectory = join(nodeRoot, "include", "node");
  const source = join(workspaceDirectory, "native", "rename-noreplace", "rename_noreplace.c");
  if (!existsSync(join(includeDirectory, "node_api.h"))) {
    throw new Error(`Node-API headers are unavailable at ${includeDirectory}`);
  }
  const common = [
    "-std=c11",
    "-O2",
    "-fvisibility=hidden",
    `-DSS_TARGET_TOKEN=\"${token}\"`,
    `-I${includeDirectory}`,
    source,
    "-o",
    output
  ];
  const platformFlags = process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : ["-shared", "-fPIC"];
  execFileSync(process.env.CC ?? "cc", [...common, ...platformFlags], { stdio: "inherit" });
  copyFileSync(join(workspaceDirectory, "LICENSE"), join(packageDirectory, "LICENSE"));
}
if (!existsSync(output)) throw new Error(`Native helper was not built at ${output}`);

const binding = createRequire(import.meta.url)(output);
if (
  binding === null
  || typeof binding !== "object"
  || binding.metadata?.() !== token
  || typeof binding.renameNoReplace !== "function"
  || typeof binding.removeAt !== "function"
) {
  throw new Error("Native helper metadata or exports do not match the package target");
}
const fixture = mkdtempSync(join(tmpdir(), "steward-native-rename-"));
try {
  const source = join(fixture, "source");
  const destination = join(fixture, "destination");
  mkdirSync(source);
  const parentFd = openSync(fixture, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    if (binding.renameNoReplace(parentFd, "source", "destination") !== 0 || existsSync(source) || !existsSync(destination)) {
      throw new Error("Native helper could not publish an absent destination");
    }
    const collisionSource = join(fixture, "collision-source");
    mkdirSync(collisionSource);
    const collision = binding.renameNoReplace(parentFd, "collision-source", "destination");
    if (!Number.isInteger(collision) || collision === 0 || !existsSync(collisionSource)) {
      throw new Error("Native helper did not preserve a no-replace collision");
    }
    const removableFile = join(fixture, "removable-file");
    const removableDirectory = join(fixture, "removable-directory");
    writeFileSync(removableFile, "remove\n");
    mkdirSync(removableDirectory);
    if (
      binding.removeAt(parentFd, "removable-file", false) !== 0
      || binding.removeAt(parentFd, "removable-directory", true) !== 0
      || existsSync(removableFile)
      || existsSync(removableDirectory)
    ) {
      throw new Error("Native helper could not remove exact fd-relative children");
    }
    if (binding.removeAt(parentFd, "../destination", false) === 0 || !existsSync(destination)) {
      throw new Error("Native helper accepted a non-basename removal target");
    }
  } finally {
    closeSync(parentFd);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
