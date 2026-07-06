import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    context: {
      cwd: process.cwd(),
      home: process.cwd(),
      stateDir: process.cwd(),
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value)
    },
    stdout,
    stderr
  };
}

describe("first-use command help", () => {
  it("treats a bare invocation as successful help", async () => {
    const output = capture();

    expect(await run([], output.context)).toBe(0);
    expect(output.stderr.join("")).toBe("");
    expect(output.stdout.join("")).toContain("Usage: skill-steward");
  });

  it("describes the core read-only commands in root help", async () => {
    const output = capture();

    expect(await run(["--help"], output.context)).toBe(0);
    const help = output.stdout.join("").replace(/\s+/gu, " ");
    expect(help).toContain("scan [options] Scan installed Skills and save a local portfolio report");
    expect(help).toContain("preflight [options] Recommend a minimal set of Skills for a task");
    expect(help).toContain("dashboard [options] Launch the local Skill Steward dashboard");
    expect(help).toContain("doctor [options] Check the local runtime and private state directory");
    expect(help).toContain("discover [options] List discovered Skill roots without changing them");
    expect(help).toContain("report [options] Render the latest local portfolio report");
    expect(help).toContain("diff [options] Compare the latest report with an earlier snapshot");
    expect(help).toContain("explain [options] <finding-id> Explain one finding from the latest report");
    expect(help).toContain("label [options] <finding-id> <label> Record local feedback for one report finding");
  });
});
