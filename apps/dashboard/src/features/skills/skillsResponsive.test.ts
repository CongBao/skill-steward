import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const css = readFileSync("src/features/skills/skills.css", "utf8");
const narrowStyles = css.slice(css.indexOf("@media (max-width: 620px)"));

it("assigns non-overlapping rows to narrow skill-card content", () => {
  expect(narrowStyles).toMatch(
    /\.skills-row \.skill-identity\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/,
  );
  expect(narrowStyles).toMatch(
    /\.skills-row \.numeric\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;[^}]*justify-self:\s*end;/,
  );
  expect(narrowStyles).toMatch(
    /\.skills-row \.scope-pill\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*2;/,
  );
  expect(narrowStyles).toMatch(
    /\.skills-row \.harness-list\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*auto;/,
  );
  expect(narrowStyles).toMatch(
    /\.skills-row \.governance-button,\s*\.skills-row \.plugin-manager-guidance\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*auto;/,
  );
});
