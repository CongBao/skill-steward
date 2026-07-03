import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const englishScreenshots = [
  "overview-light-en.png",
  "preflight-discovery-light-en.png",
  "evidence-light-en.png",
  "governance-dark-en.png"
];
const chineseScreenshots = [
  "overview-light-zh-CN.png",
  "preflight-discovery-light-zh-CN.png",
  "evidence-light-zh-CN.png",
  "governance-dark-zh-CN.png"
];
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
  "docs/product-review-2026-07-03.md",
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
      "## Three jobs",
      "## Screenshots",
      "## Installation",
      "## First use",
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
    expect(readme).toContain(
      "Know which Agent Skills you have, which ones a task needs, and change them safely."
    );
    expect(readme).toContain(
      "a local companion for Codex, Claude Code, GitHub Copilot, and other coding Harnesses"
    );
    expect(readme).toContain("It is not a Harness");
    expect(readme.indexOf("## Three jobs")).toBeLessThan(readme.indexOf("## Screenshots"));
    expect(readme.indexOf("## Screenshots")).toBeLessThan(readme.indexOf("## First use"));
    expect(readme).toContain("skill-steward preflight");
    expect(readme).toContain("raw task text is never written to disk");
    expect(readme).not.toContain("cross-Harness control plane");
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
    for (const command of [
      "skill-steward install --plan <id> --confirm",
      "skill-steward integrate apply --plan <id> --confirm",
      "skill-steward evidence policy set --plan <id> --confirm",
      "skill-steward evidence erase --plan <id> --confirm",
      "skill-steward govern quarantine --plan <id> --confirm",
      "skill-steward govern restore --plan <id> --confirm"
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toMatch(/initial scan[^.]*cached portfolio/i);
    expect(readme).toMatch(/readiness scan[^.]*rolls back/i);
    expect(readme).toMatch(/busy[^.]*does not consume[^.]*reviewed plan/i);
    expect(readme).toContain("THIRD_PARTY_NOTICES.txt");
    expect(readme).toContain("runtime-audit.json");
    expect(readme).toMatch(/real npm and pnpm tarballs/i);
    expect(readme).toContain("Status: active alpha");
    expect(readme).toContain("managed integration setup");
    expect(readme).not.toContain("or integration change");
    expect(readme).toMatch(
      /A busy integration apply[^.]*does not consume its reviewed plan/i
    );
    expect(readme).toMatch(
      /Installation apply and rollback share one state-scoped cross-process lease/i
    );
    expect(readme).toMatch(/A busy removal[^.]*before changing files/i);
    expect(readme).toMatch(
      /CLI installation, integration apply, evidence-policy, evidence-erasure, quarantine, and restore plans are persisted privately, expire, and are single-use/
    );
    expect(readme).not.toContain("Managed native prompt Hooks are available only for Codex and Claude Code");
    expect(readme).not.toMatch(/status:\s*beta|beta-ready|complete native plugin (?:coverage|inventory)|universal Hook support|supports automatic installation|automatically installs recommendations|guaranteed safe|sends task to (?:the )?catalog|hosted registry|Copilot automatic prompt injection/i);
    for (const screenshot of englishScreenshots) expect(readme).toContain(screenshot);
    for (const screenshot of chineseScreenshots) expect(readme).not.toContain(screenshot);
    await expectLocalLinksToExist("README.md", readme);
  });

  it("ships a complete Chinese README with mutual language navigation", async () => {
    const chineseReadme = await readFile(join(root, "README.zh-CN.md"), "utf8");
    for (const heading of [
      "## 它主要做三件事",
      "## 界面截图",
      "## 安装",
      "## 第一次使用",
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
    expect(chineseReadme).toContain("先看清、再选择、最后安全地改变你的 Agent Skills。");
    expect(chineseReadme).toContain("Codex、Claude Code、GitHub Copilot");
    expect(chineseReadme).toContain("它不是 Harness");
    expect(chineseReadme.indexOf("## 它主要做三件事")).toBeLessThan(
      chineseReadme.indexOf("## 界面截图")
    );
    expect(chineseReadme.indexOf("## 界面截图")).toBeLessThan(
      chineseReadme.indexOf("## 第一次使用")
    );
    expect(chineseReadme).toContain("skill-steward preflight");
    expect(chineseReadme).toContain("原始任务文本不会写入磁盘");
    expect(chineseReadme).not.toContain("跨 Harness 控制平面");
    expect(chineseReadme).toContain("立即使用");
    expect(chineseReadme).toContain("建议安装");
    expect(chineseReadme).toContain("Codex 和 Claude Code 的 `UserPromptSubmit` 与结束 Hook");
    expect(chineseReadme).toContain("任务提交时不访问网络");
    expect(chineseReadme).toContain("绝不会自动安装推荐项");
    expect(chineseReadme).toContain("任务开始前发现外部候选项");
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
    for (const command of [
      "skill-steward install --plan <id> --confirm",
      "skill-steward integrate apply --plan <id> --confirm",
      "skill-steward evidence policy set --plan <id> --confirm",
      "skill-steward evidence erase --plan <id> --confirm",
      "skill-steward govern quarantine --plan <id> --confirm",
      "skill-steward govern restore --plan <id> --confirm"
    ]) {
      expect(chineseReadme).toContain(command);
    }
    expect(chineseReadme).toMatch(/首次扫描[^。]*缓存[^。]*资产/);
    expect(chineseReadme).toMatch(/就绪扫描[^。]*回滚/);
    expect(chineseReadme).toMatch(/忙碌[^。]*不会消耗[^。]*计划/);
    expect(chineseReadme).toContain("THIRD_PARTY_NOTICES.txt");
    expect(chineseReadme).toContain("runtime-audit.json");
    expect(chineseReadme).toMatch(/npm 和 pnpm[^。]*真实 tarball/);
    expect(chineseReadme).toContain("当前状态：活跃 Alpha");
    expect(chineseReadme).toContain("新增 Harness 集成");
    expect(chineseReadme).toMatch(/新增集成遇到忙碌[^。]*不会消耗[^。]*计划/);
    expect(chineseReadme).toMatch(/安装、回滚和 Harness 集成共用同一把状态级跨进程锁/);
    expect(chineseReadme).toMatch(/移除集成遇到忙碌[^。]*改写配置之前停止/);
    expect(chineseReadme).toMatch(
      /CLI 的安装、集成应用、证据策略、证据清除、隔离和恢复计划保存在私有目录、会过期且只能使用一次/
    );
    expect(chineseReadme).not.toContain("托管的原生提示词 Hook 目前只覆盖 Codex 和 Claude Code");
    expect(chineseReadme).not.toMatch(/当前状态：\s*Beta|Beta 就绪|完整(?:的)?原生插件(?:覆盖|盘点)|通用 Hook 支持|支持自动安装|无须确认即可安装|保证安全|将任务发送到目录|托管 Registry|Copilot 自动注入/i);
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

  it("rebuilds workspace dependencies before creating a CLI package", async () => {
    const packageJson = JSON.parse(
      await readFile(join(root, "packages/cli/package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepack).toContain('skill-steward^...');
    expect(packageJson.scripts?.prepack).toContain("pnpm build");
  });

  it("ships focused package onboarding and the exact project license", async () => {
    const packageReadme = await readFile(join(root, "packages/cli/README.md"), "utf8");
    expect(packageReadme).toContain("# Skill Steward");
    expect(packageReadme).toContain("## Five-minute start");
    expect(packageReadme).toContain("skill-steward scan");
    expect(packageReadme).toContain("skill-steward preflight");
    expect(packageReadme).toContain("skill-steward dashboard");
    expect(packageReadme).toContain("local-first");
    expect(packageReadme).toContain("reversible");
    expect(packageReadme).toContain("--plan <id> --confirm");
    expect(packageReadme).toContain("integration apply");
    expect(packageReadme).toContain(
      "skill-steward integrate remove --harness <id> --confirm"
    );
    expect(packageReadme).not.toMatch(/contract applies to integration,/);
    expect(packageReadme).toContain("THIRD_PARTY_NOTICES.txt");
    expect(packageReadme).toContain("runtime-audit.json");
    expect(packageReadme).toMatch(/real npm and pnpm tarballs/i);
    expect(packageReadme).toContain("Alpha");
    expect(packageReadme).toContain("not a Harness");
    expect(packageReadme).not.toContain("OpenSpec");
    expect(await readFile(join(root, "packages/cli/LICENSE"), "utf8"))
      .toBe(await readFile(join(root, "LICENSE"), "utf8"));
    await expect(access(join(
      root,
      "packages/cli/tests/verify-packed-artifact.mjs"
    ))).resolves.toBeUndefined();
  });

  it("verifies dry-run and real packed artifacts in clean-checkout CI", async () => {
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("npm pack --dry-run --ignore-scripts --json");
    expect(workflow).toContain("npm pack --ignore-scripts --json --pack-destination ../../artifacts/npm");
    expect(workflow).toContain("verify-packed-artifact.mjs");
    expect(workflow).toContain("artifacts/npm/skill-steward-");
    expect(workflow).toContain("artifacts/pnpm/skill-steward-");
    expect(workflow).toContain("windows-smoke:");
  });

  it("keeps runtime audit updates explicit and outside normal build and CI", async () => {
    const packageJson = JSON.parse(
      await readFile(join(root, "packages/cli/package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["runtime-audit:update"]).toContain("--update-runtime-audit");
    const packageReadme = await readFile(join(root, "packages/cli/README.md"), "utf8");
    expect(packageReadme).toMatch(/generated full runtime (?:lock|bundle audit)/i);
    expect(packageReadme).toContain("runtime-audit:update");
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).not.toContain("--update-runtime-audit");
  });

  it("states the local filesystem threat boundary without weakening symlink defenses", async () => {
    const security = await readFile(join(root, "SECURITY.md"), "utf8");
    expect(security).toContain("same operating-system user");
    expect(security).toContain("not an isolation boundary");
    expect(security).toContain("must not share write access");
    expect(security).toContain("static symbolic links");
    expect(security).toContain("post-preview ancestor symlink or non-directory drift");
    expect(security).not.toContain("post-preview destination-ancestor drift");
  });

  it("keeps internal planning references out of the public documentation tree", async () => {
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).not.toContain("OpenSpec");
    expect(changelog).toContain("## [0.5.0-alpha.3] - 2026-07-03");
    expect(changelog).toMatch(/exact, single-use reviewed plans/i);
    expect(changelog).toMatch(
      /CLI installation, governance, integration apply, evidence-policy, and evidence-erasure/
    );
    expect(changelog).toMatch(/initial portfolio scan/i);
    expect(changelog).toMatch(/npm and pnpm tarballs/i);
    expect(changelog).toContain("## [0.5.0-alpha.2]");
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
    expect(architecture).toContain("Preflight algorithm v4");
    expect(architecture).toContain("explicit CLI feedback command");
    expect(architecture).toContain("reviewed-plans/");
    expect(architecture).toContain("staging/");
    expect(architecture).toContain("integration-records/");
    expect(architecture).toContain("integration-mutation.lease");
    expect(architecture).toMatch(/raw evidence[^.]*attribution/i);
    expect(architecture).toContain("THIRD_PARTY_NOTICES.txt");
    expect(architecture).toContain("runtime-audit.json");
    expect(architecture).toMatch(
      /New apply and remove records are written to `integration-records\/`/
    );
    expect(architecture).toMatch(
      /Integration apply acquires `integration-mutation\.lease` before claiming a reviewed plan/
    );
    expect(architecture).toMatch(
      /Integration remove, installation apply, and installation rollback acquire that same physical lease/
    );
    expect(architecture).toMatch(/rechecks the destination immediately before backup and replacement/);
    expect(architecture).not.toMatch(/record fingerprints in `integrations\.json`/);
    expect(architecture).toMatch(/CLI installation, integration apply, evidence-policy/);
    expect(architecture).not.toMatch(/OpenSpec|Superpowers/);

    const alphaTesting = await readFile(join(root, "docs/alpha-testing.md"), "utf8");
    expect(alphaTesting).toContain("0.5.0-alpha.3");
    expect(alphaTesting).toContain("--plan <id> --confirm");
    expect(alphaTesting).toContain("## Alpha.3 test matrix");
    expect(alphaTesting).toMatch(/busy[^.]*does not consume[^.]*plan/i);
    expect(alphaTesting).toMatch(/readiness scan[^.]*rolls back/i);
    expect(alphaTesting).toContain("THIRD_PARTY_NOTICES.txt");
    expect(alphaTesting).toContain("runtime-audit.json");
    expect(alphaTesting).toMatch(/npm and pnpm tarballs/i);
    expect(alphaTesting).toMatch(/same operating-system user/i);
    expect(alphaTesting).toContain("## Reviewed installation concurrency");
    expect(alphaTesting).toMatch(/Exactly one process must succeed/);
    expect(alphaTesting).not.toMatch(/OpenSpec|Superpowers|status:\s*beta/i);
    for (const command of [
      "CI=true pnpm --filter skill-steward exec vitest run tests/repository.test.ts tests/binary.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/install.test.ts tests/govern.test.ts tests/evidence.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/integrate.test.ts tests/integrate-process.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/package.test.ts tests/runtime-audit.test.mjs tests/verifier.test.mjs",
      "CI=true pnpm --filter skill-steward exec vitest run tests/binary.test.ts"
    ]) {
      expect(alphaTesting).toContain(command);
    }
    expect(alphaTesting).not.toContain("pnpm --filter skill-steward test -- tests/");
    expect(alphaTesting.indexOf(
      "pnpm --filter skill-steward pack --pack-destination artifacts/pnpm"
    )).toBeLessThan(alphaTesting.indexOf(
      "npm pack --ignore-scripts --json --pack-destination ../../artifacts/npm"
    ));

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    for (const privateDirectory of [
      ".superpowers/",
      ".codex/",
      "openspec/",
      "docs/superpowers/"
    ]) {
      expect(gitignore.split("\n")).toContain(privateDirectory);
    }
    const internalEntries = await readdir(join(root, "docs/superpowers"), {
      recursive: true,
      withFileTypes: true
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(internalEntries.filter((entry) => entry.isFile())).toEqual([]);
  });

  it("records the real product review, evidence, priorities, and accepted gaps", async () => {
    const review = await readFile(join(root, "docs/product-review-2026-07-03.md"), "utf8");
    for (const evidence of [
      "global 0.4.0-alpha.1",
      "repository 0.5.0-alpha.1",
      "clean first run",
      "25-Skill portfolio",
      "17 available candidates",
      "Codex, Claude Code, and GitHub Copilot CLI",
      "quarantine and restore",
      "720 px",
      "1600 px",
      "866 px",
      "1100 px",
      "1280 px"
    ]) {
      expect(review).toContain(evidence);
    }
    for (const finding of [
      "empty scanned portfolio reported health 100",
      "PDF task selected docx",
      "this / does / missing",
      "one-word project-scope false positive",
      "findings omitted the affected Skill",
      "governance output exposed hashes",
      "synthetic KPI value 92",
      "no CLI path for Preflight feedback",
      "native plugin Skill blind spot",
      "lifecycle completion is not task success"
    ]) {
      expect(review).toContain(finding);
    }
    expect(review).toContain("## Changes implemented after the baseline");
    expect(review).toContain("## Accepted future gaps");
    expect(review).toContain("## Product scores");
    expect(review).toContain("## Repeat-use verdict");
    expect(review).toContain("### P0");
    expect(review).toContain("### P1");
    expect(review).toContain("### P2");
    expect(review).toContain("### P3");
  });
});
