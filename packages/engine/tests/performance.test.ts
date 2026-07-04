import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { portfolioReportV2Schema, scanPortfolio } from "../src/index.js";

it("scans the hard-limit fixture of 1,000 small skills within ten seconds", async () => {
  const base = await mkdtemp(join(tmpdir(), "steward-performance-"));
  const root = join(base, "skills");
  await mkdir(root);
  for (let index = 0; index < 1_000; index += 1) {
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

  expect(report.skills).toHaveLength(1_000);
  expect(portfolioReportV2Schema.safeParse(report).success).toBe(true);
  expect(report.findings.length).toBeLessThanOrEqual(2_000);
  expect(report.findings.some(({ code }) => code === "OVERLAP_FINDINGS_TRUNCATED"))
    .toBe(true);
  expect(performance.now() - started).toBeLessThan(10_000);
}, 15_000);
