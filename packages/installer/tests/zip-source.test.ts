import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { stageZipArchive } from "../src/zip-source.js";

async function archive(
  files: Array<{ path: string; body: string; unixPermissions?: number }>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.body, {
      ...(file.unixPermissions === undefined
        ? {}
        : { unixPermissions: file.unixPermissions })
    });
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

describe("stageZipArchive", () => {
  it("extracts a bounded Skill archive into staging", async () => {
    const destination = await mkdtemp(join(tmpdir(), "steward-zip-"));
    const bytes = await archive([
      { path: "review/SKILL.md", body: "---\nname: review\ndescription: review\n---\n" },
      { path: "review/reference.md", body: "checks" }
    ]);

    expect(await stageZipArchive(destination, bytes)).toEqual({
      fileCount: 2,
      bytes: 47
    });
    await expect(readFile(join(destination, "review/reference.md"), "utf8")).resolves.toBe(
      "checks"
    );
  });

  it("rejects traversal, case collisions, symlinks, and expanded-size overflow", async () => {
    const cases = [
      archive([{ path: "../secret", body: "x" }]),
      archive([
        { path: "review/SKILL.md", body: "x" },
        { path: "Review/skill.md", body: "y" }
      ]),
      archive([{ path: "review/link", body: "target", unixPermissions: 0o120777 }]),
      archive([{ path: "review/SKILL.md", body: "0123456789" }])
    ];

    for (const [index, pending] of cases.entries()) {
      const destination = await mkdtemp(join(tmpdir(), "steward-zip-reject-"));
      await expect(
        stageZipArchive(destination, await pending, {
          maxExpandedBytes: index === 3 ? 5 : 1_000
        })
      ).rejects.toBeTruthy();
    }
  });
});
