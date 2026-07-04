import type { DiscoveredSkill, SkillRoot } from "./domain.js";
import type { InventoryPlanSource } from "./inventory/domain.js";
import { walkLegacyInventory } from "./inventory/walk.js";
import { standardRootCatalog } from "./root-catalog.js";

export function standardRoots(input: { home: string; cwd: string }): SkillRoot[] {
  return standardRootCatalog(input);
}

export async function discoverSkills(roots: SkillRoot[]): Promise<DiscoveredSkill[]> {
  const sources: InventoryPlanSource[] = roots.map((root, index) => ({
    id: `custom:${index}`,
    harness: root.visibleTo[0] ?? "unknown",
    scope: root.scope,
    kind: "direct-root",
    path: root.path,
    layout: "children",
    ownership: "direct",
    visibleTo: root.visibleTo,
    precedenceRank: index,
    status: "scanned"
  }));
  const result = await walkLegacyInventory({ sources });
  return result.candidates.map(({ path, roots: candidateRoots }) => ({
    path,
    roots: candidateRoots
  }));
}
