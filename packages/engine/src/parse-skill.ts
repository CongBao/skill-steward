import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  DiscoveredSkill,
  HarnessId,
  ParsedSkill,
  SkillFile,
  SkillScope
} from "./domain.js";
import { bundleFingerprint, sha256 } from "./fingerprint.js";

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
}).passthrough();

export const ignoredBundleDirectories = [
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  "coverage",
  "dist",
  "build",
  "target"
] as const;

const ignoredBundleDirectorySet = new Set<string>(ignoredBundleDirectories);

function splitFrontmatter(markdown: string): { attributes: unknown; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");

  return {
    attributes: YAML.parse(match[1] ?? ""),
    body: match[2] ?? ""
  };
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (ignoredBundleDirectorySet.has(entry.name)) continue;
      files.push(...await listFiles(root, absolute));
    }
    if (entry.isFile()) files.push(absolute);
  }

  return files.sort();
}

function mergedScope(skill: DiscoveredSkill): SkillScope {
  const scopes = new Set(skill.roots.map((root) => root.scope));
  if (scopes.size === 1) return skill.roots[0]?.scope ?? "unknown";
  return "unknown";
}

function visibleHarnesses(skill: DiscoveredSkill): HarnessId[] {
  return [...new Set(skill.roots.flatMap((root) => root.visibleTo))].sort() as HarnessId[];
}

export async function parseSkill(skill: DiscoveredSkill): Promise<ParsedSkill> {
  const markdown = await readFile(join(skill.path, "SKILL.md"), "utf8");
  const { attributes, body } = splitFrontmatter(markdown);
  const frontmatter = frontmatterSchema.parse(attributes);
  const absoluteFiles = await listFiles(skill.path);
  const files: SkillFile[] = [];

  for (const absolute of absoluteFiles) {
    const bytes = await readFile(absolute);
    const metadata = await stat(absolute);
    files.push({
      relativePath: relative(skill.path, absolute).split("\\").join("/"),
      sha256: sha256(bytes),
      bytes: metadata.size
    });
  }

  return {
    id: sha256(skill.path),
    name: frontmatter.name,
    description: frontmatter.description,
    path: skill.path,
    root: basename(skill.path),
    scope: mergedScope(skill),
    visibleTo: visibleHarnesses(skill),
    fingerprint: bundleFingerprint(files),
    files,
    estimatedTokens: Math.ceil((markdown.length + frontmatter.description.length) / 4),
    body
  };
}
