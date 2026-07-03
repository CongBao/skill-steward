import { describe, expect, it } from "vitest";
import { normalizeTask, tokenize } from "../src/tokenize.js";

describe("tokenize", () => {
  it("normalizes Latin words, stop words, and common suffixes", () => {
    expect(tokenize).toBeDefined();
    expect(tokenize("Reviewing reviewed TESTS and security").terms).toEqual([
      "review",
      "reviewed",
      "test",
      "security"
    ]);
  });

  it("creates CJK characters and adjacent bigrams", () => {
    expect(tokenize("检查安全测试").terms).toEqual([
      "检",
      "查",
      "安",
      "全",
      "测",
      "试",
      "检查",
      "查安",
      "安全",
      "全测",
      "测试"
    ]);
  });

  it("is stable for mixed Unicode and repeated terms", () => {
    expect(normalizeTask("  ＡＰＩ API 安全安全  ")).toBe("API API 安全安全");
    expect(tokenize("ＡＰＩ API 安全安全")).toEqual({
      terms: ["api", "安", "全", "安全", "全安"],
      counts: { api: 2, "安": 2, "全": 2, "安全": 2, "全安": 1 }
    });
  });
});
