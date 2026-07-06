import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createDashboardApp,
  createIntegrationServices
} from "@skill-steward/dashboard-server";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binary = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
const releaseContract = fileURLToPath(new URL("../../../release-contract.json", import.meta.url));

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

async function runFailed(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [binary, ...args], options);
  } catch (error) {
    return {
      stdout: String((error as { stdout?: string }).stdout ?? ""),
      stderr: String((error as { stderr?: string }).stderr ?? "")
    };
  }
  throw new Error(`Expected CLI failure for ${args.join(" ")}`);
}

describe("built CLI", () => {
  it("reports the same version as the published package", async () => {
    const manifest = JSON.parse(await readFile(packageJson, "utf8")) as {
      version: string;
    };
    const contract = JSON.parse(await readFile(releaseContract, "utf8")) as {
      version: string;
    };
    const { stdout } = await execFileAsync(process.execPath, [binary, "--version"]);

    expect(manifest.version).toBe(contract.version);
    expect(stdout.trim()).toBe(manifest.version);
  });

  it("lists task preflight in packaged help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [binary, "--help"]);
    expect(stdout).toContain("preflight");
    expect(stdout).toMatch(/Recommend a minimal set of Skills for a\s+task/);
    expect(stdout).toContain("hook");
    expect(stdout).toContain("integrate");
    const applyHelp = (await execFileAsync(
      process.execPath,
      [binary, "integrate", "apply", "--help"]
    )).stdout;
    expect(applyHelp).toContain("--plan <id>");
    expect(applyHelp).toContain("--confirm");
    const removeHelp = (await execFileAsync(
      process.execPath,
      [binary, "integrate", "remove", "--help"]
    )).stdout;
    expect(removeHelp).toContain("--plan <id>");
    expect(removeHelp).toContain("--confirm");
    for (const args of [
      ["install", "--help"],
      ["govern", "quarantine", "--help"],
      ["govern", "restore", "--help"],
      ["evidence", "policy", "set", "--help"],
      ["evidence", "erase", "--help"]
    ]) {
      const { stdout: help, stderr } = await execFileAsync(
        process.execPath,
        [binary, ...args]
      );
      expect(help, args.join(" ")).toContain("--plan <id>");
      expect(help, args.join(" ")).toContain("--confirm");
      expect(stderr, args.join(" ")).toBe("");
    }
  });

  it("prints a conflicting-option parse error exactly once", async () => {
    let stderr = "";
    try {
      await execFileAsync(process.execPath, [
        binary,
        "preflight",
        "--stdin",
        "--json",
        "--compact-json"
      ]);
      throw new Error("Expected conflicting options to fail");
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }

    expect(stderr.match(/option '--compact-json' cannot be used with option '--json'/gu))
      .toHaveLength(1);
  });

  it("keeps every invalid integration Harness path-safe and in parity with the API", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-invalid-integration-harness-"));
    const home = join(base, "home");
    const stateDirectory = join(base, "state");
    const rawHarness = "private-invalid-harness-canary";
    await mkdir(home, { recursive: true });
    const options = {
      cwd: base,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: stateDirectory }
    };
    const invalidCommands = [
      ["integrate", "plan", "--harness", rawHarness, "--json"],
      ["integrate", "status", "--harness", rawHarness, "--json"],
      ["integrate", "apply", "--plan", "reviewed-plan", "--harness", rawHarness, "--confirm", "--json"],
      ["integrate", "remove", "--harness", rawHarness, "--confirm", "--json"],
      ["integrate", "remove", "--harness", rawHarness, "--json"],
      ["integrate", "remove", "--plan", "reviewed-plan", "--harness", rawHarness, "--confirm", "--json"]
    ];
    const cliFailures = await Promise.all(invalidCommands.map((args) =>
      runFailed(args, options)
    ));
    const expectedError = {
      code: "INVALID_INTEGRATION_HARNESS",
      message: "The requested integration Harness is not supported."
    };
    for (const failure of cliFailures) {
      expect(failure.stdout).toBe("");
      expect(JSON.parse(failure.stderr).error).toEqual(expectedError);
      expect(failure.stderr).not.toContain(rawHarness);
    }

    for (const command of ["apply", "remove"] as const) {
      const conflict = await runFailed([
        "integrate",
        command,
        "--plan",
        "reviewed-plan",
        "--harness",
        "codex",
        "--confirm",
        "--json"
      ], options);
      expect(conflict.stdout).toBe("");
      expect(JSON.parse(conflict.stderr).error.code).toBe("REVIEWED_PLAN_AMBIGUOUS");
    }

    const integrationServices = createIntegrationServices({
      home,
      stateDirectory,
      companionSkillDirectory: fileURLToPath(new URL(
        "../../integrations/assets/skill-steward-preflight",
        import.meta.url
      )),
      generateReadiness: async () => ({})
    });
    const { app } = createDashboardApp({ mutationToken: "token", integrationServices });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/integrations/${rawHarness}/plan`,
        headers: { "x-skill-steward-token": "token" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual(expectedError);
      expect(response.body).not.toContain(rawHarness);
    } finally {
      await app.close();
    }
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

  it("runs cached Hooks and reviewed companion transactions for all adapters", async () => {
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
      const preview = JSON.parse((await execFileAsync(
        process.execPath,
        [binary, "integrate", "plan", "--harness", harness, "--json"],
        { cwd: workspace, env }
      )).stdout) as { planId: string };
      await expect(execFileAsync(
        process.execPath,
        [binary, "integrate", "apply", "--plan", preview.planId, "--confirm"],
        { cwd: workspace, env }
      )).resolves.toMatchObject({ stderr: "" });
    }
    expect(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).toMatchObject({ unrelated: true, hooks: expect.any(Object) });
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toMatchObject({ unrelated: true, hooks: expect.any(Object) });
    expect(JSON.parse(await readFile(join(home, ".copilot", "hooks", "keep-me.json"), "utf8"))).toMatchObject({ unrelated: true });
    expect(JSON.parse(await readFile(join(home, ".copilot", "hooks", "skill-steward.json"), "utf8"))).toMatchObject({ version: 1 });
    expect(await readFile(join(home, ".agents", "skills", "skill-steward-preflight", "SKILL.md"), "utf8"))
      .toContain("name: skill-steward-preflight");
  }, 30_000);
});
