#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const NPM_PUBLISHER_VERSION = "11.17.0";
export const NPM_PUBLISHER_TARBALL_URL = "https://registry.npmjs.org/npm/-/npm-11.17.0.tgz";
export const NPM_PUBLISHER_INTEGRITY = "sha512-PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw==";

export async function verifyPinnedNpmClient(path) {
  const bytes = await readFile(path);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== NPM_PUBLISHER_INTEGRITY) {
    throw new Error(`npm ${NPM_PUBLISHER_VERSION} client integrity differs from the pinned release artifact`);
  }
  return { version: NPM_PUBLISHER_VERSION, integrity, bytes: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    throw new Error("Usage: verify-pinned-npm-client.mjs <npm.tgz>");
  }
  verifyPinnedNpmClient(process.argv[2]).then(({ version }) => {
    process.stdout.write(`Verified npm ${version} publisher client\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "npm client verification failed"}\n`);
    process.exitCode = 1;
  });
}
