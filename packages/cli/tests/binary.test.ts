import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binary = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

function runWithInput(
  args: string[],
  input: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

describe("built CLI", () => {
  it("reports the same version as the published package", async () => {
    const manifest = JSON.parse(await readFile(packageJson, "utf8")) as {
      version: string;
    };
    const { stdout } = await execFileAsync(process.execPath, [binary, "--version"]);

    expect(manifest.version).toBe("0.3.0-alpha.1");
    expect(stdout.trim()).toBe(manifest.version);
  });

  it("lists task preflight in packaged help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [binary, "--help"]);
    expect(stdout).toContain("preflight");
    expect(stdout).toMatch(/Recommend a minimal set of Skills for a\s+task/);
    expect(stdout).toContain("hook");
    expect(stdout).toContain("integrate");
  });

  it("runs as an ESM executable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "steward-binary-"));
    const { stdout } = await execFileAsync(
      process.execPath,
      [binary, "doctor", "--json"],
      {
        env: { ...process.env, SKILL_STEWARD_HOME: stateDir }
      }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      stateDir,
      stateWritable: true
    });
  });

  it("runs through a package-manager-style executable symlink", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-bin-link-"));
    const stateDir = join(base, "state");
    const executableLink = join(base, "skill-steward");
    await symlink(binary, executableLink, "file");

    const { stdout } = await execFileAsync(
      process.execPath,
      [executableLink, "doctor", "--json"],
      {
        env: { ...process.env, SKILL_STEWARD_HOME: stateDir }
      }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      stateDir,
      stateWritable: true
    });
  });

  it("runs the cached discovery Hook and reversible Codex bridge in a temporary HOME", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-vertical-slice-"));
    const home = join(base, "home");
    const workspace = join(base, "workspace");
    const stateDir = join(base, "state");
    const installedSkill = join(home, ".agents", "skills", "security-review");
    await mkdir(installedSkill, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(installedSkill, "SKILL.md"), "---\nname: security-review\ndescription: Review security risks and vulnerabilities\n---\nReview security.\n");
    await writeFile(join(home, ".codex", "hooks.json"), '{"unrelated":true}\n');
    const env = { ...process.env, HOME: home, SKILL_STEWARD_HOME: stateDir };
    await execFileAsync(process.execPath, [binary, "scan", "--json"], { cwd: workspace, env });

    const source = {
      id: "fixture-catalog",
      name: "Fixture catalog",
      kind: "git",
      url: "https://example.com/skills.git",
      enabled: true,
      trust: "user",
      preset: false
    };
    await writeFile(join(stateDir, "catalog-sources.json"), `${JSON.stringify({ schemaVersion: 1, sources: [source] })}\n`);
    await writeFile(join(stateDir, "catalog-index.json"), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-07-03T00:00:00.000Z",
      sources: [{ sourceId: source.id, status: "ready", skillCount: 1 }],
      skills: [{
        id: "testing-available",
        sourceId: source.id,
        sourceRevision: "c".repeat(40),
        relativePath: "testing",
        name: "testing-review",
        description: "Find missing tests and review test coverage",
        fingerprint: `sha256:${"d".repeat(64)}`,
        estimatedTokens: 180,
        scripts: [],
        executables: [],
        findings: [],
        compatibleHarnesses: ["codex"],
        compatibility: "declared"
      }]
    })}\n`);

    const rawTask = "PRIVATE review security vulnerabilities and find missing tests";
    const hook = await runWithInput(
      ["hook", "prompt", "--harness", "codex"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: rawTask, cwd: workspace }),
      { cwd: workspace, env }
    );
    const hookOutput = JSON.parse(hook.stdout);
    expect(hookOutput.hookSpecificOutput.additionalContext).toContain("security-review");
    expect(hookOutput.hookSpecificOutput.additionalContext).toContain("testing-review");
    const stateFiles = await readdir(stateDir, { recursive: true });
    const stateText = (await Promise.all(stateFiles.map(async (entry) => {
      try { return await readFile(join(stateDir, entry), "utf8"); } catch { return ""; }
    }))).join("\n");
    expect(stateText).not.toContain(rawTask);

    await execFileAsync(process.execPath, [binary, "integrate", "plan", "--harness", "codex"], { cwd: workspace, env });
    await execFileAsync(process.execPath, [binary, "integrate", "apply", "--harness", "codex", "--confirm"], { cwd: workspace, env });
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).resolves.toContain("name: skill-steward-preflight");
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });

    await execFileAsync(process.execPath, [binary, "integrate", "remove", "--harness", "codex", "--confirm"], { cwd: workspace, env });
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).rejects.toThrow();
  });
});
