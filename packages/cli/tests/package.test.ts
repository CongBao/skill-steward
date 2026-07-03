import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = process.cwd();
const root = resolve(packageDirectory, "../..");
const verifier = join(packageDirectory, "tests", "verify-packed-artifact.mjs");

async function packageJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const source = `${value.toString(8).padStart(length - 1, "0")}\0`;
  target.write(source, offset, length, "ascii");
}

function maliciousTar(path: string): Buffer {
  const content = Buffer.from("escape\n");
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

it("packages the built dashboard alongside the CLI binary", async () => {
  const dashboard = join(process.cwd(), "dist", "dashboard");
  await expect(access(join(dashboard, "index.html"))).resolves.toBeUndefined();
  const assets = await readdir(join(dashboard, "assets"));
  expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  expect(assets.some((name) => name.endsWith(".css"))).toBe(true);
  expect(await readFile(join(dashboard, "index.html"), "utf8")).toContain("/assets/");
  const javascript = (
    await Promise.all(
      assets
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(join(dashboard, "assets", name), "utf8"))
    )
  ).join("\n");
  expect(javascript).toContain("/api/v1/preflights");
  expect(javascript).toContain("/api/v1/evidence/summary");
  expect(javascript).toContain("/api/v1/governance/plans");
  expect(javascript).toContain("/api/v1/integrations/capabilities");
  expect(javascript).toContain("Task preflight");
  expect(javascript).toContain("Evidence and outcomes");
  expect(javascript).toContain("No permanent delete");
  expect(javascript).toContain("GitHub Copilot CLI");

  const companion = join(
    process.cwd(),
    "dist",
    "integrations",
    "skill-steward-preflight",
    "SKILL.md"
  );
  const skill = await readFile(companion, "utf8");
  expect(skill).toContain("name: skill-steward-preflight");
  expect(skill).toContain("never install them automatically");
});

it("declares complete public package metadata", async () => {
  expect(await packageJson()).toMatchObject({
    description: "Local-first Agent Skill discovery, task preflight, and reversible governance across AI coding Harnesses",
    repository: {
      type: "git",
      url: "git+https://github.com/CongBao/skill-steward.git"
    },
    homepage: "https://github.com/CongBao/skill-steward#readme",
    bugs: { url: "https://github.com/CongBao/skill-steward/issues" },
    author: { name: "CongBao", email: "bao_cong@outlook.com" },
    maintainers: [{ name: "CongBao", email: "bao_cong@outlook.com" }],
    engines: { node: ">=22" },
    publishConfig: { access: "public" },
    files: expect.arrayContaining(["dist", "README.md", "LICENSE"]),
    keywords: expect.arrayContaining([
      "agent-skills",
      "skill-discovery",
      "task-preflight",
      "reversible-governance",
      "codex",
      "claude-code",
      "github-copilot"
    ])
  });
});

it("builds package documentation, license, and deterministic notice coverage", async () => {
  await expect(access(join(packageDirectory, "README.md"))).resolves.toBeUndefined();
  await expect(access(join(packageDirectory, "LICENSE"))).resolves.toBeUndefined();
  expect(await readFile(join(packageDirectory, "LICENSE"), "utf8"))
    .toBe(await readFile(join(root, "LICENSE"), "utf8"));
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "dist", "third-party-manifest.json"), "utf8")
  ) as {
    schemaVersion: number;
    packages: Array<{ name: string; version: string; license: string }>;
  };
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.packages.length).toBeGreaterThan(0);
  const identifiers = manifest.packages.map(({ name, version }) => `${name}@${version}`);
  expect(identifiers).toEqual([...identifiers].sort((left, right) => left.localeCompare(right)));
  const notices = await readFile(
    join(packageDirectory, "dist", "THIRD_PARTY_NOTICES.txt"),
    "utf8"
  );
  for (const identifier of identifiers) expect(notices).toContain(`## ${identifier}\n`);
  expect(notices).not.toContain(root);
  expect(notices).not.toMatch(
    /(?:^|[\s('"`])(?:\/[Uu]sers\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:[\\/])/m,
  );
});

it("includes required trust files in npm pack dry-run output", async () => {
  const cache = await mkdtemp(join(tmpdir(), "steward-npm-cache-"));
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: packageDirectory,
      env: { ...process.env, npm_config_cache: cache }
    }
  );
  const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = result[0]?.files.map(({ path }) => path) ?? [];
  expect(paths).toEqual(expect.arrayContaining([
    "LICENSE",
    "README.md",
    "dist/THIRD_PARTY_NOTICES.txt",
    "dist/third-party-manifest.json"
  ]));
});

it("rejects a tarball path traversal without extracting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steward-malicious-pack-"));
  const artifact = join(directory, "malicious.tgz");
  await writeFile(artifact, maliciousTar("package/../escape"));

  await expect(execFileAsync(process.execPath, [verifier, artifact]))
    .rejects.toMatchObject({ stderr: expect.stringContaining("Unsafe tar path") });
});

it("verifies the real pnpm-packed artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steward-real-pack-"));
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], {
    cwd: packageDirectory
  });
  const artifact = (await readdir(directory))
    .find((name) => name.endsWith(".tgz"));
  expect(artifact).toBeDefined();
  await expect(execFileAsync(process.execPath, [verifier, join(directory, artifact!)]))
    .resolves.toMatchObject({ stdout: expect.stringContaining("Verified") });
}, 120_000);
