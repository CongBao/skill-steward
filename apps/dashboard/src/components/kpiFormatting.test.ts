import { expect, it } from "vitest";
import { formatKpiValue } from "./kpiFormatting.js";

it("formats dashboard KPI values consistently and uses an em dash when data is missing", () => {
  expect(formatKpiValue(undefined, "en-US")).toBe("—");
  expect(formatKpiValue({ id: "estimated-context", value: 1_500, status: "neutral" }, "en-US")).toBe("1.5K");
  expect(formatKpiValue({ id: "finding-confidence", value: 88, status: "positive" }, "en-US")).toBe("88%");
  expect(formatKpiValue({ id: "root-availability", value: { available: 2, total: 3 }, status: "attention" }, "en-US")).toBe("2/3");
  expect(formatKpiValue({ id: "inventory-coverage", value: { verified: 2, total: 3 }, status: "attention" }, "en-US")).toBe("2/3");
});
