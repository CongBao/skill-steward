import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

it("packages the built dashboard alongside the CLI binary", async () => {
  const dashboard = join(process.cwd(), "dist", "dashboard");
  await expect(access(join(dashboard, "index.html"))).resolves.toBeUndefined();
  const assets = await readdir(join(dashboard, "assets"));
  expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  expect(assets.some((name) => name.endsWith(".css"))).toBe(true);
  expect(await readFile(join(dashboard, "index.html"), "utf8")).toContain("/assets/");
  const javascript = (
    await Promise.all(
      assets
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(join(dashboard, "assets", name), "utf8"))
    )
  ).join("\n");
  expect(javascript).toContain("/api/v1/preflights");
  expect(javascript).toContain("Task preflight");
});
