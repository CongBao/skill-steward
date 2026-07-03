import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binary = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

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
});
