import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanPortfolio } from "../src/analyze.js";

describe("scanPortfolio", () => {
  it("returns valid skills and a finding for an invalid skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-scan-"));
    await mkdir(join(root, "valid"));
    await mkdir(join(root, "invalid"));
    await writeFile(join(root, "valid", "SKILL.md"), "---\nname: valid\ndescription: Valid skill\n---\n");
    await writeFile(join(root, "invalid", "SKILL.md"), "invalid");

    const report = await scanPortfolio(
      [{ path: root, scope: "project", visibleTo: ["agents"] }],
      new Date("2026-07-02T00:00:00.000Z")
    );

    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).not.toHaveProperty("body");
    expect(report.findings.some((finding) => finding.code === "SKILL_PARSE_FAILED")).toBe(true);
  });

  it("produces the same portfolio fingerprint for unchanged content", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-stable-"));
    await mkdir(join(root, "stable"));
    await writeFile(join(root, "stable", "SKILL.md"), "---\nname: stable\ndescription: Stable skill\n---\n");

    const first = await scanPortfolio([{ path: root, scope: "project", visibleTo: ["agents"] }]);
    const second = await scanPortfolio([{ path: root, scope: "project", visibleTo: ["agents"] }]);

    expect(first.portfolioFingerprint).toBe(second.portfolioFingerprint);
  });
});
