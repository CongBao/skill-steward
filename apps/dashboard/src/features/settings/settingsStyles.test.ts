import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps reviewed integration target paths inspectable at every width", async () => {
  const css = await readFile(resolve(process.cwd(), "src/features/settings/settings.css"), "utf8");
  const rule = css.match(/\.integration-targets code\s*\{([^}]*)\}/u)?.[1] ?? "";

  expect(rule).toContain("overflow-wrap: anywhere");
  expect(rule).toContain("white-space: normal");
  expect(rule).not.toContain("text-overflow: ellipsis");
  expect(rule).not.toContain("overflow: hidden");
});
