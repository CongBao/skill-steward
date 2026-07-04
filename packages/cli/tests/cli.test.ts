import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLatestReport } from "@skill-steward/store";
import { run } from "../src/main.js";
import { installNativeCodexFixture } from "./native-inventory-fixture.js";

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
    expect(JSON.parse(stdout.join(""))).toMatchObject({ schemaVersion: 2 });
    expect(await readLatestReport(stateDir)).toMatchObject({ schemaVersion: 2 });
  });

  it("uses the shared native inventory for default scan and discover only", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-native-"));
    const home = join(base, "home");
    const stateDir = join(base, "state");
    const customRoot = join(base, "custom");
    const customSkill = join(customRoot, "custom-review");
    await mkdir(customSkill, { recursive: true });
    await writeFile(
      join(customSkill, "SKILL.md"),
      "---\nname: custom-review\ndescription: Review custom changes\n---\n"
    );
    const native = await installNativeCodexFixture(home);
    const stdout: string[] = [];
    const context = {
      cwd: base,
      home,
      stateDir,
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined
    };

    expect(await run(["scan", "--json"], context)).toBe(0);
    const report = JSON.parse(stdout.splice(0).join(""));
    expect(report).toMatchObject({
      schemaVersion: 2,
      skills: expect.arrayContaining([expect.objectContaining({
        name: "native-review",
        ownership: "native-plugin",
        plugin: expect.objectContaining({
          harness: "codex",
          id: "fixture-plugin@fixture-marketplace"
        })
      })]),
      inventory: {
        harnesses: expect.arrayContaining([
          expect.objectContaining({ harness: "codex", status: "verified" })
        ])
      }
    });
    expect(report.inventory.sources).toContainEqual(expect.objectContaining({
      plugin: expect.objectContaining({
        id: "fixture-plugin@fixture-marketplace"
      }),
      status: "scanned",
      skillCount: 1
    }));

    expect(await run(["discover", "--json"], context)).toBe(0);
    expect(JSON.parse(stdout.splice(0).join(""))).toEqual([{
      path: await realpath(native.skillPath),
      roots: [{
        path: await realpath(join(native.cacheRoot, "skills")),
        scope: "global",
        visibleTo: ["codex"]
      }]
    }]);

    expect(await run(["scan", "--root", customRoot, "--json"], context)).toBe(0);
    const customReport = JSON.parse(stdout.splice(0).join(""));
    expect(customReport).toMatchObject({
      schemaVersion: 2,
      skills: [expect.objectContaining({ name: "custom-review" })]
    });
    expect(customReport.skills).not.toContainEqual(
      expect.objectContaining({ name: "native-review" })
    );
    expect(customReport.inventory.sources).not.toContainEqual(
      expect.objectContaining({ path: expect.stringContaining(".codex/plugins/cache") })
    );
  });

  it("discovers a native candidate even when its SKILL.md cannot be parsed", async () => {
    const base = await mkdtemp(join(tmpdir(), "steward-cli-native-invalid-"));
    const home = join(base, "home");
    const native = await installNativeCodexFixture(
      home,
      "broken-native",
      "not valid Skill frontmatter"
    );
    const stdout: string[] = [];

    expect(await run(["discover", "--json"], {
      cwd: base,
      home,
      stateDir: join(base, "state"),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined
    })).toBe(0);

    expect(JSON.parse(stdout.join(""))).toEqual([{
      path: await realpath(native.skillPath),
      roots: [{
        path: await realpath(join(native.cacheRoot, "skills")),
        scope: "global",
        visibleTo: ["codex"]
      }]
    }]);
  });
});
