import { expect, it } from "vitest";
import { translation } from "./catalog.js";

it("uses natural discovery and Settings copy in both supported languages", () => {
  expect(translation("en-US", "evidence.emptyCopy")).toContain("here in the dashboard or from a connected Harness");
  expect(translation("zh-CN", "evidence.emptyCopy")).toContain("可以在看板中运行任务预检，也可以通过已连接的 Harness 运行");
  expect(translation("zh-CN", "settings.preview")).toBe("概览页实时预览");
  expect(translation("zh-CN", "settings.selected")).toBe("已选指标及顺序");
  expect(translation("en-US", "kpi.harness-coverage")).toBe("Harnesses with active Skills");
  expect(translation("zh-CN", "kpi.harness-coverage")).toBe("拥有活跃 Skills 的 Harness");
  expect(translation("en-US", "kpi.inventory-coverage")).toBe("Verified inventory coverage");
  expect(translation("zh-CN", "kpi.inventory-coverage")).toBe("已核验清单覆盖");
  expect(translation("zh-CN", "governance.operation.verify-staging")).toBe("校验暂存副本");
  expect(translation("zh-CN", "evidence.lifecycle.userExit")).toBe("用户退出");
});
