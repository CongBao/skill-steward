import { describe, expect, it } from "vitest";
import { extractCapabilities } from "../src/capabilities.js";

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

describe("bounded capability extraction", () => {
  it("extracts action, object, and local action-object pairs", () => {
    const result = extractCapabilities(
      "Plan the product specification requirements, implement the feature, test the CLI, and publish the GitHub release."
    );

    expect(sorted(result.actions)).toEqual(expect.arrayContaining([
      "plan",
      "implement",
      "test",
      "publish"
    ]));
    expect(sorted(result.objects)).toEqual(expect.arrayContaining([
      "specification",
      "requirement",
      "feature",
      "cli",
      "github",
      "release"
    ]));
    expect(sorted(result.pairs)).toEqual(expect.arrayContaining([
      "plan:specification",
      "plan:requirement",
      "implement:feature",
      "test:cli",
      "publish:github",
      "publish:release"
    ]));
  });

  it("maps equivalent simplified and traditional Chinese workflow intent", () => {
    const simplified = extractCapabilities(
      "先整理需求和设计方案，然后实现功能、测试 CLI，并发布 GitHub 版本。"
    );
    const traditional = extractCapabilities(
      "先整理需求和設計方案，然後實現功能、測試 CLI，並發布 GitHub 版本。"
    );

    expect(sorted(simplified.actions)).toEqual(sorted(traditional.actions));
    expect(sorted(simplified.objects)).toEqual(sorted(traditional.objects));
    expect(sorted(simplified.pairs)).toEqual(sorted(traditional.pairs));
    expect(sorted(simplified.actions)).toEqual(expect.arrayContaining([
      "plan",
      "design",
      "implement",
      "test",
      "publish"
    ]));
  });

  it("removes recognized negative clauses without hiding later positive work", () => {
    const result = extractCapabilities(
      "Do not publish a release or deploy the service; instead test the CLI and review the code."
    );

    expect(sorted(result.actions)).not.toContain("publish");
    expect(sorted(result.actions)).not.toContain("deploy");
    expect(sorted(result.actions)).toEqual(expect.arrayContaining(["test", "review"]));
    expect(sorted(result.pairs)).toEqual(expect.arrayContaining([
      "test:cli",
      "review:code"
    ]));
  });

  it("does not turn broad objects into action evidence", () => {
    const result = extractCapabilities(
      "Skills, code, agents, documents, and reviews are mentioned as background context."
    );

    expect(sorted(result.actions)).toEqual([]);
    expect(sorted(result.pairs)).toEqual([]);
    expect(sorted(result.objects)).toEqual(expect.arrayContaining([
      "skill",
      "code",
      "agent",
      "document",
      "review"
    ]));
  });

  it("keeps deterministic bounds for adversarially repeated input", () => {
    const text = Array.from({ length: 2_000 }, () =>
      "plan requirements implement feature test cli review code publish release"
    ).join(" ");
    const first = extractCapabilities(text);
    const second = extractCapabilities(text);

    expect(first).toEqual(second);
    expect(first.all.size).toBeLessThanOrEqual(48);
  });
});
