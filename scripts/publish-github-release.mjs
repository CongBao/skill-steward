#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_REPOSITORY,
  boundedDiagnostic,
  validateSourceCommit
} from "./release-assets.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const API_VERSION = "2022-11-28";
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_PAGES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const APPROVED_ASSET_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);
const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function extractReleaseNotes(repositoryRoot, version) {
  const source = await readFile(join(repositoryRoot, "CHANGELOG.md"), "utf8");
  const header = new RegExp(`^## \\[${escapeRegex(version)}\\](?: - [^\\n]+)?\\n`, "mu").exec(source);
  const remainder = header ? source.slice(header.index + header[0].length) : "";
  const next = remainder.search(/^## \[/mu);
  const notes = (next < 0 ? remainder : remainder.slice(0, next)).trim();
  if (!notes || /\b(?:TBD|TODO|PLACEHOLDER)\b/iu.test(notes)) {
    throw new Error(`RELEASE_NOTES_INVALID: CHANGELOG has no complete ${version} section`);
  }
  return `${notes}\n`;
}

async function boundedBody(response, maximum = MAX_API_BYTES) {
  const declared = response.headers?.get?.("content-length");
  if (declared && (!/^(0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new Error("GITHUB_RESPONSE_TOO_LARGE: response exceeds the byte limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("GITHUB_RESPONSE_TOO_LARGE: response exceeds the byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function boundedDownloadBody(response, maximum, filename) {
  try {
    return await boundedBody(response, maximum);
  } catch (error) {
    throw new Error(
      `GITHUB_ASSET_DOWNLOAD_FAILED: ${boundedDiagnostic(filename, 256)}: ${boundedDiagnostic(
        error instanceof Error ? error.message : error,
        1_024
      )}`
    );
  }
}

function apiHeaders(token, extra = {}) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "skill-steward-release-publisher",
    ...extra
  };
}

async function githubJson(fetchImpl, token, url, options = {}, accepted = [200]) {
  const parsed = new URL(url);
  if (parsed.origin !== API && parsed.origin !== UPLOADS) {
    throw new Error("GITHUB_URL_INVALID: request is outside fixed GitHub API hosts");
  }
  let response;
  try {
    response = await fetchImpl(parsed, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: apiHeaders(token, options.headers)
    });
  } catch (error) {
    throw new Error(`GITHUB_REQUEST_FAILED: ${boundedDiagnostic(error instanceof Error ? error.message : error)}`);
  }
  let bytes;
  try {
    bytes = await boundedBody(response);
  } catch (error) {
    throw new Error(`GITHUB_RESPONSE_FAILED: ${boundedDiagnostic(error instanceof Error ? error.message : error, 1_024)}`);
  }
  let value = null;
  if (bytes.length > 0) {
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("GITHUB_RESPONSE_INVALID: response is not valid UTF-8 JSON");
    }
  }
  if (!accepted.includes(response.status)) {
    throw new Error(`GITHUB_HTTP_${response.status}: ${boundedDiagnostic(value?.message ?? "request failed")}`);
  }
  return { status: response.status, value };
}

async function listTagReleases(fetchImpl, token, tag) {
  const matches = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const { value } = await githubJson(
      fetchImpl,
      token,
      `${API}/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`
    );
    if (!Array.isArray(value)) throw new Error("GITHUB_RELEASE_LIST_INVALID: releases response is not an array");
    matches.push(...value.filter((item) => item?.tag_name === tag));
    if (value.length < 100) break;
    if (page === MAX_RELEASE_PAGES) {
      throw new Error("GITHUB_RELEASE_LIST_BOUNDED: release listing exceeds the supported bound");
    }
  }
  if (matches.length > 1) throw new Error(`GITHUB_RELEASE_DUPLICATE: multiple releases use ${tag}`);
  return matches[0] ?? null;
}

async function resolveTagCommit(fetchImpl, token, tag) {
  const reference = await githubJson(
    fetchImpl,
    token,
    `${API}/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    {},
    [200, 404]
  );
  if (reference.status === 404) return null;
  let object = reference.value?.object;
  for (let depth = 0; depth < 4; depth += 1) {
    if (object?.type === "commit") return validateSourceCommit(object.sha);
    if (object?.type !== "tag" || typeof object.sha !== "string" || !/^[0-9a-f]{40}$/u.test(object.sha)) {
      throw new Error("GITHUB_TAG_INVALID: tag reference target is malformed");
    }
    const { value } = await githubJson(
      fetchImpl,
      token,
      `${API}/repos/${RELEASE_REPOSITORY}/git/tags/${object.sha}`
    );
    object = value?.object;
  }
  throw new Error("GITHUB_TAG_INVALID: annotated tag chain exceeds the supported bound");
}

async function currentMainCommit(fetchImpl, token) {
  const { value } = await githubJson(
    fetchImpl,
    token,
    `${API}/repos/${RELEASE_REPOSITORY}/git/ref/heads/main`
  );
  if (value?.object?.type !== "commit") {
    throw new Error("GITHUB_MAIN_INVALID: current main reference is malformed");
  }
  return validateSourceCommit(value.object.sha);
}

function validateReleaseMetadata(remote, expected, allowDraft) {
  if (
    remote === null
    || !Number.isSafeInteger(remote.id)
    || remote.id < 1
    || remote.tag_name !== expected.tag
    || remote.target_commitish !== expected.sourceCommit
    || remote.name !== expected.name
    || remote.body !== expected.body
    || remote.prerelease !== expected.prerelease
    || typeof remote.draft !== "boolean"
    || (!allowDraft && remote.draft)
    || !Array.isArray(remote.assets)
  ) {
    throw new Error("GITHUB_RELEASE_CONFLICT: existing release metadata differs from the verified release");
  }
  return remote;
}

async function digestlessAssetSha256(fetchImpl, token, remoteAsset, expected) {
  if (
    !Number.isSafeInteger(remoteAsset.id)
    || remoteAsset.id < 1
    || typeof remoteAsset.url !== "string"
  ) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} has no usable digest or download identity`);
  }
  const apiUrl = new URL(remoteAsset.url);
  if (
    apiUrl.origin !== API
    || apiUrl.pathname !== `/repos/${RELEASE_REPOSITORY}/releases/assets/${remoteAsset.id}`
    || apiUrl.search !== ""
    || apiUrl.hash !== ""
  ) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} download URL is outside the fixed repository`);
  }
  let first;
  try {
    first = await fetchImpl(apiUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: apiHeaders(token, { accept: "application/octet-stream" })
    });
  } catch (error) {
    throw new Error(`GITHUB_ASSET_DOWNLOAD_FAILED: ${boundedDiagnostic(error instanceof Error ? error.message : error, 1_024)}`);
  }
  await boundedDownloadBody(first, 64 * 1024, expected.filename);
  if (first.status !== 302) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} download did not return one approved redirect`);
  }
  const location = first.headers.get("location");
  let cdn;
  try {
    cdn = new URL(location);
  } catch {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} download redirect is malformed`);
  }
  if (
    cdn.protocol !== "https:"
    || !APPROVED_ASSET_HOSTS.has(cdn.hostname)
    || cdn.port !== ""
    || cdn.username !== ""
    || cdn.password !== ""
    || cdn.hash !== ""
  ) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} download redirect host is not approved`);
  }
  let second;
  try {
    second = await fetchImpl(cdn, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/octet-stream",
        "user-agent": "skill-steward-release-publisher"
      }
    });
  } catch (error) {
    throw new Error(`GITHUB_ASSET_DOWNLOAD_FAILED: ${boundedDiagnostic(error instanceof Error ? error.message : error, 1_024)}`);
  }
  if (second.status !== 200 || second.redirected) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} CDN download did not return HTTP 200`);
  }
  const bytes = await boundedDownloadBody(second, expected.size, expected.filename);
  if (bytes.length !== expected.size) {
    throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} CDN bytes have the wrong size`);
  }
  return createSha256(bytes);
}

function createSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateRemoteAssets(fetchImpl, token, remote, expectedAssets) {
  const byName = new Map();
  for (const asset of remote.assets) {
    if (typeof asset?.name !== "string" || byName.has(asset.name)) {
      throw new Error("GITHUB_ASSET_CONFLICT: remote asset inventory is malformed or duplicated");
    }
    byName.set(asset.name, asset);
  }
  const expectedNames = new Set(expectedAssets.map(({ filename }) => filename));
  for (const name of byName.keys()) {
    if (!expectedNames.has(name)) throw new Error(`GITHUB_ASSET_CONFLICT: unexpected remote asset ${boundedDiagnostic(name)}`);
  }
  for (const expected of expectedAssets) {
    const remoteAsset = byName.get(expected.filename);
    if (!remoteAsset) continue;
    let remoteSha256;
    if (typeof remoteAsset.digest === "string") {
      remoteSha256 = /^sha256:[0-9a-f]{64}$/u.test(remoteAsset.digest)
        ? remoteAsset.digest.slice("sha256:".length)
        : null;
    } else {
      remoteSha256 = await digestlessAssetSha256(fetchImpl, token, remoteAsset, expected);
    }
    if (remoteAsset.size !== expected.size || remoteSha256 !== expected.sha256) {
      throw new Error(`GITHUB_ASSET_CONFLICT: ${expected.filename} differs from verified bytes`);
    }
  }
  return byName;
}

function uploadUrl(remote, filename) {
  if (typeof remote.upload_url !== "string") {
    throw new Error("GITHUB_UPLOAD_URL_INVALID: release upload URL is missing");
  }
  const base = new URL(remote.upload_url.replace(/\{[^}]*\}$/u, ""));
  if (
    base.origin !== UPLOADS
    || base.pathname !== `/repos/${RELEASE_REPOSITORY}/releases/${remote.id}/assets`
    || base.search !== ""
    || base.hash !== ""
    || base.username !== ""
    || base.password !== ""
  ) {
    throw new Error("GITHUB_UPLOAD_URL_INVALID: release upload URL is outside the fixed repository");
  }
  base.searchParams.set("name", filename);
  return base.href;
}

async function publishGitHubReleaseInternal({
  repositoryRoot = defaultRepositoryRoot,
  directory,
  expectedSourceCommit,
  repository,
  token,
  fetchImpl = globalThis.fetch
}, verifyPackages) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`GITHUB_REPOSITORY_MISMATCH: expected ${RELEASE_REPOSITORY}`);
  }
  if (typeof token !== "string" || token.length < 1 || token.length > 4_096) {
    throw new Error("GITHUB_TOKEN_INVALID: one bounded workflow token is required");
  }
  if (typeof fetchImpl !== "function") throw new Error("GITHUB_FETCH_INVALID: fetch implementation is required");
  const verified = await verifyReleaseAssets({
    repositoryRoot,
    directory,
    expectedSourceCommit,
    verifyPackages
  });
  const sourceCommit = verified.manifest.sourceCommit;
  const version = verified.manifest.version;
  const expected = Object.freeze({
    tag: `v${version}`,
    sourceCommit,
    name: `Skill Steward v${version}`,
    body: await extractReleaseNotes(repositoryRoot, version),
    prerelease: verified.manifest.githubPrerelease
  });

  let remote = await listTagReleases(fetchImpl, token, expected.tag);
  const tagCommit = await resolveTagCommit(fetchImpl, token, expected.tag);
  if (tagCommit !== null && tagCommit !== sourceCommit) {
    throw new Error("GITHUB_TAG_CONFLICT: existing tag points to a different commit");
  }
  let existing = null;
  if (remote !== null) {
    validateReleaseMetadata(remote, expected, true);
    existing = await validateRemoteAssets(fetchImpl, token, remote, verified.assets);
    if (!remote.draft) {
      if (tagCommit !== sourceCommit || existing.size !== verified.assets.length) {
        throw new Error("GITHUB_RELEASE_CONFLICT: finalized release is incomplete or has no exact tag");
      }
      return Object.freeze({
        tag: expected.tag,
        releaseId: remote.id,
        uploaded: 0,
        finalized: false,
        alreadyPublished: true
      });
    }
  }
  if (remote === null) {
    if (await currentMainCommit(fetchImpl, token) !== sourceCommit) {
      throw new Error("GITHUB_MAIN_STALE: current main advanced beyond the reviewed source commit");
    }
    const { value } = await githubJson(
      fetchImpl,
      token,
      `${API}/repos/${RELEASE_REPOSITORY}/releases`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tag_name: expected.tag,
          target_commitish: sourceCommit,
          name: expected.name,
          body: expected.body,
          draft: true,
          prerelease: expected.prerelease
        })
      },
      [201]
    );
    remote = validateReleaseMetadata(value, expected, true);
    if (!remote.draft) throw new Error("GITHUB_RELEASE_CONFLICT: newly created release is not a draft");
    existing = new Map();
  }

  let uploaded = 0;
  for (const asset of verified.assets) {
    if (existing.has(asset.filename)) continue;
    await githubJson(
      fetchImpl,
      token,
      uploadUrl(remote, asset.filename),
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/octet-stream",
          "content-length": String(asset.size)
        },
        body: asset.bytes
      },
      [201]
    );
    uploaded += 1;
  }

  remote = validateReleaseMetadata(
    await listTagReleases(fetchImpl, token, expected.tag),
    expected,
    true
  );
  const complete = await validateRemoteAssets(fetchImpl, token, remote, verified.assets);
  if (complete.size !== verified.assets.length || !remote.draft) {
    throw new Error("GITHUB_RELEASE_INCOMPLETE: draft is not the exact complete asset set");
  }
  await githubJson(
    fetchImpl,
    token,
    `${API}/repos/${RELEASE_REPOSITORY}/releases/${remote.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: false })
    }
  );

  const finalized = validateReleaseMetadata(
    await listTagReleases(fetchImpl, token, expected.tag),
    expected,
    false
  );
  const finalAssets = await validateRemoteAssets(fetchImpl, token, finalized, verified.assets);
  if (finalAssets.size !== verified.assets.length || await resolveTagCommit(fetchImpl, token, expected.tag) !== sourceCommit) {
    throw new Error("GITHUB_RELEASE_FINALIZE_UNCERTAIN: finalized release or tag could not be reverified");
  }
  return Object.freeze({
    tag: expected.tag,
    releaseId: finalized.id,
    uploaded,
    finalized: true,
    alreadyPublished: false
  });
}

export async function publishGitHubRelease(options) {
  return publishGitHubReleaseInternal(options, true);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--source-commit") {
    throw new Error("Usage: publish-github-release.mjs --source-commit <sha> <asset-directory>");
  }
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || process.env.GITHUB_SHA !== args[1]
    || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    || !/^[1-9]\d*$/u.test(process.env.GITHUB_RUN_ID ?? "")
  ) {
    throw new Error("GITHUB_WORKFLOW_CONTEXT_INVALID: envelope-only publication requires exact GitHub Actions main context");
  }
  const result = await publishGitHubReleaseInternal({
    directory: args[2],
    expectedSourceCommit: args[1],
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN
  }, false);
  process.stdout.write(`${result.alreadyPublished ? "Already published" : "Published"} ${result.tag}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${boundedDiagnostic(
      error instanceof Error ? error.message : "GitHub release publication failed",
      2_048
    )}\n`);
    process.exitCode = 1;
  });
}
