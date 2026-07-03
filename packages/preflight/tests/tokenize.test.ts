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

  it("does not corrupt singular s words or doubled s after ing", () => {
    expect(tokenize("this does missing tests").terms).toEqual(["miss", "test"]);
  });

  it("keeps lexical double-l roots when removing ing", () => {
    expect(tokenize("installing install calling call filling fill").terms).toEqual([
      "install",
      "call",
      "fill"
    ]);
  });

  it("keeps common lexical double-consonant roots", () => {
    expect(tokenize("adding add erring err padding pad starring star").terms).toEqual([
      "add",
      "err",
      "pad",
      "star"
    ]);
  });

  it("removes generic workflow filler from capability terms", () => {
    expect(tokenize("Please create this change so it works").terms).toEqual(["work"]);
  });

  it("segments CJK text into words without single-character noise", () => {
    expect(tokenize("检查安全测试").terms).toEqual([
      "检查",
      "安全",
      "测试"
    ]);
  });

  it("removes generic Chinese workflow filler from routing terms", () => {
    expect(tokenize("继续推进当前阶段，完成产品测试并重新评估竞争力").terms).toEqual([
      "产品",
      "测试",
      "评估",
      "竞争"
    ]);
  });

  it("removes the same workflow filler from Traditional Chinese tasks", () => {
    expect(tokenize("繼續推進當前階段，完成產品測試並重新評估競爭力").terms).toEqual([
      "產品",
      "測試",
      "評估",
      "競爭力"
    ]);
  });

  it("removes broad Chinese request framing without dropping Skill intent", () => {
    expect(tokenize("Skill 用户整体测试").terms).toEqual(["skill", "测试"]);
  });

  it("is stable for mixed Unicode and repeated terms", () => {
    expect(normalizeTask("  ＡＰＩ API 安全安全  ")).toBe("API API 安全安全");
    expect(tokenize("ＡＰＩ API 安全安全")).toEqual({
      terms: ["api", "安全"],
      counts: { api: 2, "安全": 2 }
    });
  });
});
