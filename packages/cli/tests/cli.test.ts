import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLatestReport } from "@skill-steward/store";
import { run } from "../src/main.js";

describe("scan command", () => {
  it("prints JSON and saves the report", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-"));
    const root = join(base, "skills");
    const skill = join(root, "review");
    const stateDir = join(base, "state");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n"
    );
    const stdout: string[] = [];

    const exitCode = await run(["scan", "--root", root, "--json"], {
      cwd: base,
      home: base,
      stateDir,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ schemaVersion: 1 });
    expect(await readLatestReport(stateDir)).toMatchObject({ schemaVersion: 1 });
  });
});
