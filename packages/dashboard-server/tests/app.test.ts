import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../src/app.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it("serves packaged hashed assets and injects bootstrap data into the SPA index", async () => {
  const assetsDirectory = await mkdtemp(join(tmpdir(), "steward-assets-"));
  await mkdir(join(assetsDirectory, "assets"));
  await writeFile(
    join(assetsDirectory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
  );
  await writeFile(join(assetsDirectory, "assets", "app.js"), "window.loaded=true;");
  const { app } = createDashboardApp({ mutationToken: "test-token", assetsDirectory });
  apps.push(app);

  const asset = await app.inject({ url: "/assets/app.js" });
  const clientRoute = await app.inject({ url: "/skills" });
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["content-type"]).toContain("javascript");
  expect(clientRoute.body).toContain("__SKILL_STEWARD_BOOTSTRAP__");
  expect(clientRoute.body).toContain("test-token");
  expect(clientRoute.body).toContain("/assets/app.js");
});

it("returns JSON for missing APIs and the SPA shell for client routes", async () => {
  const { app } = createDashboardApp({ mutationToken: "test-token" });
  apps.push(app);
  const missingApi = await app.inject({ method: "GET", url: "/api/v1/missing" });
  const clientRoute = await app.inject({ method: "GET", url: "/skills" });

  expect(missingApi.statusCode).toBe(404);
  expect(missingApi.headers["content-type"]).toContain("application/json");
  expect(missingApi.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(clientRoute.statusCode).toBe(200);
  expect(clientRoute.headers["content-type"]).toContain("text/html");
  expect(clientRoute.body).toContain("__SKILL_STEWARD_BOOTSTRAP__");
});
