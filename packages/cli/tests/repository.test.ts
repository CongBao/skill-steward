import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const englishScreenshots = [
  "overview-light-en.png",
  "preflight-discovery-light-en.png",
  "evidence-light-en.png",
  "governance-dark-en.png",
  "integrations-dark-en.png"
];
const chineseScreenshots = [
  "overview-light-zh-CN.png",
  "preflight-discovery-light-zh-CN.png",
  "evidence-light-zh-CN.png",
  "governance-dark-zh-CN.png",
  "integrations-dark-zh-CN.png"
];
const englishLandingScreenshots = [
  "overview-light-en.png",
  "preflight-discovery-light-en.png",
  "governance-dark-en.png"
] as const;
const chineseLandingScreenshots = [
  "overview-light-zh-CN.png",
  "preflight-discovery-light-zh-CN.png",
  "governance-dark-zh-CN.png"
] as const;
const englishSlogans = [
  "Know your Skills. Choose what matters. Change with confidence.",
  "One local operations layer for Agent Skills across Codex, Claude Code, and GitHub Copilot CLI.",
  "See the portfolio. Preflight the task. Review every change."
] as const;
const chineseSlogans = [
  "看清你的 Skills，只选真正有用的，放心完成每次变更。",
  "统一管理 Codex、Claude Code 和 GitHub Copilot CLI 中的 Agent Skills。",
  "盘点资产，预检任务，审核变更。"
] as const;
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
  "docs/release-contract.md",
  "docs/cli-publication.md",
  "release-contract.json",
  "docs/product-review-2026-07-03.md",
  ...englishScreenshots.map((name) => `docs/images/${name}`),
  ...chineseScreenshots.map((name) => `docs/images/${name}`)
];
const inventoryTaxonomies = {
  source: [
    "scanned",
    "missing",
    "unreadable",
    "invalid",
    "disabled",
    "stale",
    "ambiguous",
    "truncated"
  ],
  coverage: ["verified", "partial", "unavailable", "convention-only"],
  exposure: ["effective", "shadowed", "inactive", "ambiguous"]
} as const;

function expectTaxonomyLine(
  markdown: string,
  label: string,
  expected: readonly string[]
): void {
  const line = markdown.split("\n").find((candidate) => candidate.includes(label));
  expect(line, `missing ${label} taxonomy`).toBeDefined();
  expect(
    [...(line ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    label
  ).toEqual(expected);
}

function expectInventoryTaxonomies(
  markdown: string,
  labels: { source: string; coverage: string; exposure: string } = {
    source: "Source statuses:",
    coverage: "Harness coverage:",
    exposure: "Skill exposure:"
  }
): void {
  expectTaxonomyLine(markdown, labels.source, inventoryTaxonomies.source);
  expectTaxonomyLine(markdown, labels.coverage, inventoryTaxonomies.coverage);
  expectTaxonomyLine(markdown, labels.exposure, inventoryTaxonomies.exposure);
}

function markdownSection(markdown: string, start: string, end: string): string {
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end, from + start.length);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing section ${end}`).toBeGreaterThan(from);
  return markdown.slice(from, to);
}

function shellCommandLines(markdown: string): string[] {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/gu)]
    .flatMap((match) => (match[1] ?? "").trim().split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/--task\s+"[^"]+"/u, '--task "<task>"'));
}

function nonBlankMarkdownLines(markdown: string): number {
  return markdown.split("\n").filter((line) => line.trim().length > 0).length;
}

function markdownImages(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(docs\/images\/([^)]+)\)/gu)]
    .map((match) => match[1] as string);
}

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

  it("keeps one explicit Beta candidate contract without implicit sync or publication", async () => {
    const contract = JSON.parse(await readFile(join(root, "release-contract.json"), "utf8")) as {
      version: string; channel: string; npmTag: string; githubPrerelease: boolean; packages: unknown[];
    };
    expect(contract).toMatchObject({
      version: "0.5.0-beta.1",
      channel: "beta",
      npmTag: "beta",
      githubPrerelease: true
    });
    expect(contract.packages).toHaveLength(7);

    const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(workspace.scripts?.["release:check"]).toBe("node scripts/release-contract.mjs check");
    expect(workspace.scripts?.["release:sync"]).toBe("node scripts/release-contract.mjs sync");
    expect(workspace.scripts?.check).toMatch(/^pnpm release:check &&/u);
    expect(workspace.scripts?.build).not.toContain("release:sync");
    expect(workspace.scripts?.test).not.toContain("release:sync");

    const cli = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(cli.scripts?.prepack).not.toContain("release:sync");

    const guide = await readFile(join(root, "docs/release-contract.md"), "utf8");
    expect(guide).toContain("pnpm release:check");
    expect(guide).toContain("pnpm release:sync");
    expect(guide).toContain("does not publish anything");

    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toContain("Status: Beta release candidate 0.5.0-beta.1");
    expect(readme).toContain("The Skill Steward CLI is not published to npm");
    expect(readme).not.toMatch(/npm install --global skill-steward|npm package is (?:now )?available|downloads? badge/iu);
  });

  it("documents protected CLI publication without claiming that npm is already available", async () => {
    const guide = await readFile(join(root, "docs/cli-publication.md"), "utf8");
    expect(guide).toContain("Native packages come first");
    expect(guide).toContain("cli-publish");
    expect(guide).toContain("NPM_BOOTSTRAP_TOKEN");
    expect(guide).toContain("cli-package-publication.yml");
    expect(guide).toContain("trusted publishing");
    expect(guide).toContain("Linux, macOS, and Windows");
    expect(guide).toContain("byte-identical");
    expect(guide).toContain("does not publish anything");

    for (const readmePath of ["README.md", "README.zh-CN.md"]) {
      const readme = await readFile(join(root, readmePath), "utf8");
      expect(readme).toMatch(/(?:CLI[^\n]*not published to npm|CLI[^\n]*尚未发布到 npm)/iu);
      expect(readme).not.toMatch(/npm install (?:--global|-g) skill-steward/u);
    }
  });

  it("ships a concise English product landing page with valid local links", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(nonBlankMarkdownLines(readme)).toBeLessThanOrEqual(160);
    for (const heading of [
      "## Three jobs",
      "## The Skill Steward loop",
      "## Product views",
      "## Local installation",
      "## First use",
      "## Verified support",
      "## Current boundaries",
      "## Learn more"
    ]) {
      expect(readme).toContain(heading);
    }
    expect(readme).toContain("[简体中文](README.zh-CN.md)");
    expect(readme).not.toContain("not a design mockup or a real user's portfolio");
    expect(readme).not.toContain("OpenSpec");
    const firstScreen = readme.slice(0, readme.indexOf("## Three jobs"));
    for (const slogan of englishSlogans) expect(firstScreen).toContain(slogan);
    expect(readme).toContain("Codex, Claude Code, and GitHub Copilot CLI");
    expect(firstScreen).toMatch(/does not replace your Harness/i);
    expect(firstScreen).toMatch(/local and deterministic/i);
    expect(firstScreen).toMatch(/does not call an LLM/i);
    expect(firstScreen).toContain("Status: Beta release candidate 0.5.0-beta.1");
    expect(firstScreen).toContain("The Skill Steward CLI is not published to npm");
    expect(firstScreen).toMatch(/local manual testing/i);
    expect(readme.indexOf("## Three jobs")).toBeLessThan(readme.indexOf("## Product views"));
    expect(readme.indexOf("## Product views")).toBeLessThan(readme.indexOf("## First use"));
    expect(readme).toContain("skill-steward preflight");
    expect(readme).toContain("Use now");
    expect(readme).toContain("Consider installing");
    expect(readme).not.toMatch(/status:\s*beta(?:\s+(?:is\s+)?(?:public|available|ready)|[.!]\s*$)|beta-ready|complete native plugin (?:coverage|inventory)|universal Hook support|supports automatic installation|automatically installs recommendations|guaranteed safe|sends task to (?:the )?catalog|hosted registry|Copilot automatic prompt injection/im);
    expect(markdownImages(readme)).toEqual([...englishLandingScreenshots]);
    for (const screenshot of chineseScreenshots) expect(readme).not.toContain(screenshot);
    for (const detail of ["NPM_BOOTSTRAP_TOKEN", "schema v", "recovery-required", "Microsoft APM"]) {
      expect(readme).not.toContain(detail);
    }
    await expectLocalLinksToExist("README.md", readme);
  });

  it("documents one coherent packaged first-value command path in both locales", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const chineseReadme = await readFile(join(root, "README.zh-CN.md"), "utf8");
    const installation = markdownSection(readme, "## Local installation", "## First use");
    const chineseInstallation = markdownSection(chineseReadme, "## 本地安装", "## 第一次使用");
    const firstUse = markdownSection(readme, "## First use", "## Verified support");
    const chineseFirstUse = markdownSection(chineseReadme, "## 第一次使用", "## 已验证的支持范围");

    expect(installation).not.toContain("pnpm check");
    expect(chineseInstallation).not.toContain("pnpm check");
    expect(await readFile(join(root, "CONTRIBUTING.md"), "utf8")).toContain("pnpm check");
    expect(shellCommandLines(chineseInstallation)).toEqual(shellCommandLines(installation));
    expect(shellCommandLines(chineseFirstUse)).toEqual(shellCommandLines(firstUse));

    const journey = `${installation}\n${firstUse}`;
    for (const command of [
      "pnpm candidate:install",
      "skill-steward --version",
      "skill-steward scan",
      "skill-steward preflight",
      "--harness codex",
      "skill-steward dashboard"
    ]) {
      expect(journey).toContain(command);
    }
    expect(installation).not.toContain("mkdir -p artifacts");
    expect(journey.indexOf("pnpm candidate:install"))
      .toBeLessThan(journey.indexOf("skill-steward scan"));
  });

  it("ships a concise natural-Chinese product landing page", async () => {
    const chineseReadme = await readFile(join(root, "README.zh-CN.md"), "utf8");
    expect(nonBlankMarkdownLines(chineseReadme)).toBeLessThanOrEqual(160);
    for (const heading of [
      "## 它主要做三件事",
      "## Skill Steward 的闭环",
      "## 产品界面",
      "## 本地安装",
      "## 第一次使用",
      "## 已验证的支持范围",
      "## 当前边界",
      "## 更多资料"
    ]) {
      expect(chineseReadme).toContain(heading);
    }
    expect(chineseReadme).toContain("[English](README.md)");
    expect(chineseReadme).not.toContain("并非设计稿");
    expect(chineseReadme).not.toContain("OpenSpec");
    const firstScreen = chineseReadme.slice(0, chineseReadme.indexOf("## 它主要做三件事"));
    for (const slogan of chineseSlogans) expect(firstScreen).toContain(slogan);
    expect(chineseReadme).toContain("Codex、Claude Code 和 GitHub Copilot CLI");
    expect(firstScreen).toContain("不会取代 Harness");
    expect(firstScreen).toContain("本地、确定性");
    expect(firstScreen).toContain("不会调用 LLM");
    expect(firstScreen).toContain("当前状态：Beta 发布候选版 0.5.0-beta.1");
    expect(firstScreen).toContain("Skill Steward CLI 尚未发布到 npm");
    expect(firstScreen).toContain("本地人工测试");
    expect(chineseReadme.indexOf("## 它主要做三件事")).toBeLessThan(
      chineseReadme.indexOf("## 产品界面")
    );
    expect(chineseReadme.indexOf("## 产品界面")).toBeLessThan(
      chineseReadme.indexOf("## 第一次使用")
    );
    expect(chineseReadme).toContain("skill-steward preflight");
    expect(chineseReadme).toContain("立即使用");
    expect(chineseReadme).toContain("建议安装");
    expect(chineseReadme).not.toMatch(/当前状态：\s*Beta(?:\s*(?:已公开|已就绪)|[。！]\s*$)|Beta 就绪|完整(?:的)?原生插件(?:覆盖|盘点)|通用 Hook 支持|支持自动安装|无须确认即可安装|保证安全|将任务发送到目录|托管 Registry|Copilot 自动注入/im);
    expect(markdownImages(chineseReadme)).toEqual([...chineseLandingScreenshots]);
    for (const screenshot of englishScreenshots) expect(chineseReadme).not.toContain(screenshot);
    for (const detail of ["NPM_BOOTSTRAP_TOKEN", "schema v", "recovery-required", "Microsoft APM"]) {
      expect(chineseReadme).not.toContain(detail);
    }
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
    expect(packageReadme).toContain("skill-steward --version");
    expect(packageReadme).toContain("--harness codex");
    expect(packageReadme.indexOf("pnpm candidate:install"))
      .toBeLessThan(packageReadme.indexOf("skill-steward scan"));
    expect(packageReadme).toContain("local-first");
    expect(packageReadme).toContain("reversible");
    expect(packageReadme).toContain("--plan <id> --confirm");
    expect(packageReadme).toMatch(/transactionally publishes the companion, Hook configuration, readiness report, and history record/i);
    expect(packageReadme).toContain(
      "skill-steward integrate remove --harness <id>"
    );
    expect(packageReadme).toMatch(/removes only the exact recorded tree/i);
    expect(packageReadme).toContain("skill-steward integrate apply --plan <id> --confirm");
    expect(packageReadme).toContain("THIRD_PARTY_NOTICES.txt");
    expect(packageReadme).toContain("runtime-audit.json");
    expect(packageReadme).toMatch(/real npm and pnpm tarballs/i);
    expect(packageReadme).toContain("0.5.0-beta.1 prerelease package");
    expect(packageReadme).not.toMatch(/has not (?:been )?published|not public yet/i);
    expect(packageReadme).toContain("not a Harness");
    expect(packageReadme).not.toContain("OpenSpec");
    expect(await readFile(join(root, "packages/cli/LICENSE"), "utf8"))
      .toBe(await readFile(join(root, "LICENSE"), "utf8"));
    await expect(access(join(
      root,
      "scripts/verify-cli-package.mjs"
    ))).resolves.toBeUndefined();
  });

  it("verifies dry-run and real packed artifacts in clean-checkout CI", async () => {
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("npm pack --dry-run --ignore-scripts --json");
    expect(workflow).toContain("npm pack --ignore-scripts --json --pack-destination ../../artifacts/npm");
    expect(workflow).toContain("verify-cli-package.mjs");
    expect(workflow).toContain("artifacts/npm/skill-steward-");
    expect(workflow).toContain("artifacts/pnpm/skill-steward-");
    expect(workflow).toContain("windows-security:");
    expect(workflow).toContain("macos-security:");
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
    expect(changelog).toContain("## [0.5.0-alpha.4] - 2026-07-04");
    expect(changelog).toContain("native inventory adapters");
    expectInventoryTaxonomies(changelog);
    expect(changelog).toContain("Preflight algorithm v7 and result schema v4");
    expect(changelog).toMatch(/Preflight algorithm v8[^.]*corroborated lifecycle trigger/i);
    expect(changelog).toMatch(/Preflight algorithm v9[^.]*result schema v5/i);
    expect(changelog).toMatch(/28-case synthetic benchmark/i);
    expect(changelog).toMatch(/high-confidence capability-gap search hints/i);
    expect(changelog).toMatch(/gap-only canonical namespace[^.]*negative usage clauses/i);
    expect(changelog).toMatch(/generic single-token names[^.]*corroborat/i);
    expect(changelog).toContain("--compact-json");
    expect(changelog).toContain("read-only in Skill Steward governance");
    expect(changelog).toContain("current-workspace snapshot plus user scopes");
    expect(changelog).toContain("jsonc-parser@3.3.1");
    expect(changelog).toContain("smol-toml@1.7.0");
    expect(changelog).toContain("marked");
    expect(changelog).toMatch(/reports and (?:the )?dashboard preserve native[^.]*ownership[^.]*plugin[^.]*exposure records/i);
    expect(changelog).toMatch(/Preflight consumes resolved visibility[^.]*reason codes and inventory warnings/i);
    expect(changelog).toContain("Across the total 30 Harnesses");
    expect(changelog).not.toMatch(/remaining 30-Harness|Preflight and report surfaces preserve native/i);
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
    expect(architecture).toContain("Preflight algorithm v9 / schema v5");
    expect(architecture).toMatch(/versioned capability evidence/i);
    expect(architecture).toMatch(/actions, objects, and local action-object pairs/i);
    expect(architecture).toMatch(/candidate-corroborated capability-gap search hints/i);
    expect(architecture).toMatch(/greedy selection tracks uncovered task capabilities/i);
    expect(architecture).toMatch(/broad object[^.]*cannot/i);
    expect(architecture).toContain("native inventory and visibility resolver");
    expectInventoryTaxonomies(architecture);
    expect(architecture).toContain("Across the total 30 Harnesses");
    expect(architecture).toContain("current-workspace snapshot plus user scopes");
    expect(architecture).toContain("does not crawl every project or workspace");
    expect(architecture).toContain("--compact-json");
    expect(architecture).toContain("4,096 UTF-8 bytes");
    expect(architecture).toContain("selected use/install recommendations");
    expect(architecture).toContain("Full result schema v5");
    expect(architecture).toContain("catalog `source` metadata");
    expect(architecture).toMatch(/does not (?:embed|include)[^.]*native inventory[^.]*ownership[^.]*plugin[^.]*exposure records/i);
    expect(architecture).toMatch(/reports and (?:the )?dashboard[^.]*preserve/i);
    expect(architecture).toMatch(/candidate reason codes and inventory warnings/i);
    expect(architecture).toContain("2,048 bytes");
    expect(architecture).not.toContain("stale/error status");
    expect(architecture).toContain("explicit CLI feedback command");
    expect(architecture).toContain("reviewed-plans/");
    expect(architecture).toContain("staging/");
    expect(architecture).toContain("integration-records/");
    expect(architecture).toContain("integration-mutation.lease");
    expect(architecture).toMatch(/raw evidence[^.]*attribution/i);
    expect(architecture).toContain("THIRD_PARTY_NOTICES.txt");
    expect(architecture).toContain("runtime-audit.json");
    expect(architecture).toMatch(/Public integration apply acquires `integration-mutation\.lease`/i);
    expect(architecture).toMatch(/revalidates[^.]*packaged source[^.]*consumer set/i);
    expect(architecture).not.toMatch(/Successful apply persists an initial portfolio report/i);
    expect(architecture).toMatch(/rechecks the destination immediately before backup and replacement/);
    expect(architecture).not.toMatch(/record fingerprints in `integrations\.json`/);
    expect(architecture).toMatch(/CLI installation, evidence-policy, evidence-erasure/);
    expect(architecture).toMatch(/Integration apply and disconnect[^.]*bind the Harness/i);
    expect(architecture).not.toMatch(/OpenSpec|Superpowers/);

    const alphaTesting = await readFile(join(root, "docs/alpha-testing.md"), "utf8");
    expectInventoryTaxonomies(alphaTesting);
    expect(alphaTesting).toContain("release-contract.json");
    expect(alphaTesting).toContain("pnpm release:check");
    expect(alphaTesting).toContain("--plan <id> --confirm");
    expect(alphaTesting).toContain("## Current test matrix");
    expect(alphaTesting).toMatch(/create\/upgrade\/no-op\/disconnect[^;]*same recoverable coordinator/i);
    expect(alphaTesting).toContain("inject final readiness publication failure");
    expect(alphaTesting).toContain("Both must return to their exact before state");
    expect(alphaTesting).toContain("THIRD_PARTY_NOTICES.txt");
    expect(alphaTesting).toContain("runtime-audit.json");
    expect(alphaTesting).toMatch(/npm and pnpm tarballs/i);
    expect(alphaTesting).toMatch(/same operating-system user/i);
    expect(alphaTesting).toContain("## Reviewed installation concurrency");
    expect(alphaTesting).toMatch(/Exactly one process must succeed/);
    expect(alphaTesting).toMatch(/low-confidence two-character fragments[^.]*empty/i);
    expect(alphaTesting).toMatch(/negative clauses[^.]*neither lexical nor capability evidence/i);
    expect(alphaTesting).toMatch(/generic exact names[^.]*empty gap list/i);
    expect(alphaTesting).toContain("Algorithm v9/result schema v5");
    expect(alphaTesting).toContain("compact schema v4");
    expect(alphaTesting).toContain("96.3% precision");
    expect(alphaTesting).toContain("zero negative-control false positives");
    expect(alphaTesting).toMatch(/phase-checklist[^.]*documentation-review/i);
    expect(alphaTesting).toMatch(/Do not review before merge[^.]*positive lifecycle trigger/i);
    expect(alphaTesting).not.toMatch(/OpenSpec|Superpowers|status:\s*beta/i);
    for (const command of [
      "CI=true pnpm --filter skill-steward exec vitest run tests/repository.test.ts tests/binary.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/install.test.ts tests/govern.test.ts tests/evidence.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/integrate.test.ts tests/integrate-process.test.ts",
      "CI=true pnpm --filter skill-steward exec vitest run tests/package.test.ts tests/runtime-audit.test.mjs tests/verifier.test.mjs",
      "CI=true pnpm --filter skill-steward exec vitest run tests/binary.test.ts",
      "CI=true pnpm --filter @skill-steward/engine exec vitest run tests/codex-inventory.test.ts tests/claude-inventory.test.ts tests/copilot-inventory.test.ts tests/inventory-workspace.test.ts tests/visibility-resolution.test.ts",
      "CI=true pnpm test:preflight-quality",
      "CI=true pnpm --filter skill-steward exec vitest run tests/govern.test.ts tests/preflight.test.ts"
    ]) {
      expect(alphaTesting).toContain(command);
    }
    for (const coverage of [
      "native adapter coverage",
      "compact handoff",
      "bilingual decision parity",
      "native governance refusal",
      "current-workspace snapshot limitation"
    ]) {
      expect(alphaTesting).toContain(coverage);
    }
    expect(alphaTesting).toContain("Across the total 30 Harnesses");
    expect(alphaTesting).toMatch(/Copilot Harness coverage[^.]*`partial`/i);
    expect(alphaTesting).toMatch(/source or Skill exposure[^.]*`ambiguous`/i);
    expect(alphaTesting).toContain("complete `PreflightResult`");
    expect(alphaTesting).toContain("catalog `source` metadata");
    expect(alphaTesting).toMatch(/not native inventory ownership, plugin, source, or exposure records/i);
    expect(alphaTesting).toMatch(/reason codes and inventory warnings/i);
    expect(alphaTesting).not.toMatch(
      /source status(?:es)?[^\n]*`partial`|planned source[^\n.]*`partial`/i
    );
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

    for (const [path, source] of [
      ["README.md", await readFile(join(root, "README.md"), "utf8")],
      ["README.zh-CN.md", await readFile(join(root, "README.zh-CN.md"), "utf8")],
      ["docs/architecture.md", architecture],
      ["docs/alpha-testing.md", alphaTesting],
      ["CHANGELOG.md", changelog],
      ["packages/cli/README.md", await readFile(join(root, "packages/cli/README.md"), "utf8")]
    ] as const) {
      expect(source, path).not.toMatch(/OpenSpec|Superpowers/);
    }
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
