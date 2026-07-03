import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mainSource = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const integrationsSource = fileURLToPath(
  new URL("../../integrations/src/index.ts", import.meta.url)
);
const storeSource = fileURLToPath(new URL("../../store/src/index.ts", import.meta.url));
const companionAssets = fileURLToPath(
  new URL("../../integrations/assets", import.meta.url)
);
let fixtureDirectory = "";
let binary = "";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "steward-cli-source-process-"));
  binary = join(fixtureDirectory, "main.mjs");
  await build({
    entryPoints: [mainSource],
    outfile: binary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    },
    alias: {
      "@skill-steward/integrations": integrationsSource,
      "@skill-steward/store": storeSource
    }
  });
  await cp(companionAssets, join(fixtureDirectory, "integrations"), { recursive: true });
});

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

function runCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("integration CLI source processes", () => {
  it("serializes different exact plans before claim and domain revalidation", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-lease-process-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const workspace = join(base, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const options = {
      cwd: workspace,
      env: { ...process.env, HOME: home, SKILL_STEWARD_HOME: state }
    };
    const firstPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(firstPreview.code, firstPreview.stderr).toBe(0);
    const firstPlan = JSON.parse(firstPreview.stdout) as { id: string };
    const secondPreview = await runCli([
      "integrate", "plan", "--harness", "codex", "--json"
    ], options);
    expect(secondPreview.code, secondPreview.stderr).toBe(0);
    const secondPlan = JSON.parse(secondPreview.stdout) as { id: string };

    const results = await Promise.all([
      runCli(["integrate", "apply", "--plan", firstPlan.id, "--confirm"], options),
      runCli(["integrate", "apply", "--plan", secondPlan.id, "--confirm"], options)
    ]);

    expect(results.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(results.find(({ code }) => code === 1)?.stderr).toContain("INTEGRATION_DRIFTED");
    expect(await readFile(join(home, ".codex", "hooks.json"), "utf8"))
      .toContain("skill-steward hook prompt --harness codex");
  });
});
