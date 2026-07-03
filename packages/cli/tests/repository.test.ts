import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const englishScreenshots = ["evidence-light-en.png", "governance-dark-en.png"];
const chineseScreenshots = ["evidence-light-zh-CN.png", "governance-dark-zh-CN.png"];
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
  ...englishScreenshots.map((name) => `docs/images/${name}`),
  ...chineseScreenshots.map((name) => `docs/images/${name}`)
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
      "## Task preflight",
      "## Evidence and data policy",
      "## Reversible governance",
      "## Harness capability matrix",
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
    expect(readme).toContain("skill-steward preflight");
    expect(readme).toContain("raw task text is never written to disk");
    expect(readme).toContain("cross-Harness control plane");
    expect(readme).toContain("Use now");
    expect(readme).toContain("Consider installing");
    expect(readme).toContain("Codex and Claude Code `UserPromptSubmit` and completion Hooks");
    expect(readme).toContain("no prompt-time network access");
    expect(readme).toContain("never installs a recommendation automatically");
    expect(readme).toContain("External task-time discovery");
    expect(readme).toContain("Native workflow integration");
    expect(readme).toContain("Cross-Harness analysis");
    expect(readme).toContain("Reversible installation");
    expect(readme).toContain("minimal mode is the default");
    expect(readme).toContain("100 labeled preflights");
    expect(readme).toContain("Lifecycle completion is not task success");
    expect(readme).toContain("GitHub Copilot CLI");
    expect(readme).toContain("Observe only");
    expect(readme).toContain("No ranking threshold or weight changes automatically");
    expect(readme).toContain("skill-steward govern quarantine");
    expect(readme).toContain("skill-steward evidence erase");
    expect(readme).not.toContain("Managed native prompt Hooks are available only for Codex and Claude Code");
    expect(readme).not.toMatch(/universal Hook support|supports automatic installation|automatically installs recommendations|guaranteed safe|sends task to (?:the )?catalog|hosted registry|Copilot automatic prompt injection/i);
    for (const screenshot of englishScreenshots) expect(readme).toContain(screenshot);
    for (const screenshot of chineseScreenshots) expect(readme).not.toContain(screenshot);
    await expectLocalLinksToExist("README.md", readme);
  });

  it("ships a complete Chinese README with mutual language navigation", async () => {
    const chineseReadme = await readFile(join(root, "README.zh-CN.md"), "utf8");
    for (const heading of [
      "## 为什么选择 Skill Steward",
      "## 界面截图",
      "## 安装",
      "## 快速开始",
      "## 任务预检",
      "## 证据与数据策略",
      "## 可恢复治理",
      "## Harness 能力矩阵",
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
    expect(chineseReadme).toContain("skill-steward preflight");
    expect(chineseReadme).toContain("原始任务文本不会写入磁盘");
    expect(chineseReadme).toContain("跨 Harness 控制平面");
    expect(chineseReadme).toContain("立即使用");
    expect(chineseReadme).toContain("建议安装");
    expect(chineseReadme).toContain("Codex 和 Claude Code 的 `UserPromptSubmit` 与结束 Hook");
    expect(chineseReadme).toContain("任务提交时不访问网络");
    expect(chineseReadme).toContain("绝不会自动安装推荐项");
    expect(chineseReadme).toContain("任务时外部发现");
    expect(chineseReadme).toContain("原生工作流集成");
    expect(chineseReadme).toContain("跨 Harness 分析");
    expect(chineseReadme).toContain("可逆安装");
    expect(chineseReadme).toContain("最小模式是默认模式");
    expect(chineseReadme).toContain("100 次带标签的预检");
    expect(chineseReadme).toContain("生命周期结束不等于任务成功");
    expect(chineseReadme).toContain("GitHub Copilot CLI");
    expect(chineseReadme).toContain("仅观察");
    expect(chineseReadme).toContain("不会自动修改任何排序阈值或权重");
    expect(chineseReadme).toContain("skill-steward govern quarantine");
    expect(chineseReadme).toContain("skill-steward evidence erase");
    expect(chineseReadme).not.toContain("托管的原生提示词 Hook 目前只覆盖 Codex 和 Claude Code");
    expect(chineseReadme).not.toMatch(/通用 Hook 支持|支持自动安装|无须确认即可安装|保证安全|将任务发送到目录|托管 Registry|Copilot 自动注入/i);
    for (const screenshot of chineseScreenshots) expect(chineseReadme).toContain(screenshot);
    for (const screenshot of englishScreenshots) expect(chineseReadme).not.toContain(screenshot);
    await expectLocalLinksToExist("README.zh-CN.md", chineseReadme);
  });

  it("ships full-size localized screenshots", async () => {
    for (const screenshot of [...englishScreenshots, ...chineseScreenshots]) {
      const bytes = await readFile(join(root, "docs/images", screenshot));
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(900);
      expect(bytes.readUInt32BE(20)).toBeGreaterThanOrEqual(700);
    }
  });

  it("keeps internal planning references out of the public documentation tree", async () => {
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).not.toContain("OpenSpec");
    expect(changelog).toContain("## [0.4.0-alpha.1]");
    expect(changelog).toContain("privacy-safe recommendation evidence");
    expect(changelog).toContain("reversible quarantine and restore");
    const architecture = await readFile(join(root, "docs/architecture.md"), "utf8");
    expect(architecture).toContain("packages/preflight");
    expect(architecture).toContain("preflights.json");
    expect(architecture).toContain("packages/catalog");
    expect(architecture).toContain("packages/integrations");
    expect(architecture).toContain("packages/evidence");
    expect(architecture).toContain("packages/governance");
    expect(architecture).toContain("evidence-events.jsonl");
    expect(architecture).toContain("governance.jsonl");
    expect(architecture).toContain("observe-only");
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
