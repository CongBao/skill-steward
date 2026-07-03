import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  installationSourceSchema,
  InstallerError,
  type InstallationSource
} from "./domain.js";

type GitSource = Extract<InstallationSource, { kind: "git" }>;

export interface GitRunnerOptions {
  timeoutMs: number;
}

export type GitRunner = (
  args: string[],
  options: GitRunnerOptions
) => Promise<{ stdout: string }>;

export interface StagedGitResult {
  sourceDirectory: string;
  commitSha: string;
}

export const defaultGitRunner: GitRunner = (args, { timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1"
      }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(() => reject(new InstallerError("GIT_OUTPUT_LIMIT", "Git output limit exceeded")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => {
        if (code === 0) {
          resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8") });
        } else {
          reject(
            new InstallerError(
              "GIT_FAILED",
              Buffer.concat(stderr).toString("utf8").trim() || `Git exited with ${code}`
            )
          );
        }
      })
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new InstallerError("GIT_TIMEOUT", "Git operation timed out")));
    }, timeoutMs);
  });

export async function stagePublicGit(
  destination: string,
  input: GitSource,
  runner: GitRunner = defaultGitRunner
): Promise<StagedGitResult> {
  const source = installationSourceSchema.parse(input);
  if (source.kind !== "git") {
    throw new InstallerError("INVALID_SOURCE", "Expected a Git installation source");
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  const repository = resolve(destination, "repository");
  const common = ["-c", "core.hooksPath=/dev/null"];
  const options = { timeoutMs: 30_000 };
  await runner(
    [
      ...common,
      "clone",
      "--depth",
      "1",
      "--no-recurse-submodules",
      source.url,
      repository
    ],
    options
  );

  if (source.ref) {
    await runner(
      [...common, "-C", repository, "fetch", "--depth", "1", "origin", source.ref],
      options
    );
    await runner(
      [...common, "-C", repository, "checkout", "--detach", "FETCH_HEAD"],
      options
    );
  }
  const { stdout } = await runner(
    [...common, "-C", repository, "rev-parse", "HEAD"],
    options
  );
  const commitSha = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) {
    throw new InstallerError("GIT_INVALID_COMMIT", "Git returned an invalid commit SHA");
  }

  const repositoryPhysical = await realpath(repository);
  const requested = resolve(repository, source.subdirectory ?? ".");
  const sourceDirectory = await realpath(requested);
  if (
    sourceDirectory !== repositoryPhysical &&
    !sourceDirectory.startsWith(`${repositoryPhysical}${sep}`)
  ) {
    throw new InstallerError("UNSAFE_SOURCE_PATH", "Git subdirectory escapes the repository");
  }
  return { sourceDirectory, commitSha };
}
