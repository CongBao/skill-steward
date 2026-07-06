import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assembleReleaseAssets } from "../../../scripts/assemble-release-assets.mjs";
import { verifyReleaseAssets } from "../../../scripts/verify-release-assets.mjs";
import { createRegistryPackageFixture } from "./fixtures/release-assets.mjs";

const repositoryRoot = resolve(process.cwd(), "../..");
const roots = [];
let release;
let sourceCommit;
let packages;
let registryFetch;

beforeAll(async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "steward-release-assets-fixture-"));
  roots.push(fixtureRoot);
  ({ release, sourceCommit, packages, registryFetch } = await createRegistryPackageFixture(
    repositoryRoot,
    fixtureRoot
  ));
}, 60_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assembledDirectory(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const directory = join(root, "release");
  await assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: directory,
    sourceCommit,
    fetchImpl: registryFetch([])
  });
  return { root, directory };
}

it("assembles the exact seven npm bytes into one canonical nine-file release set", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-assets-"));
  roots.push(root);
  const outputDirectory = join(root, "release");
  const calls = [];

  const result = await assembleReleaseAssets({
    repositoryRoot,
    outputDirectory,
    sourceCommit,
    fetchImpl: registryFetch(calls)
  });

  expect((await readdir(outputDirectory)).sort()).toEqual([
    "SHA256SUMS",
    ...packages.map(({ filename }) => filename).sort(),
    "release-manifest.json"
  ].sort());
  expect(result.files).toBe(9);
  expect(calls).toHaveLength(14);
  expect(calls.slice(0, 7).every(({ url }) => !url.includes("/-/"))).toBe(true);
  expect(calls.slice(7).every(({ url }) => url.includes("/-/"))).toBe(true);
  expect(calls.every(({ options }) => (
    options.redirect === "manual"
    && options.headers?.authorization === undefined
  ))).toBe(true);

  const manifestBytes = await readFile(join(outputDirectory, "release-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestBytes);
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    repository: "CongBao/skill-steward",
    sourceCommit,
    provenanceScope: "npm-registry-byte-assembly",
    version: release.version,
    channel: release.channel,
    npmTag: release.npmTag,
    githubPrerelease: release.githubPrerelease
  });
  expect(manifest.packages.map(({ name }) => name)).toEqual(release.packages.map(({ name }) => name));
  expect(manifest.packages.map(({ version }) => version)).toEqual(release.packages.map(() => release.version));
  expect(manifest.packages.map(({ filename }) => filename)).toEqual(packages.map(({ filename }) => filename));
  expect(manifestBytes).toBe(`${JSON.stringify(manifest, null, 2)}\n`);

  const checksumLines = (await readFile(join(outputDirectory, "SHA256SUMS"), "utf8"))
    .trimEnd()
    .split("\n");
  expect(checksumLines).toHaveLength(8);
  expect(checksumLines.map((line) => line.slice(66))).toEqual([
    ...packages.map(({ filename }) => filename),
    "release-manifest.json"
  ].sort());
});

it("offline-verifies the exact inventory and returns the same immutable bytes for publication", async () => {
  const { directory: outputDirectory } = await assembledDirectory("steward-release-offline-");

  const verified = await verifyReleaseAssets({
    repositoryRoot,
    directory: outputDirectory,
    expectedSourceCommit: sourceCommit
  });

  expect(verified.manifest.sourceCommit).toBe(sourceCommit);
  expect(verified.assets).toHaveLength(9);
  expect(verified.assets.map(({ filename }) => filename)).toEqual([
    "SHA256SUMS",
    ...packages.map(({ filename }) => filename),
    "release-manifest.json"
  ].sort());
  for (const asset of verified.assets) {
    expect(Buffer.isBuffer(asset.bytes)).toBe(true);
    expect(asset.bytes.equals(await readFile(join(outputDirectory, asset.filename)))).toBe(true);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(asset.size).toBe(asset.bytes.length);
    expect(Object.isFrozen(asset)).toBe(true);
  }
});

it("offline verification rejects missing, extra, linked, and noncanonical assets", async () => {
  const { directory } = await assembledDirectory("steward-release-inventory-refusal-");
  const verify = () => verifyReleaseAssets({ repositoryRoot, directory, expectedSourceCommit: sourceCommit });

  await writeFile(join(directory, "extra.txt"), "extra");
  await expect(verify()).rejects.toThrow(/inventory|nine/i);
  await rm(join(directory, "extra.txt"));

  const tarball = packages[0].filename;
  const original = await readFile(join(directory, tarball));
  await rm(join(directory, tarball));
  await symlink("release-manifest.json", join(directory, tarball));
  await expect(verify()).rejects.toThrow(/regular file|inventory/i);
  await rm(join(directory, tarball));
  await writeFile(join(directory, tarball), original);

  const manifestPath = join(directory, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await expect(verify()).rejects.toThrow(/canonical|manifest/i);
});

it("offline verification rejects byte, checksum, and independently expected commit drift", async () => {
  const first = await assembledDirectory("steward-release-byte-refusal-");
  const verifyFirst = () => verifyReleaseAssets({
    repositoryRoot,
    directory: first.directory,
    expectedSourceCommit: sourceCommit
  });
  await writeFile(join(first.directory, packages[0].filename), "tampered tarball");
  await expect(verifyFirst()).rejects.toThrow(/digest|tar|gzip|archive|bytes/i);

  const second = await assembledDirectory("steward-release-checksum-refusal-");
  await writeFile(join(second.directory, "SHA256SUMS"), "0".repeat(64));
  await expect(verifyReleaseAssets({
    repositoryRoot,
    directory: second.directory,
    expectedSourceCommit: sourceCommit
  })).rejects.toThrow(/checksum/i);

  await expect(verifyReleaseAssets({
    repositoryRoot,
    directory: second.directory,
    expectedSourceCommit: "0".repeat(40)
  })).rejects.toThrow(/source commit|HEAD|mismatch/i);
});

it.each([
  ["wrong package", (value, item) => item === packages.at(-1) ? { ...value, name: "wrong-package" } : value],
  ["wrong version", (value, item) => item === packages.at(-1) ? { ...value, version: "9.9.9" } : value],
  ["insecure URL", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: value.dist.tarball.replace("https:", "http:") }
  } : value],
  ["credential URL", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: value.dist.tarball.replace("https://", "https://token@") }
  } : value],
  ["alternate host", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: value.dist.tarball.replace("registry.npmjs.org", "example.com") }
  } : value],
  ["alternate port", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: value.dist.tarball.replace("registry.npmjs.org", "registry.npmjs.org:444") }
  } : value],
  ["query URL", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: `${value.dist.tarball}?token=secret` }
  } : value],
  ["fragment URL", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, tarball: `${value.dist.tarball}#fragment` }
  } : value],
  ["noncanonical SRI", (value, item) => item === packages.at(-1) ? {
    ...value,
    dist: { ...value.dist, integrity: "sha512-Zm9v" }
  } : value]
])("rejects %s during complete metadata preflight before downloading bytes", async (_label, transform) => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-metadata-refusal-"));
  roots.push(root);
  const calls = [];
  await expect(assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: join(root, "release"),
    sourceCommit,
    fetchImpl: registryFetch(calls, transform)
  })).rejects.toThrow(/metadata|tarball|registry|integrity|contract|URL/i);
  expect(calls).toHaveLength(7);
  expect(calls.every(({ url }) => !url.includes("/-/"))).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it("removes staging when downloaded bytes match SRI but fail package verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-package-refusal-"));
  roots.push(root);
  const badBytes = Buffer.from("not a package tarball");
  const badIntegrity = `sha512-${createHash("sha512").update(badBytes).digest("base64")}`;
  const calls = [];
  const normal = registryFetch(calls, (value, item) => item === packages[0]
    ? { ...value, dist: { ...value.dist, integrity: badIntegrity } }
    : value);
  const fetchImpl = async (url, options) => {
    if (String(url) === packages[0].tarball) {
      calls.push({ url: String(url), options });
      return new Response(badBytes, { status: 200 });
    }
    return normal(url, options);
  };
  await expect(assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: join(root, "release"),
    sourceCommit,
    fetchImpl
  })).rejects.toThrow(/gzip|header|archive|package|tarball/i);
  expect(await readdir(root)).toEqual([]);
});

it("bounds and single-lines streamed registry failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-stream-refusal-"));
  roots.push(root);
  const calls = [];
  const normal = registryFetch(calls);
  let replaced = false;
  const fetchImpl = async (url, options) => {
    if (!replaced && String(url).includes("/-/")) {
      replaced = true;
      calls.push({ url: String(url), options });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(new Error(`${"stream-detail".repeat(500)}\n\t\u202e spoofed`));
        }
      }), { status: 200 });
    }
    return normal(url, options);
  };
  let failure;
  try {
    await assembleReleaseAssets({
      repositoryRoot,
      outputDirectory: join(root, "release"),
      sourceCommit,
      fetchImpl
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message.length).toBeLessThanOrEqual(1_100);
  expect(failure.message).not.toMatch(/[\r\n\t\p{Cf}]/u);
  expect(await readdir(root)).toEqual([]);
});

it("binds the manifest source commit to the actual checkout before registry access", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-commit-refusal-"));
  roots.push(root);
  const calls = [];
  await expect(assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: join(root, "release"),
    sourceCommit: "0".repeat(40),
    fetchImpl: registryFetch(calls)
  })).rejects.toThrow(/source commit.*HEAD|mismatch/i);
  expect(calls).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it("binds GitHub Actions assembly to GITHUB_SHA before registry access", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-actions-commit-refusal-"));
  roots.push(root);
  const calls = [];
  const priorActions = process.env.GITHUB_ACTIONS;
  const priorSha = process.env.GITHUB_SHA;
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_SHA = "0".repeat(40);
  try {
    await expect(assembleReleaseAssets({
      repositoryRoot,
      outputDirectory: join(root, "release"),
      sourceCommit,
      fetchImpl: registryFetch(calls)
    })).rejects.toThrow(/GITHUB_SHA|source commit.*mismatch/i);
  } finally {
    if (priorActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = priorActions;
    if (priorSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = priorSha;
  }
  expect(calls).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it.each([
  ["redirect", () => new Response("redirect", { status: 302, headers: { location: "https://example.com/file" } })],
  ["oversized body", () => new Response("small", {
    status: 200,
    headers: { "content-length": String(32 * 1024 * 1024 + 1) }
  })]
])("rejects a %s tarball response without exposing staging", async (_label, response) => {
  const root = await mkdtemp(join(tmpdir(), "steward-release-download-refusal-"));
  roots.push(root);
  const calls = [];
  const normal = registryFetch(calls);
  let replaced = false;
  const fetchImpl = async (url, options) => {
    if (!replaced && String(url).includes("/-/")) {
      replaced = true;
      calls.push({ url: String(url), options });
      return response();
    }
    return normal(url, options);
  };
  await expect(assembleReleaseAssets({
    repositoryRoot,
    outputDirectory: join(root, "release"),
    sourceCommit,
    fetchImpl
  })).rejects.toThrow(/HTTP|large|redirect|tarball/i);
  expect(await readdir(root)).toEqual([]);
});
