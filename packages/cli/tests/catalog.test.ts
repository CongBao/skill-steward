import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogInspection } from "@skill-steward/catalog";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../src/context.js";
import { run } from "../src/main.js";

interface Fixture {
  context: CliContext;
  stdout: string[];
  stderr: string[];
}

const inspection: CatalogInspection = {
  commitSha: "a".repeat(40),
  candidates: [{
    id: "candidate",
    relativePath: "testing",
    name: "testing-review",
    description: "Find missing tests",
    fingerprint: `sha256:${"b".repeat(64)}`,
    files: [],
    estimatedTokens: 180,
    scripts: [],
    executables: [],
    findings: []
  }]
};

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "steward-cli-catalog-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    context: {
      cwd: base,
      home: base,
      stateDir: join(base, "state"),
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      catalogInspect: async () => inspection,
      now: () => new Date("2026-07-03T00:00:00.000Z")
    }
  };
}

describe("catalog command", () => {
  let current: Fixture;

  beforeEach(async () => {
    current = await fixture();
  });

  it("lists, enables, and explicitly refreshes a preset", async () => {
    expect(await run(["catalog", "list", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join(""))).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ id: "openai-plugins", enabled: false })
      ])
    });
    expect(await run(["catalog", "enable", "openai-plugins"], current.context)).toBe(0);
    current.stdout.splice(0);
    expect(await run(["catalog", "refresh", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.join(""))).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceId: "openai-plugins", status: "ready" })
      ]),
      skills: [expect.objectContaining({ name: "testing-review" })]
    });
  });

  it("adds disabled user sources and requires confirmation to remove", async () => {
    expect(await run([
      "catalog", "add",
      "--id", "community-skills",
      "--name", "Community skills",
      "--url", "https://example.com/community.git"
    ], current.context)).toBe(0);
    current.stdout.splice(0);
    expect(await run(["catalog", "list", "--json"], current.context)).toBe(0);
    expect(JSON.parse(current.stdout.splice(0).join("")).sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "community-skills",
          enabled: false,
          trust: "user",
          preset: false
        })
      ])
    );
    expect(await run(["catalog", "remove", "community-skills"], current.context)).toBe(1);
    expect(current.stderr.join("")).toContain("--confirm");
    expect(await run([
      "catalog", "remove", "community-skills", "--confirm"
    ], current.context)).toBe(0);
  });
});
