import {
  discoverSkills,
  standardRoots,
  type SkillRoot
} from "@skill-steward/engine";
import type { CliContext } from "../context.js";

export async function discoverCommand(
  options: { roots: string[]; json: boolean },
  context: CliContext
): Promise<number> {
  const roots: SkillRoot[] =
    options.roots.length > 0
      ? options.roots.map((path) => ({
          path,
          scope: "unknown",
          visibleTo: ["unknown"]
        }))
      : standardRoots({ home: context.home, cwd: context.cwd });
  const skills = await discoverSkills(roots);

  if (options.json) {
    context.stdout(`${JSON.stringify(skills, null, 2)}\n`);
  } else {
    context.stdout(
      skills.length === 0
        ? "No skills discovered.\n"
        : `${skills.map((skill) => skill.path).join("\n")}\n`
    );
  }
  return 0;
}
