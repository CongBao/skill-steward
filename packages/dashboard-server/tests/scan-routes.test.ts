import { afterEach, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app.js";
import type { DashboardServices } from "../src/services.js";
import { report, snapshot } from "./fixtures.js";

const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it("allows only one scan at a time", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const services: DashboardServices = {
    dashboard: vi.fn(async () => snapshot),
    latestReport: vi.fn(async () => report),
    scan: vi.fn(async () => {
      await pending;
      return snapshot;
    }),
    history: vi.fn(async () => []),
    roots: vi.fn(async () => []),
    labelFinding: vi.fn(async () => undefined)
  };
  const { app } = createDashboardApp({ mutationToken: "token", services });
  apps.push(app);
  const request = {
    method: "POST" as const,
    url: "/api/v1/scans",
    headers: { "x-skill-steward-token": "token" },
    payload: { roots: [] }
  };
  const first = app.inject(request);
  await vi.waitFor(() => expect(services.scan).toHaveBeenCalledTimes(1));
  const second = await app.inject(request);

  expect(second.statusCode).toBe(409);
  expect(second.json()).toMatchObject({ error: { code: "SCAN_IN_PROGRESS" } });
  release?.();
  expect((await first).statusCode).toBe(200);
});
