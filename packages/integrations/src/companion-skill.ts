import { inspectCompanionSkillWithProof } from "./companion-inspector-internal.js";
import {
  CompanionSkillError,
  companionSkillDirectory,
  type CompanionSkillInspection,
  type CompanionSkillStatus
} from "./companion-shared.js";

export {
  CompanionSkillError,
  companionSkillDirectory,
  type CompanionSkillInspection,
  type CompanionSkillStatus
};

export interface InspectCompanionSkillInput {
  home: string;
  sourceDirectory: string;
}

export async function inspectCompanionSkill(
  input: InspectCompanionSkillInput
): Promise<CompanionSkillInspection> {
  return inspectCompanionSkillWithProof({
    home: input.home,
    sourceDirectory: input.sourceDirectory
  });
}
