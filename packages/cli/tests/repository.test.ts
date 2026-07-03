import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const required = [
  "LICENSE",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "GOVERNANCE.md",
  "SUPPORT.md",
  ".editorconfig",
  ".gitattributes",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  "docs/architecture.md",
  "docs/images/overview-light.png",
  "docs/images/skills-install-dark.png"
];

async function expectLocalLinksToExist(markdownPath: string, markdown: string): Promise<void> {
  const links = [...markdown.matchAll(/\[[^\]]*\]\((?!https?:|#)([^)]+)\)/g)].map(
    (match) => match[1] as string
  );
  for (const link of links) {
    const clean = decodeURIComponent(link.split("#")[0] ?? "");
    if (clean) {
      await expect(access(resolve(root, dirname(markdownPath), clean))).resolves.toBeUndefined();
    }
  }
}

describe("open-source repository", () => {
  it("contains release, governance, contribution, security, and community files", async () => {
    await Promise.all(required.map((path) => expect(access(join(root, path))).resolves.toBeUndefined()));
  });

  it("ships a substantive README with valid local links and real screenshots", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const heading of [
      "## Why Skill Steward",
      "## Screenshots",
      "## Installation",
      "## Quick start",
      "## Supported harnesses",
      "## How safe installation works",
      "## Comparison",
      "## Privacy and security",
      "## Contributing"
    ]) {
      expect(readme).toContain(heading);
    }
    expect(readme).toContain("[简体中文](README.zh-CN.md)");
    expect(readme).not.toContain("not a design mockup or a real user's portfolio");
    expect(readme).not.toContain("OpenSpec");
    await expectLocalLinksToExist("README.md", readme);

    for (const screenshot of ["overview-light.png", "skills-install-dark.png"]) {
      const bytes = await readFile(join(root, "docs/images", screenshot));
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(900);
      expect(bytes.readUInt32BE(20)).toBeGreaterThanOrEqual(700);
    }
  });

  it("ships a complete Chinese README with mutual language navigation", async () => {
    const chineseReadme = await readFile(join(root, "README.zh-CN.md"), "utf8");
    for (const heading of [
      "## 为什么选择 Skill Steward",
      "## 界面截图",
      "## 安装",
      "## 快速开始",
      "## 支持的 Harness",
      "## 安全安装如何工作",
      "## 竞品比较",
      "## 隐私与安全",
      "## 参与贡献"
    ]) {
      expect(chineseReadme).toContain(heading);
    }
    expect(chineseReadme).toContain("[English](README.md)");
    expect(chineseReadme).not.toContain("并非设计稿");
    expect(chineseReadme).not.toContain("OpenSpec");
    await expectLocalLinksToExist("README.zh-CN.md", chineseReadme);
  });

  it("keeps internal planning references out of the public documentation tree", async () => {
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).not.toContain("OpenSpec");
    const internalEntries = await readdir(join(root, "docs/superpowers"), {
      recursive: true,
      withFileTypes: true
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(internalEntries.filter((entry) => entry.isFile())).toEqual([]);
  });
});
