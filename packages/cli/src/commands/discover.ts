import {
  discoverSkills,
  scanInventoryWithDiscovery,
  type SkillRoot
} from "@skill-steward/engine";
import type { CliContext } from "../context.js";

export async function discoverCommand(
  options: { roots: string[]; json: boolean },
  context: CliContext
): Promise<number> {
  const skills = options.roots.length > 0
    ? await discoverSkills(options.roots.map((path): SkillRoot => ({
        path,
        scope: "unknown",
        visibleTo: ["unknown"]
      })))
    : (await scanInventoryWithDiscovery({
        home: context.home,
        cwd: context.cwd
      })).discoveries;

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
