import { join } from "node:path";
import type { HarnessId, SkillRoot } from "./domain.js";
import {
  openSpecToolDirectories,
  type OpenSpecToolId
} from "./tool-catalog.js";

export type InstallScope = "global" | "project";
export type InstallableHarnessId = "agents" | OpenSpecToolId;

export interface ResolveHarnessRootInput {
  harness: InstallableHarnessId;
  scope: InstallScope;
  home: string;
  workspace?: string;
}

const destinationOverrides: Partial<
  Record<InstallableHarnessId, { global: string; project: string }>
> = {
  agents: { global: ".agents/skills", project: ".agents/skills" },
  codex: { global: ".agents/skills", project: ".agents/skills" },
  claude: { global: ".claude/skills", project: ".claude/skills" },
  "github-copilot": {
    global: ".copilot/skills",
    project: ".github/skills"
  }
};

function defaultDirectory(harness: OpenSpecToolId): string {
  const match = openSpecToolDirectories.find(({ id }) => id === harness);
  if (!match) throw new Error(`Unsupported harness '${harness}'`);
  return match.skillDirectory;
}

export function resolveHarnessRoot(input: ResolveHarnessRootInput): string {
  const base =
    input.scope === "global"
      ? input.home
      : input.workspace;
  if (!base) throw new Error("A workspace is required for project scope");

  const override = destinationOverrides[input.harness];
  const relativeDirectory =
    override?.[input.scope] ??
    defaultDirectory(input.harness as OpenSpecToolId);
  return join(base, relativeDirectory);
}

function coalesceRoots(roots: SkillRoot[]): SkillRoot[] {
  const merged = new Map<string, SkillRoot>();
  for (const root of roots) {
    const key = `${root.scope}:${root.path}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...root, visibleTo: [...root.visibleTo] });
      continue;
    }
    existing.visibleTo = [
      ...new Set<HarnessId>([...existing.visibleTo, ...root.visibleTo])
    ].sort() as HarnessId[];
  }
  return [...merged.values()];
}

export function standardRootCatalog(input: {
  home: string;
  cwd: string;
}): SkillRoot[] {
  const roots: SkillRoot[] = [
    {
      path: join(input.home, ".agents/skills"),
      scope: "global",
      visibleTo: ["agents", "codex", "github-copilot"]
    },
    {
      path: join(input.cwd, ".agents/skills"),
      scope: "project",
      visibleTo: ["agents", "codex", "github-copilot"]
    },
    {
      path: join(input.home, ".copilot/skills"),
      scope: "global",
      visibleTo: ["github-copilot"]
    }
  ];

  for (const { id, skillDirectory } of openSpecToolDirectories) {
    roots.push(
      {
        path: join(input.home, skillDirectory),
        scope: "global",
        visibleTo: [id]
      },
      {
        path: join(input.cwd, skillDirectory),
        scope: "project",
        visibleTo: [id]
      }
    );
  }

  return coalesceRoots(roots);
}
