import type { FindingSummary, SkillSummary } from "../../api/client.js";

export function resolveFindingSkillNames(
  finding: Pick<FindingSummary, "skillIds">,
  skills: Array<Pick<SkillSummary, "id" | "name">>
): string[] {
  const namesById = new Map(skills.map((skill) => [skill.id, skill.name]));
  return finding.skillIds.flatMap((id) => {
    const name = namesById.get(id);
    return name ? [name] : [];
  });
}
