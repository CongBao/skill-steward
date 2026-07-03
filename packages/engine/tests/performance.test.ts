import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanPortfolio } from "../src/index.js";

it("scans 100 small skills within five seconds", async () => {
  const base = await mkdtemp(join(tmpdir(), "steward-performance-"));
  const root = join(base, "skills");
  await mkdir(root);
  for (let index = 0; index < 100; index += 1) {
    const skill = join(root, `skill-${index}`);
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: Perform task number ${index}\n---\nExecute task ${index}.\n`
    );
  }

  const started = performance.now();
  const report = await scanPortfolio([
    { path: root, scope: "project", visibleTo: ["agents"] }
  ]);

  expect(report.skills).toHaveLength(100);
  expect(performance.now() - started).toBeLessThan(5_000);
}, 10_000);
