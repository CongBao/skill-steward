import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  analyzeSingleSkill,
  ignoredBundleDirectories,
  parseSkill,
  sha256,
  type Finding,
  type SkillFile
} from "@skill-steward/engine";

export interface InstallCandidate {
  id: string;
  relativePath: string;
  name: string;
  description: string;
  fingerprint: string | null;
  files: SkillFile[];
  estimatedTokens: number;
  scripts: string[];
  executables: string[];
  findings: Finding[];
}

const ignored = new Set<string>(ignoredBundleDirectories);

async function findCandidateDirectories(
  root: string,
  current = root
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    return [current];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    candidates.push(...(await findCandidateDirectories(root, join(current, entry.name))));
  }
  return candidates;
}

function sourceRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || ".";
}

async function executableFiles(
  candidateDirectory: string,
  files: SkillFile[]
): Promise<string[]> {
  const result: string[] = [];
  for (const file of files) {
    const metadata = await stat(join(candidateDirectory, file.relativePath));
    if ((metadata.mode & 0o111) !== 0) result.push(file.relativePath);
  }
  return result;
}

export async function inspectStagedSkills(root: string): Promise<InstallCandidate[]> {
  const directories = (await findCandidateDirectories(root)).sort();
  const candidates: InstallCandidate[] = [];

  for (const directory of directories) {
    const relativePath = sourceRelative(root, directory);
    try {
      const parsed = await parseSkill({
        path: directory,
        roots: [
          {
            path: dirname(directory),
            scope: "unknown",
            visibleTo: ["unknown"]
          }
        ]
      });
      const findings = await analyzeSingleSkill(parsed);
      candidates.push({
        id: sha256(relativePath),
        relativePath,
        name: parsed.name,
        description: parsed.description,
        fingerprint: parsed.fingerprint,
        files: parsed.files,
        estimatedTokens: parsed.estimatedTokens,
        scripts: parsed.files
          .map(({ relativePath: file }) => file)
          .filter((file) => file.startsWith("scripts/")),
        executables: await executableFiles(directory, parsed.files),
        findings
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const findingInput = {
        code: "SKILL_PARSE_FAILED",
        severity: "error" as const,
        skillIds: [] as string[],
        summary: `Could not parse candidate at ${relativePath}.`,
        evidence: [message],
        recommendation: "Repair the SKILL.md frontmatter before installing this Skill.",
        confidence: 1
      };
      candidates.push({
        id: sha256(relativePath),
        relativePath,
        name: basename(directory),
        description: "",
        fingerprint: null,
        files: [],
        estimatedTokens: 0,
        scripts: [],
        executables: [],
        findings: [{ ...findingInput, id: sha256(JSON.stringify(findingInput)) }]
      });
    }
  }
  return candidates;
}
