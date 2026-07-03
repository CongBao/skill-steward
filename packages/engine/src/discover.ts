import { access, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { DiscoveredSkill, SkillRoot } from "./domain.js";
import { standardRootCatalog } from "./root-catalog.js";

export function standardRoots(input: { home: string; cwd: string }): SkillRoot[] {
  return standardRootCatalog(input);
}

async function hasReadableSkillFile(path: string): Promise<boolean> {
  try {
    await access(join(path, "SKILL.md"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverSkills(roots: SkillRoot[]): Promise<DiscoveredSkill[]> {
  const byPhysicalPath = new Map<string, DiscoveredSkill>();

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(resolve(root.path), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = join(root.path, entry.name);
      if (!(await hasReadableSkillFile(candidate))) continue;

      const physicalPath = await realpath(candidate);
      const existing = byPhysicalPath.get(physicalPath);
      if (existing) existing.roots.push(root);
      else byPhysicalPath.set(physicalPath, { path: physicalPath, roots: [root] });
    }
  }

  return [...byPhysicalPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
