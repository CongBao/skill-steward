import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps the first-value guide fluid without forcing horizontal overflow", async () => {
  const css = await readFile(resolve(process.cwd(), "src/features/overview/overview.css"), "utf8");
  const actionRule = css.match(/\.first-value-guide-actions\s*\{([^}]*)\}/u)?.[1] ?? "";
  const cardRule = css.match(/\.first-value-guide-card\s*\{([^}]*)\}/u)?.[1] ?? "";
  const narrowStyles = css.slice(css.indexOf("@media (max-width: 620px)"));

  expect(actionRule).toContain("repeat(3, minmax(0, 1fr))");
  expect(cardRule).toContain("min-width: 0");
  expect(cardRule).toContain("overflow-wrap: anywhere");
  expect(narrowStyles).toMatch(/\.first-value-guide-actions\s*\{[^}]*grid-template-columns:\s*1fr/u);
});
