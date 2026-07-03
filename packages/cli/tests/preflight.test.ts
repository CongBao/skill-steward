import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestReport } from "@skill-steward/store";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

interface Fixture {
  base: string;
  stateDir: string;
  taskFile: string;
  context: CliContext & { stdin: () => Promise<string> };
  stdout: string[];
  stderr: string[];
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "steward-cli-preflight-"));
  const skillDirectory = join(base, ".agents", "skills", "security-review");
  const stateDir = join(base, "state");
  const taskFile = join(base, "task.txt");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: security-review\ndescription: Review TypeScript security changes and missing tests\n---\nReview the change.\n"
  );
  await writeFile(taskFile, "Review this TypeScript change for security regressions");
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    base,
    stateDir,
    taskFile,
    stdout,
    stderr,
    context: {
      cwd: base,
      home: join(base, "home"),
      stateDir,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      stdin: async () => "Review security changes and missing tests"
    }
  };
}

describe("preflight command", () => {
  let current: Fixture;

  beforeEach(async () => {
    current = await fixture();
  });

  it("prints an explainable human recommendation and saves a fresh report", async () => {
    const exitCode = await run(
      [
        "preflight",
        "--task",
        "Review this TypeScript change for security regressions and missing tests",
        "--max-skills",
        "3"
      ],
      current.context
    );

    expect(exitCode).toBe(0);
    expect(current.stdout.join("")).toContain("security-review");
    expect(current.stdout.join("")).toContain("Estimated context saved");
    expect(await readLatestReport(current.stateDir)).toMatchObject({
      schemaVersion: 1,
      skills: [expect.objectContaining({ name: "security-review" })]
    });
    const disk = await readFile(join(current.stateDir, "preflights.json"), "utf8");
    expect(disk).not.toContain("Review this TypeScript change");
  });

  it("reads task files relative to cwd", async () => {
    const exitCode = await run(
      ["preflight", "--task-file", "task.txt", "--json"],
      current.context
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      candidates: [expect.objectContaining({ name: "security-review" })]
    });
  });

  it("reads stdin and emits the shared JSON schema", async () => {
    const exitCode = await run(
      ["preflight", "--stdin", "--json"],
      current.context
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(current.stdout.join(""));
    expect(output).toMatchObject({
      schemaVersion: 1,
      algorithmVersion: 1,
      selectedSkillIds: expect.any(Array)
    });
    expect(output).not.toHaveProperty("task");
  });

  it("rejects missing or multiple task sources", async () => {
    expect(await run(["preflight"], current.context)).toBe(1);
    expect(
      await run(
        ["preflight", "--task", "Review this change", "--stdin"],
        current.context
      )
    ).toBe(1);
    expect(current.stderr.join(" ")).toContain("exactly one task source");
  });

  it("rejects max-skills outside one through five", async () => {
    expect(
      await run(
        ["preflight", "--task", "Review this source change", "--max-skills", "0"],
        current.context
      )
    ).toBe(1);
    expect(
      await run(
        ["preflight", "--task", "Review this source change", "--max-skills", "6"],
        current.context
      )
    ).toBe(1);
    expect(current.stderr.join(" ")).toContain("max-skills");
  });
});
