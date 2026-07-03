import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageFolderUpload } from "../src/folder-source.js";

describe("stageFolderUpload", () => {
  it("writes a bounded folder upload while preserving safe relative paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steward-folder-"));
    const result = await stageFolderUpload(directory, [
      { relativePath: "review/SKILL.md", data: Buffer.from("skill") },
      { relativePath: "review/references/checks.md", data: Buffer.from("checks") }
    ]);

    expect(result).toEqual({ fileCount: 2, bytes: 11 });
    await expect(readFile(join(directory, "review/SKILL.md"), "utf8")).resolves.toBe("skill");
  });

  it("rejects unsafe, duplicate, and case-colliding paths", async () => {
    for (const files of [
      [{ relativePath: "../secret", data: Buffer.from("x") }],
      [
        { relativePath: "review/SKILL.md", data: Buffer.from("x") },
        { relativePath: "review/SKILL.md", data: Buffer.from("y") }
      ],
      [
        { relativePath: "review/SKILL.md", data: Buffer.from("x") },
        { relativePath: "Review/skill.md", data: Buffer.from("y") }
      ]
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "steward-folder-reject-"));
      await expect(stageFolderUpload(directory, files)).rejects.toMatchObject({
        code: "UNSAFE_SOURCE_PATH"
      });
    }
  });
});
