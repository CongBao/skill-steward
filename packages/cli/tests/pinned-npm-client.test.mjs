import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  NPM_PUBLISHER_INTEGRITY,
  NPM_PUBLISHER_TARBALL_URL,
  NPM_PUBLISHER_VERSION,
  verifyPinnedNpmClient
} from "../../../scripts/verify-pinned-npm-client.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("pins the exact npm publisher client and rejects different bytes", async () => {
  expect(NPM_PUBLISHER_VERSION).toBe("11.17.0");
  expect(NPM_PUBLISHER_INTEGRITY).toBe(
    "sha512-PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw=="
  );

  const root = await mkdtemp(join(tmpdir(), "steward-pinned-npm-"));
  roots.push(root);
  const artifact = join(root, "npm-11.17.0.tgz");
  await writeFile(artifact, "different package bytes", "utf8");

  await expect(verifyPinnedNpmClient(artifact)).rejects.toThrow("integrity differs");
});

it.runIf(process.env.SKILL_STEWARD_LIVE_RELEASE_TESTS === "1")(
  "accepts the immutable official npm publisher tarball",
  async () => {
    expect(process.env.SKILL_STEWARD_LIVE_RELEASE_TESTS).toBe("1");
    expect(NPM_PUBLISHER_TARBALL_URL).toBe(
      "https://registry.npmjs.org/npm/-/npm-11.17.0.tgz"
    );
    const root = await mkdtemp(join(tmpdir(), "steward-official-npm-"));
    roots.push(root);
    const artifact = join(root, "npm-11.17.0.tgz");

    let response;
    try {
      response = await fetch(NPM_PUBLISHER_TARBALL_URL, {
        headers: { accept: "application/octet-stream" },
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(
        `Official npm tarball fetch failed: ${String(error instanceof Error ? error.message : error).slice(0, 256)}`
      );
    }
    if (!response.ok) {
      throw new Error(`Official npm tarball fetch returned HTTP ${response.status}`);
    }
    await writeFile(artifact, Buffer.from(await response.arrayBuffer()));

    await expect(verifyPinnedNpmClient(artifact)).resolves.toEqual({
      version: "11.17.0",
      integrity: NPM_PUBLISHER_INTEGRITY,
      bytes: expect.any(Number)
    });
  },
  20_000
);
