import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stagePublicGit, type GitRunner } from "../src/git-source.js";

describe("stagePublicGit", () => {
  it("uses a noninteractive shallow clone, resolves a ref, and records provenance", async () => {
    const destination = await mkdtemp(join(tmpdir(), "steward-git-"));
    const runner: GitRunner = vi.fn(async (args) => {
      const cloneIndex = args.indexOf("clone");
      if (cloneIndex >= 0) {
        await mkdir(args.at(-1) as string, { recursive: true });
        await mkdir(join(args.at(-1) as string, "skills", "review"), { recursive: true });
      }
      return { stdout: args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "" };
    });

    const result = await stagePublicGit(
      destination,
      {
        kind: "git",
        url: "https://github.com/example/skills.git",
        ref: "v1",
        subdirectory: "skills/review"
      },
      runner
    );

    expect(result.commitSha).toBe("a".repeat(40));
    expect(result.sourceDirectory).toBe(
      await realpath(join(destination, "repository", "skills", "review"))
    );
    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--depth",
        "1",
        "--no-recurse-submodules"
      ]),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(["fetch", "--depth", "1", "origin", "v1"]),
      expect.any(Object)
    );
  });

  it("rejects non-HTTPS and escaping subdirectories before invoking Git", async () => {
    const destination = await mkdtemp(join(tmpdir(), "steward-git-reject-"));
    const runner: GitRunner = vi.fn();
    await expect(
      stagePublicGit(destination, { kind: "git", url: "ssh://example/repo" }, runner)
    ).rejects.toBeTruthy();
    await expect(
      stagePublicGit(
        destination,
        { kind: "git", url: "https://example.com/repo", subdirectory: "../secret" },
        runner
      )
    ).rejects.toBeTruthy();
    expect(runner).not.toHaveBeenCalled();
  });
});
