#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReleaseContract } from "./release-contract.mjs";
import { parseTarEntries, verifyPackedArtifact } from "./verify-cli-package.mjs";

const registry = "https://registry.npmjs.org";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

function registryFailure(result) {
  return boundedDiagnostic(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
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

function queriedIntegrity(spec) {
  const result = runNpm(["view", spec, "dist.integrity", "--json", `--registry=${registry}`]);
  if (result.status !== 0) {
    const failure = registryFailure(result);
    if (/\bE404\b/u.test(failure)) return null;
    throw new Error(`Could not verify ${spec}: ${failure}`);
  }
  let value;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Registry returned malformed integrity for ${spec}`);
  }
  if (typeof value !== "string" || !integrityPattern.test(value)) {
    throw new Error(`Registry returned malformed integrity for ${spec}`);
  }
  return value;
}

async function artifactIdentity(artifact) {
  const bytes = await readFile(artifact);
  const files = parseTarEntries(bytes);
  const manifestBytes = files.get("package/package.json");
  if (!manifestBytes) throw new Error("CLI artifact is missing package/package.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("CLI artifact package.json is invalid");
  }
  return {
    manifest,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  };
}

export async function publishCliPackage(args = process.argv.slice(2)) {
  const checkOnly = args[0] === "--check-only";
  const artifacts = args.slice(checkOnly ? 1 : 0);
  if (artifacts.length !== 1 || !artifacts[0].endsWith(".tgz")) {
    throw new Error("Expected exactly one CLI package tarball");
  }

  const release = checkReleaseContract(repositoryRoot);
  const artifact = artifacts[0];
  await verifyPackedArtifact(artifact);
  const { manifest, integrity } = await artifactIdentity(artifact);
  if (manifest.name !== "skill-steward" || manifest.version !== release.version) {
    throw new Error("CLI artifact identity differs from the release contract");
  }
  const spec = `${manifest.name}@${manifest.version}`;

  if (checkOnly) {
    process.stdout.write(`Verified ${spec} without registry access\n`);
    return { spec, published: false, checkedOnly: true };
  }

  for (const { name } of release.packages.filter(({ role }) => role === "native")) {
    const nativeSpec = `${name}@${release.version}`;
    if (queriedIntegrity(nativeSpec) === null) {
      throw new Error(`Required native package is not published: ${nativeSpec}`);
    }
  }

  const publishedIntegrity = queriedIntegrity(spec);
  if (publishedIntegrity !== null) {
    if (publishedIntegrity !== integrity) {
      throw new Error(`Published ${spec} exists with different bytes; refusing to continue`);
    }
    process.stdout.write(`Already published and byte-identical: ${spec}\n`);
    return { spec, published: false, checkedOnly: false };
  }

  const result = runNpm([
    "publish",
    artifact,
    "--access",
    "public",
    "--tag",
    release.npmTag,
    "--provenance",
    `--registry=${registry}`
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Publishing ${spec} failed with exit ${result.status ?? "unknown"}`);
  }
  return { spec, published: true, checkedOnly: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishCliPackage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "CLI publication failed"}\n`);
    process.exitCode = 1;
  });
}
