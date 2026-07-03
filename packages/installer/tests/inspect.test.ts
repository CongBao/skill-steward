import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectStagedSkills } from "../src/inspect.js";

async function createSkill(root: string, name: string, body = "Use [missing](references/missing.md)") {
  const directory = join(root, "collection", name);
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} helper\n---\n${body}\n`
  );
  await writeFile(join(directory, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(directory, "scripts", "run.sh"), 0o755);
}

describe("inspectStagedSkills", () => {
  it("discovers multiple candidates with fingerprints, executables, and engine findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-inspect-"));
    await createSkill(root, "review");
    await createSkill(root, "test", "Read instructions");

    const candidates = await inspectStagedSkills(root);

    expect(candidates.map(({ relativePath }) => relativePath)).toEqual([
      "collection/review",
      "collection/test"
    ]);
    expect(candidates[0]).toMatchObject({
      name: "review",
      scripts: ["scripts/run.sh"],
      executables: ["scripts/run.sh"]
    });
    expect(candidates[0]?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidates[0]?.findings.map(({ code }) => code)).toContain(
      "BROKEN_RELATIVE_REFERENCE"
    );
  });

  it("returns a parse finding for an invalid SKILL.md without hiding other candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-inspect-invalid-"));
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", "SKILL.md"), "not frontmatter");

    const candidates = await inspectStagedSkills(root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "broken", fingerprint: null });
    expect(candidates[0]?.findings[0]?.code).toBe("SKILL_PARSE_FAILED");
  });
});
