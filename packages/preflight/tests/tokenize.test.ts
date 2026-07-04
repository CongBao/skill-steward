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

  it("canonicalizes bounded Chinese and English technical concepts identically", () => {
    expect(tokenize(
      "维护长期会话中持续演进的需求，在上下文压缩后保留意图"
    ).terms).toEqual([
      "maintain",
      "long",
      "session",
      "evolve",
      "requirement",
      "context",
      "compaction",
      "preserve",
      "intent"
    ]);
    expect(tokenize(
      "Maintain evolving requirements across a long session after context compaction and preserve intent"
    ).terms).toEqual([
      "maintain",
      "evolve",
      "requirement",
      "across",
      "long",
      "session",
      "after",
      "context",
      "compaction",
      "preserve",
      "intent"
    ]);
    expect(tokenize("长对话 長對話 长会话 長會話")).toEqual({
      terms: ["long", "session"],
      counts: { long: 4, session: 4 }
    });
  });

  it("removes common Chinese request framing from capability terms", () => {
    expect(tokenize("请帮我处理这个任务并继续完成相关工作").terms).toEqual([]);
  });

  it("keeps routing normalization independent from gap display normalization", () => {
    expect(tokenize(
      "我们正在进行一个持续数周、需求会不断澄清的长对话开发项目，请在压缩后仍然维护需求"
    ).terms).toEqual([
      "正在",
      "一个",
      "数周",
      "requirement",
      "不断",
      "澄清",
      "long",
      "session",
      "开发",
      "项目",
      "请在",
      "compaction",
      "仍然",
      "maintain"
    ]);
    expect(tokenize(
      "Keep every evolving requirement accurate after context compaction"
    ).terms).toEqual([
      "keep",
      "every",
      "evolve",
      "requirement",
      "accurate",
      "after",
      "context",
      "compaction"
    ]);
  });

  it("keeps display-only creation concepts out of shared routing normalization", () => {
    expect(tokenize("制作文件 製作文件")).toEqual({
      terms: ["制作", "文件", "製作"],
      counts: { "制作": 1, "文件": 2, "製作": 1 }
    });
  });

  it.each([
    "中和",
    "的和",
    "和中",
    "在中",
    "与中"
  ])("keeps low-confidence two-character CJK fragments out of routing: %s", (value) => {
    expect(tokenize(value)).toEqual({ terms: [], counts: {} });
  });

  it("is stable for mixed Unicode and repeated terms", () => {
    expect(normalizeTask("  ＡＰＩ API 安全安全  ")).toBe("API API 安全安全");
    expect(tokenize("ＡＰＩ API 安全安全")).toEqual({
      terms: ["api", "安全"],
      counts: { api: 2, "安全": 2 }
    });
  });
});
