import { join } from "node:path";
import type { CompanionSubplan } from "./companion-domain.js";

export class CompanionSkillError extends Error {
  constructor(
    message: string,
    public readonly code = "SHARED_SKILL_CONFLICT"
  ) {
    super(message);
    this.name = "CompanionSkillError";
  }
}

export function companionSkillDirectory(home: string): string {
  return join(home, ".agents", "skills", "skill-steward-preflight");
}

export type CompanionSkillStatus =
  | "current"
  | "upgrade-available"
  | "missing"
  | "conflict"
  | "unknown";

export interface CompanionSkillInspection {
  status: CompanionSkillStatus;
  reason: string;
  path: string;
  subplan: CompanionSubplan;
}
