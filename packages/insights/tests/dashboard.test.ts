import { expect, it } from "vitest";
import { buildDashboardSnapshot } from "../src/dashboard.js";

it("builds a first-run snapshot without fabricating report data", () => {
  expect(
    buildDashboardSnapshot({ latest: undefined, previous: undefined, history: [], roots: [] })
  ).toMatchObject({
    status: "first-run",
    latest: null,
    kpis: [],
    priorityFindings: []
  });
});
