import { describe, expect, it } from "vitest";
import type { ParsedSkill } from "../src/domain.js";
import { analyzeSingleSkill } from "../src/rules/single-skill.js";

const skill: ParsedSkill = {
  id: "skill-1",
  name: "review-code",
  description: "Review code using /Users/alice/private/checklist.md",
  path: "/tmp/code-review",
  root: "code-review",
  scope: "global",
  visibleTo: ["agents"],
  fingerprint: `sha256:${"a".repeat(64)}`,
  files: [{ relativePath: "SKILL.md", sha256: `sha256:${"b".repeat(64)}`, bytes: 10 }],
  estimatedTokens: 100,
  body: "Read [missing](references/missing.md) and [outside](../secret.md)."
};

describe("analyzeSingleSkill", () => {
  it("reports only evidence-backed portability and reference issues", async () => {
    const findings = await analyzeSingleSkill(skill);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "NAME_DIRECTORY_MISMATCH",
      "BROKEN_RELATIVE_REFERENCE",
      "REFERENCE_ESCAPES_SKILL_ROOT",
      "USER_SPECIFIC_ABSOLUTE_PATH"
    ]));
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    expect(findings.every((finding) => finding.confidence >= 0.9)).toBe(true);
  });

  it("does not flag portable web URLs as local paths", async () => {
    const portable: ParsedSkill = {
      ...skill,
      name: "code-review",
      description: "Review code using https://example.com/checklist",
      body: "Read [docs](https://example.com/docs)."
    };

    const findings = await analyzeSingleSkill(portable);

    expect(findings.map((finding) => finding.code)).not.toContain("USER_SPECIFIC_ABSOLUTE_PATH");
    expect(findings.map((finding) => finding.code)).not.toContain("BROKEN_RELATIVE_REFERENCE");
  });
});
