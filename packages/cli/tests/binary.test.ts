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

    expect(manifest.version).toBe("0.5.0-alpha.2");
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

  it("runs cached Hooks and reversible integration lifecycles for all three adapters in a temporary HOME", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-vertical-slice-"));
    const home = join(base, "home");
    const workspace = join(base, "workspace");
    const stateDir = join(base, "state");
    const installedSkill = join(home, ".agents", "skills", "security-review");
    const claudeSkill = join(home, ".claude", "skills", "security-review");
    await mkdir(installedSkill, { recursive: true });
    await mkdir(claudeSkill, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(installedSkill, "SKILL.md"), "---\nname: security-review\ndescription: Review security risks and vulnerabilities\n---\nReview security.\n");
    await writeFile(join(claudeSkill, "SKILL.md"), "---\nname: security-review\ndescription: Review security risks and vulnerabilities\n---\nReview security.\n");
    await writeFile(join(home, ".codex", "hooks.json"), '{"unrelated":true}\n');
    await writeFile(join(home, ".claude", "settings.json"), '{"unrelated":true}\n');
    await writeFile(join(home, ".copilot", "hooks", "keep-me.json"), '{"unrelated":true}\n');
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
    const claudeHook = await runWithInput(
      ["hook", "prompt", "--harness", "claude-code"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: rawTask, cwd: workspace }),
      { cwd: workspace, env }
    );
    expect(JSON.parse(claudeHook.stdout).hookSpecificOutput.additionalContext).toContain("security-review");
    for (const [args, payload] of [
      [["hook", "lifecycle", "--harness", "codex"], { hook_event_name: "Stop", session_id: "synthetic-codex" }],
      [["hook", "lifecycle", "--harness", "claude-code"], { hook_event_name: "Stop", session_id: "synthetic-claude", stop_hook_active: false }],
      [["hook", "lifecycle", "--harness", "claude-code"], { hook_event_name: "SessionEnd", session_id: "synthetic-claude", reason: "clear" }],
      [["hook", "observe", "--harness", "github-copilot", "--event", "userPromptSubmitted"], { sessionId: "synthetic-copilot", timestamp: 1_783_036_800_000, cwd: workspace, prompt: rawTask }],
      [["hook", "observe", "--harness", "github-copilot", "--event", "sessionEnd"], { sessionId: "synthetic-copilot", timestamp: 1_783_036_801_000, cwd: workspace, reason: "complete" }]
    ] as const) {
      expect(JSON.parse((await runWithInput([...args], JSON.stringify(payload), { cwd: workspace, env })).stdout)).toEqual({});
    }
    const stateFiles = await readdir(stateDir, { recursive: true });
    const stateText = (await Promise.all(stateFiles.map(async (entry) => {
      try { return await readFile(join(stateDir, entry), "utf8"); } catch { return ""; }
    }))).join("\n");
    expect(stateText).not.toContain(rawTask);

    for (const harness of ["codex", "claude-code", "github-copilot"]) {
      await execFileAsync(process.execPath, [binary, "integrate", "plan", "--harness", harness], { cwd: workspace, env });
      await execFileAsync(process.execPath, [binary, "integrate", "apply", "--harness", harness, "--confirm"], { cwd: workspace, env });
    }
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).resolves.toContain("name: skill-steward-preflight");
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toMatchObject({ unrelated: true });
    expect(await readFile(join(home, ".copilot", "hooks", "skill-steward.json"), "utf8")).toContain("hook observe --harness github-copilot");

    const managed = [
      { harness: "codex", path: join(home, ".codex", "hooks.json"), drift: (source: string) => source.replace("hook prompt --harness codex", "hook prompt --harness codex --drifted") },
      { harness: "claude-code", path: join(home, ".claude", "settings.json"), drift: (source: string) => source.replace("hook prompt --harness claude-code", "hook prompt --harness claude-code --drifted") },
      { harness: "github-copilot", path: join(home, ".copilot", "hooks", "skill-steward.json"), drift: (source: string) => `${source.trimEnd().slice(0, -1)},\"drifted\":true}\n` }
    ];
    for (const entry of managed) {
      const original = await readFile(entry.path, "utf8");
      const drifted = entry.drift(original);
      await writeFile(entry.path, drifted, "utf8");
      await expect(execFileAsync(process.execPath, [binary, "integrate", "remove", "--harness", entry.harness, "--confirm"], { cwd: workspace, env })).rejects.toThrow();
      expect(await readFile(entry.path, "utf8")).toBe(drifted);
      await writeFile(entry.path, original, "utf8");
    }

    await execFileAsync(process.execPath, [binary, "integrate", "remove", "--harness", "codex", "--confirm"], { cwd: workspace, env });
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).resolves.toContain("name: skill-steward-preflight");
    await execFileAsync(process.execPath, [binary, "integrate", "remove", "--harness", "claude-code", "--confirm"], { cwd: workspace, env });
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).resolves.toContain("name: skill-steward-preflight");
    await execFileAsync(process.execPath, [binary, "integrate", "remove", "--harness", "github-copilot", "--confirm"], { cwd: workspace, env });
    expect(JSON.parse(await readFile(join(home, ".copilot", "hooks", "keep-me.json"), "utf8"))).toMatchObject({ unrelated: true });
    await expect(readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8")).rejects.toThrow();
  });
});
