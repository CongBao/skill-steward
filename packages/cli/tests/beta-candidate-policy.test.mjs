import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(process.cwd(), "../..");
const version = "0.5.0-beta.1";
const publicPackages = [
  "packages/cli",
  "packages/rename-noreplace-darwin-arm64",
  "packages/rename-noreplace-darwin-x64",
  "packages/rename-noreplace-linux-arm64-gnu",
  "packages/rename-noreplace-linux-arm64-musl",
  "packages/rename-noreplace-linux-x64-gnu",
  "packages/rename-noreplace-linux-x64-musl"
];
const nativeNames = [
  "@skill-steward/rename-noreplace-darwin-arm64",
  "@skill-steward/rename-noreplace-darwin-x64",
  "@skill-steward/rename-noreplace-linux-arm64-gnu",
  "@skill-steward/rename-noreplace-linux-arm64-musl",
  "@skill-steward/rename-noreplace-linux-x64-gnu",
  "@skill-steward/rename-noreplace-linux-x64-musl"
];
const expectedDescription =
  "Cross-Harness operations for Agent Skills: task preflight, missing-Skill discovery, local evidence, and reversible governance.";
const expectedTopics = [
  "agent-skills",
  "ai-agents",
  "codex",
  "claude-code",
  "github-copilot",
  "developer-tools",
  "task-preflight",
  "local-first",
  "skill-discovery",
  "typescript"
];
const mutableReleaseDocuments = [
  "docs/cli-publication.md",
  "docs/native-publication.md",
  "docs/github-prerelease.md",
  "docs/release-contract.md"
];

const prematureClaimPatterns = new Map([
  ["npm-install", /\bnpm\s+(?:install|i)\s+(?:--global|-g)\s+skill-steward(?:@(?:beta|latest|[0-9][^\s`]*))?/iu],
  ["npm-available", /(?:skill[ -]steward|npm package)[^\n.;；]{0,48}\b(?:is\s+)?(?:now\s+)?(?:available|published)\s+(?:on|to)\s+npm|(?:现已|已经|已)发布到\s*npm/iu],
  ["github-release", /GitHub (?:pre)?release[^\n.;；]{0,48}(?:is\s+)?(?:now\s+)?\b(?:available|published|live)\b|GitHub\s*(?:预发布版本|Release)[^\n。；]{0,32}(?:现已|已经|已)(?:发布|可用)/iu],
  ["public-provenance", /(?:public|npm) provenance[^\n.;；]{0,32}(?:is\s+)?(?:verified|available)|(?:公开|npm)\s*provenance[^\n。；]{0,24}(?:已经|已)(?:验证|可用)/iu],
  ["downloads", /badge[^\n]*(?:npm|download)|npm[^\n]*\bdownloads?\b/iu]
]);

function prematurePublicClaims(markdown) {
  return [...prematureClaimPatterns]
    .filter(([, pattern]) => pattern.test(markdown))
    .map(([name]) => name);
}

function actionablePrematurePublicClaims(markdown) {
  const denial = /\b(?:not|never|cannot|does not|has not|isn't|aren't|no)\b|(?:尚未|不会|不能|并未|没有)(?:公开|发布|可用)?/iu;
  const boundary = /[\n.!?;。！？；]/u;
  const adversative = /\b(?:but|however)\b|(?:但是|然而|不过)/giu;
  const actionable = [];
  for (const [name, pattern] of prematureClaimPatterns) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of markdown.matchAll(globalPattern)) {
      const index = match.index;
      let start = index;
      while (start > 0 && !boundary.test(markdown[start - 1])) start -= 1;
      const prefix = markdown.slice(start, index + match[0].length);
      let scopedPrefix = prefix;
      for (const marker of prefix.matchAll(adversative)) {
        scopedPrefix = prefix.slice((marker.index ?? 0) + marker[0].length);
      }
      if (!denial.test(scopedPrefix)) actionable.push(name);
    }
  }
  return [...new Set(actionable)];
}

it("binds every public manifest and lockfile importer to the Beta candidate", async () => {
  const manifests = await Promise.all(publicPackages.map(async (directory) => JSON.parse(
    await readFile(resolve(root, directory, "package.json"), "utf8")
  )));
  expect(manifests.map(({ version: candidate }) => candidate)).toEqual(
    Array.from({ length: 7 }, () => version)
  );
  expect(manifests[0].optionalDependencies).toEqual(
    Object.fromEntries(nativeNames.map((name) => [name, version]))
  );

  const lockfile = parse(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const lockedOptional = lockfile.importers["packages/cli"].optionalDependencies;
  expect(Object.keys(lockedOptional).sort()).toEqual([...nativeNames].sort());
  expect(Object.values(lockedOptional).map(({ specifier }) => specifier))
    .toEqual(Array.from({ length: 6 }, () => version));
});

it("keeps the unpublished Beta candidate truthful and bilingual", async () => {
  const english = await readFile(resolve(root, "README.md"), "utf8");
  const chinese = await readFile(resolve(root, "README.zh-CN.md"), "utf8");
  const packageReadme = await readFile(resolve(root, "packages/cli/README.md"), "utf8");
  const releaseDocuments = await Promise.all(mutableReleaseDocuments.map((path) =>
    readFile(resolve(root, path), "utf8")
  ));
  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  const englishLead = english.slice(0, english.indexOf("## Product views"));
  const chineseLead = chinese.slice(0, chinese.indexOf("## 产品界面"));
  const betaNotes = changelog.slice(
    changelog.indexOf("## [0.5.0-beta.1]"),
    changelog.indexOf("## [0.5.0-alpha.4]")
  );

  expect(englishLead).toContain("Know your Skills. Choose what matters. Change with confidence.");
  expect(englishLead).toContain("Beta release candidate 0.5.0-beta.1");
  expect(englishLead).toContain("The Skill Steward CLI is not published to npm");
  expect(chineseLead).toContain("看清你的 Skills，只选真正有用的，放心完成每次变更。");
  expect(chineseLead).toContain("Beta 发布候选版 0.5.0-beta.1");
  expect(chineseLead).toContain("Skill Steward CLI 尚未发布到 npm");

  for (const markdown of [english, chinese, packageReadme, betaNotes, ...releaseDocuments]) {
    expect(actionablePrematurePublicClaims(markdown)).toEqual([]);
  }
  expect(packageReadme).not.toMatch(/not public yet|has not (?:been )?published|unavailable until/iu);
  expect(betaNotes).not.toMatch(/(?:npm packages?|GitHub prerelease)[^\n.]{0,64}remain unavailable|not a publication claim|has not (?:been )?published/iu);
});

it("still rejects an unsafe claim appended to every mutable release document", async () => {
  for (const path of mutableReleaseDocuments) {
    const markdown = await readFile(resolve(root, path), "utf8");
    expect(actionablePrematurePublicClaims(
      `${markdown}\nSkill Steward is now available on npm.\n`
    )).toContain("npm-available");
  }
});

it("does not let an earlier denial hide a later public-availability claim", () => {
  expect(actionablePrematurePublicClaims(
    "Skill Steward is not yet available on npm; Skill Steward is now available on npm."
  )).toContain("npm-available");
});

it.each([
  ["npm-install", "npm i -g skill-steward@beta"],
  ["npm-available", "Skill Steward is now available on npm."],
  ["github-release", "The GitHub prerelease is now available."],
  ["public-provenance", "npm provenance is verified."],
  ["downloads", "![npm downloads](https://example.invalid/downloads.svg)"]
])("rejects the premature %s claim class", (expected, unsafe) => {
  expect(prematurePublicClaims(unsafe)).toContain(expected);
});

it("uses focused launch metadata instead of a generic scanner description", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8"));
  const repository = JSON.parse(
    await readFile(resolve(root, ".github/repository-metadata.json"), "utf8")
  );
  expect(manifest.description).toBe(
    "Cross-Harness Agent Skill task preflight, missing-Skill discovery, local evidence, and reversible governance"
  );
  expect(manifest.keywords).toEqual([
    "agent-skills", "ai-agents", "task-preflight", "skill-discovery", "local-first",
    "reversible-governance", "codex", "claude-code", "github-copilot", "developer-tools"
  ]);
  expect(repository).toEqual({
    schemaVersion: 1,
    description: expectedDescription,
    topics: expectedTopics,
    socialPreview: "docs/images/social-preview.png"
  });
});

it("routes Beta feedback through the product's actual operating surfaces", async () => {
  const bug = await readFile(resolve(root, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
  const feature = parse(
    await readFile(resolve(root, ".github/ISSUE_TEMPLATE/feature_request.yml"), "utf8")
  );
  const config = parse(
    await readFile(resolve(root, ".github/ISSUE_TEMPLATE/config.yml"), "utf8")
  );
  const area = feature.body.find(({ id }) => id === "area");

  expect(bug).toContain("https://github.com/CongBao/skill-steward/security/policy");
  expect(config).toMatchObject({
    blank_issues_enabled: false,
    contact_links: [expect.objectContaining({
      name: "Report a security vulnerability",
      url: "https://github.com/CongBao/skill-steward/security/advisories/new"
    })]
  });
  expect(area.attributes.options).toEqual([
    "Task Preflight and Skill discovery",
    "Harness integration",
    "Evidence and recommendation quality",
    "Installation and reversible governance",
    "Inventory and analysis",
    "Dashboard and CLI",
    "Harness compatibility",
    "Documentation"
  ]);
});

it("ships an evergreen social preview with exact product positioning", async () => {
  const png = await readFile(resolve(root, "docs/images/social-preview.png"));
  const source = await readFile(resolve(root, "docs/images/social-preview.svg"), "utf8");

  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1280);
  expect(png.readUInt32BE(20)).toBe(640);
  expect(source).toContain("Cross-Harness operations for Agent Skills");
  expect(source).toContain("Task preflight");
  expect(source).toContain("Missing-Skill discovery");
  expect(source).toContain("Local evidence");
  expect(source).toContain("Reversible governance");
  expect(source).not.toMatch(/0\.5\.0|alpha|beta|release candidate/iu);
});
