import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assembleReleaseAssets } from "../../../scripts/assemble-release-assets.mjs";
import {
  extractReleaseNotes,
  publishGitHubRelease
} from "../../../scripts/publish-github-release.mjs";
import { verifyReleaseAssets } from "../../../scripts/verify-release-assets.mjs";
import { createRegistryPackageFixture } from "./fixtures/release-assets.mjs";

const repositoryRoot = resolve(process.cwd(), "../..");
const publisherScript = join(repositoryRoot, "scripts", "publish-github-release.mjs");
const roots = [];
let release;
let sourceCommit;
let directory;
let notes;
let verified;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-github-release-fixture-"));
  roots.push(root);
  const fixture = await createRegistryPackageFixture(repositoryRoot, join(root, "packages"));
  ({ release, sourceCommit } = fixture);
  directory = join(root, "release");
  await assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: directory,
    sourceCommit,
    fetchImpl: fixture.registryFetch([])
  });
  notes = await extractReleaseNotes(repositoryRoot, release.version);
  verified = await verifyReleaseAssets({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit
  });
}, 60_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function freshGitHub({
  state = "absent",
  initialAssetCount = 0,
  extraAsset = false,
  digestless = false,
  tagMode = state === "final" ? "direct" : "none",
  duplicateRelease = false,
  fullReleasePages = false,
  metadataOverride = {},
  corruptAsset = false,
  cdnHost = "release-assets.githubusercontent.com",
  cdnFailure = false,
  failUploadAt = 0,
  mainCommit = sourceCommit,
  advanceMainAfterUploads = false,
  onFirstCall
} = {}) {
  const calls = [];
  let currentRelease = state === "absent" ? null : {
    tag_name: `v${release.version}`,
    target_commitish: sourceCommit,
    name: `Skill Steward v${release.version}`,
    body: notes,
    draft: state === "draft",
    prerelease: release.githubPrerelease,
    ...metadataOverride
  };
  let finalTag = tagMode !== "none";
  let nextAssetId = 10;
  const assets = verified.assets.slice(0, initialAssetCount).map((asset, index) => ({
    id: nextAssetId + index,
    name: asset.filename,
    bytes: Buffer.from(asset.bytes)
  }));
  nextAssetId += assets.length;
  if (corruptAsset && assets[0]) assets[0].bytes[0] ^= 0xff;
  if (extraAsset) assets.push({ id: nextAssetId++, name: "unexpected.txt", bytes: Buffer.from("extra") });
  let firstCall = true;
  let uploadAttempts = 0;

  function releaseValue() {
    return {
      id: 1,
      tag_name: currentRelease.tag_name,
      target_commitish: currentRelease.target_commitish,
      name: currentRelease.name,
      body: currentRelease.body,
      draft: currentRelease.draft,
      prerelease: currentRelease.prerelease,
      upload_url: "https://uploads.github.com/repos/CongBao/skill-steward/releases/1/assets{?name,label}",
      assets: assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.bytes.length,
        digest: digestless ? null : `sha256:${createHash("sha256").update(asset.bytes).digest("hex")}`,
        url: `https://api.github.com/repos/CongBao/skill-steward/releases/assets/${asset.id}`
      }))
    };
  }

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method ?? "GET";
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    calls.push({ url: url.href, method, headers: options.headers, body });
    if (firstCall) {
      firstCall = false;
      await onFirstCall?.();
    }

    if (url.origin === "https://api.github.com" && url.pathname.endsWith("/releases") && method === "GET") {
      if (fullReleasePages) {
        return json(Array.from({ length: 100 }, (_value, index) => ({ tag_name: `v0.0.${index}` })));
      }
      return json(currentRelease ? (duplicateRelease ? [releaseValue(), releaseValue()] : [releaseValue()]) : []);
    }
    if (url.origin === "https://api.github.com" && url.pathname.endsWith("/git/ref/heads/main") && method === "GET") {
      const sha = advanceMainAfterUploads && assets.length > initialAssetCount ? "e".repeat(40) : mainCommit;
      return json({ ref: "refs/heads/main", object: { type: "commit", sha } });
    }
    if (url.origin === "https://api.github.com" && url.pathname.includes("/git/ref/tags/") && method === "GET") {
      return finalTag
        ? json({
          ref: `refs/tags/v${release.version}`,
          object: tagMode === "annotated"
            ? { type: "tag", sha: "a".repeat(40) }
            : { type: "commit", sha: tagMode === "wrong" ? "f".repeat(40) : sourceCommit }
        })
        : json({ message: "Not Found" }, 404);
    }
    if (url.origin === "https://api.github.com" && url.pathname.endsWith(`/git/tags/${"a".repeat(40)}`)) {
      return json({ object: { type: "commit", sha: sourceCommit } });
    }
    if (url.origin === "https://api.github.com" && url.pathname.endsWith("/releases") && method === "POST") {
      currentRelease = { ...JSON.parse(body.toString("utf8")), id: 1 };
      return json(releaseValue(), 201);
    }
    if (url.origin === "https://uploads.github.com" && method === "POST") {
      uploadAttempts += 1;
      if (failUploadAt > 0 && uploadAttempts === failUploadAt) {
        return json({ message: "simulated upload interruption" }, 500);
      }
      assets.push({ id: nextAssetId, name: url.searchParams.get("name"), bytes: body });
      nextAssetId += 1;
      const asset = assets.at(-1);
      return json({
        id: asset.id,
        name: asset.name,
        size: asset.bytes.length,
        digest: `sha256:${createHash("sha256").update(asset.bytes).digest("hex")}`
      }, 201);
    }
    if (url.origin === "https://api.github.com" && url.pathname.endsWith("/releases/1") && method === "PATCH") {
      const change = JSON.parse(body.toString("utf8"));
      currentRelease = { ...currentRelease, ...change };
      if (change.draft === false) finalTag = true;
      return json(releaseValue());
    }
    if (url.origin === "https://api.github.com" && url.pathname.includes("/releases/assets/") && method === "GET") {
      const id = Number(url.pathname.split("/").at(-1));
      const asset = assets.find((candidate) => candidate.id === id);
      if (!asset) return json({ message: "Not Found" }, 404);
      return new Response(null, {
        status: 302,
        headers: { location: `https://${cdnHost}/download/${id}` }
      });
    }
    if (url.hostname === cdnHost && method === "GET") {
      if (cdnFailure) throw new Error(`${"network-detail".repeat(500)}\n\t\u202e spoofed`);
      const id = Number(url.pathname.split("/").at(-1));
      const asset = assets.find((candidate) => candidate.id === id);
      return asset ? new Response(asset.bytes, { status: 200 }) : new Response("missing", { status: 404 });
    }
    return json({ message: `Unexpected ${method} ${url.href}` }, 500);
  };

  return { calls, fetchImpl, assets, getRelease: () => currentRelease };
}

it("creates a draft, uploads the exact nine verified bytes, rechecks, then finalizes", async () => {
  const github = freshGitHub();
  const result = await publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  });

  expect(result).toEqual({
    tag: `v${release.version}`,
    releaseId: 1,
    uploaded: 9,
    finalized: true,
    alreadyPublished: false
  });
  expect(github.assets).toHaveLength(9);
  expect(github.assets.map(({ name }) => name).sort()).toEqual([
    "SHA256SUMS",
    "release-manifest.json",
    `skill-steward-${release.version}.tgz`,
    ...release.packages.filter(({ role }) => role === "native").map(({ name }) => (
      `${name.replace(/^@/u, "").replace("/", "-")}-${release.version}.tgz`
    ))
  ].sort());
  expect(github.getRelease()).toMatchObject({
    tag_name: `v${release.version}`,
    target_commitish: sourceCommit,
    draft: false,
    prerelease: release.githubPrerelease
  });

  const createIndex = github.calls.findIndex(({ method, url }) => method === "POST" && url.endsWith("/releases"));
  const firstUpload = github.calls.findIndex(({ method, url }) => method === "POST" && url.startsWith("https://uploads.github.com/"));
  const finalizeIndex = github.calls.findIndex(({ method, url }) => method === "PATCH" && url.endsWith("/releases/1"));
  const releaseReadsBeforeFinalize = github.calls
    .slice(firstUpload + 1, finalizeIndex)
    .filter(({ method, url }) => method === "GET" && url.includes("/releases?"));
  expect(createIndex).toBeGreaterThan(1);
  expect(firstUpload).toBeGreaterThan(createIndex);
  expect(releaseReadsBeforeFinalize.length).toBeGreaterThan(0);
  expect(finalizeIndex).toBeGreaterThan(firstUpload);
  expect(github.calls.filter(({ url }) => url.endsWith("/git/ref/heads/main"))).toHaveLength(1);
  expect(github.calls.every(({ headers, url }) => (
    !url.startsWith("https://api.github.com/")
    || headers.authorization === "Bearer test-token"
  ))).toBe(true);
});

it("resumes a previously admitted matching draft after main advances", async () => {
  const github = freshGitHub({
    state: "draft",
    initialAssetCount: 3,
    mainCommit: "e".repeat(40)
  });
  const result = await publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  });
  expect(result).toMatchObject({ uploaded: 6, finalized: true, alreadyPublished: false });
  expect(github.assets).toHaveLength(9);
  expect(github.calls.filter(({ method, url }) => method === "POST" && url.endsWith("/releases"))).toEqual([]);
  expect(github.calls.filter(({ method, url }) => method === "POST" && url.startsWith("https://uploads.github.com/"))).toHaveLength(6);
});

it("treats a finalized byte-identical release as a no-op after main advances", async () => {
  const github = freshGitHub({
    state: "final",
    initialAssetCount: 9,
    tagMode: "annotated",
    mainCommit: "e".repeat(40)
  });
  const result = await publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  });
  expect(result).toMatchObject({ uploaded: 0, finalized: false, alreadyPublished: true });
  expect(github.calls.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
  expect(github.calls.some(({ url }) => url.endsWith("/git/ref/heads/main"))).toBe(false);
  expect(github.calls.some(({ url }) => url.endsWith(`/git/tags/${"a".repeat(40)}`))).toBe(true);
});

it.each([
  ["duplicate release", { state: "draft", duplicateRelease: true }, /duplicate/i],
  ["extra asset", { state: "draft", initialAssetCount: 2, extraAsset: true }, /unexpected|asset conflict/i],
  ["wrong tag", { state: "draft", tagMode: "wrong" }, /tag.*conflict|conflict.*tag/i],
  ["metadata drift", { state: "draft", metadataOverride: { name: "Wrong release" } }, /release.*conflict|conflict.*release/i],
  ["notes drift", { state: "draft", metadataOverride: { body: "Wrong notes\n" } }, /release.*conflict|conflict.*release/i],
  ["target drift", { state: "draft", metadataOverride: { target_commitish: "f".repeat(40) } }, /release.*conflict|conflict.*release/i],
  ["prerelease drift", { state: "draft", metadataOverride: { prerelease: false } }, /release.*conflict|conflict.*release/i],
  ["incomplete final", { state: "final", initialAssetCount: 3 }, /incomplete|conflict/i],
  ["same-size byte drift", { state: "draft", initialAssetCount: 1, corruptAsset: true }, /asset.*conflict|differs/i]
])("refuses %s before any GitHub mutation", async (_label, options, message) => {
  const github = freshGitHub(options);
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  })).rejects.toThrow(message);
  expect(github.calls.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
});

it("bounds release discovery before mutation", async () => {
  const github = freshGitHub({ fullReleasePages: true });
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  })).rejects.toThrow(/listing.*bound|bounded/i);
  expect(github.calls.filter(({ url }) => url.includes("/releases?"))).toHaveLength(3);
  expect(github.calls.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
});

it("hashes digestless assets through one credential-free approved CDN redirect", async () => {
  const github = freshGitHub({
    state: "final",
    initialAssetCount: 9,
    digestless: true,
    tagMode: "direct"
  });
  const result = await publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  });
  expect(result.alreadyPublished).toBe(true);
  const cdnCalls = github.calls.filter(({ url }) => url.startsWith("https://release-assets.githubusercontent.com/"));
  expect(cdnCalls).toHaveLength(9);
  expect(cdnCalls.every(({ headers }) => headers?.authorization === undefined)).toBe(true);
});

it("uploads the verified byte snapshot even if a local path changes after preflight", async () => {
  const target = verified.assets.find(({ filename }) => filename.endsWith(".tgz"));
  const path = join(directory, target.filename);
  const original = await readFile(path);
  const github = freshGitHub({
    onFirstCall: async () => writeFile(path, "changed after offline verification")
  });
  try {
    const result = await publishGitHubRelease({
      repositoryRoot,
      directory,
      expectedSourceCommit: sourceCommit,
      repository: "CongBao/skill-steward",
      token: "test-token",
      fetchImpl: github.fetchImpl
    });
    expect(result.finalized).toBe(true);
    expect(github.assets.find(({ name }) => name === target.filename).bytes.equals(original)).toBe(true);
  } finally {
    await writeFile(path, original);
  }
});

it("leaves an interrupted release as a resumable draft", async () => {
  const github = freshGitHub({ failUploadAt: 4 });
  const options = {
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  };
  await expect(publishGitHubRelease(options)).rejects.toThrow(/HTTP_500|interruption/i);
  expect(github.getRelease().draft).toBe(true);
  expect(github.assets).toHaveLength(3);

  const resumed = await publishGitHubRelease(options);
  expect(resumed).toMatchObject({ uploaded: 6, finalized: true, alreadyPublished: false });
  expect(github.assets).toHaveLength(9);
});

it("refuses an unapproved asset redirect without forwarding the token", async () => {
  const github = freshGitHub({
    state: "final",
    initialAssetCount: 9,
    digestless: true,
    cdnHost: "attacker.example"
  });
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  })).rejects.toThrow(/redirect host|approved/i);
  expect(github.calls.some(({ url }) => url.startsWith("https://attacker.example/"))).toBe(false);
});

it("bounds and single-lines digest fallback network diagnostics", async () => {
  const github = freshGitHub({
    state: "final",
    initialAssetCount: 9,
    digestless: true,
    cdnFailure: true
  });
  let failure;
  try {
    await publishGitHubRelease({
      repositoryRoot,
      directory,
      expectedSourceCommit: sourceCommit,
      repository: "CongBao/skill-steward",
      token: "test-token",
      fetchImpl: github.fetchImpl
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message.length).toBeLessThanOrEqual(1_100);
  expect(failure.message).not.toMatch(/[\r\n\t\p{Cf}]/u);
});

it("rejects repository and local preflight drift before GitHub access", async () => {
  const github = freshGitHub();
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "fork/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  })).rejects.toThrow(/repository.*mismatch|mismatch.*repository/i);
  expect(github.calls).toEqual([]);

  const invalidRoot = await mkdtemp(join(tmpdir(), "steward-invalid-release-"));
  roots.push(invalidRoot);
  await writeFile(join(invalidRoot, "unexpected.txt"), "invalid");
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory: invalidRoot,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: github.fetchImpl
  })).rejects.toThrow(/inventory|nine/i);
  expect(github.calls).toEqual([]);
});

it("keeps envelope-only CLI publication bound to exact GitHub Actions main context", () => {
  const result = spawnSync(
    process.execPath,
    [publisherScript, "--source-commit", sourceCommit, directory],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_SHA: sourceCommit,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "CongBao/skill-steward",
        GITHUB_RUN_ID: "123"
      }
    }
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/workflow.*context.*invalid/i);
  expect(result.stderr).not.toContain("test-token");
});

it("refuses stale approval before mutation but completes an admitted draft if main later advances", async () => {
  const stale = freshGitHub({ mainCommit: "e".repeat(40) });
  await expect(publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: stale.fetchImpl
  })).rejects.toThrow(/main.*advanced|stale|current main/i);
  expect(stale.calls.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);

  const advanced = freshGitHub({ advanceMainAfterUploads: true });
  const result = await publishGitHubRelease({
    repositoryRoot,
    directory,
    expectedSourceCommit: sourceCommit,
    repository: "CongBao/skill-steward",
    token: "test-token",
    fetchImpl: advanced.fetchImpl
  });
  expect(result.finalized).toBe(true);
  expect(advanced.getRelease().draft).toBe(false);
});
