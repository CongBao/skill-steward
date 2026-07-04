import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
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
import {
  InventoryError,
  type InventoryCandidateProof,
  type InventoryPathIdentity
} from "./inventory/domain.js";

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

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

function matchesIdentity(
  metadata: { dev: number; ino: number; birthtimeMs: number },
  expected: InventoryPathIdentity
): boolean {
  return metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.birthtimeMs === expected.birthtimeMs;
}

function containmentError(path: string): InventoryError {
  return new InventoryError(
    "INVENTORY_CANDIDATE_CONTAINMENT_CHANGED",
    `Skill containment changed after inventory walk: ${path}`
  );
}

async function assertTrustedCandidate(
  path: string,
  proof: InventoryCandidateProof
): Promise<void> {
  try {
    const rootMetadata = await lstat(proof.rootPath);
    const sourceMetadata = await lstat(proof.sourcePath);
    const candidateMetadata = await lstat(path);
    if (
      rootMetadata.isSymbolicLink() ||
      sourceMetadata.isSymbolicLink() ||
      candidateMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() ||
      !sourceMetadata.isDirectory() ||
      !candidateMetadata.isDirectory()
    ) {
      throw containmentError(path);
    }
    const [physicalRoot, physicalSource, physicalCandidate] = await Promise.all([
      realpath(proof.rootPath),
      realpath(proof.sourcePath),
      realpath(path)
    ]);
    if (
      physicalRoot !== proof.rootPath ||
      physicalSource !== proof.sourcePath ||
      physicalCandidate !== proof.candidatePath ||
      path !== proof.candidatePath ||
      !isContainedPath(physicalRoot, physicalSource) ||
      (
        (proof.candidateContainment ?? "source") === "source" &&
        !isContainedPath(physicalSource, physicalCandidate)
      ) ||
      (
        proof.candidateContainment === "root" &&
        !isContainedPath(physicalRoot, physicalCandidate)
      ) ||
      !matchesIdentity(rootMetadata, proof.rootIdentity) ||
      !matchesIdentity(sourceMetadata, proof.sourceIdentity) ||
      !matchesIdentity(candidateMetadata, proof.candidateIdentity)
    ) {
      throw containmentError(path);
    }
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw containmentError(path);
  }
}

async function assertTrustedBundlePath(
  path: string,
  proof: InventoryCandidateProof,
  expectedKind: "directory" | "file"
): Promise<void> {
  await assertTrustedCandidate(proof.candidatePath, proof);
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      (expectedKind === "directory" && !metadata.isDirectory()) ||
      (expectedKind === "file" && !metadata.isFile())
    ) {
      throw containmentError(path);
    }
    const physicalPath = await realpath(path);
    if (!isContainedPath(proof.candidatePath, physicalPath)) {
      throw containmentError(path);
    }
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw containmentError(path);
  }
}

async function listFiles(
  root: string,
  current = root,
  trustedProof?: InventoryCandidateProof
): Promise<string[]> {
  if (trustedProof) {
    await assertTrustedBundlePath(current, trustedProof, "directory");
  }
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (ignoredBundleDirectorySet.has(entry.name)) continue;
      files.push(...await listFiles(root, absolute, trustedProof));
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

export interface ParseSkillInput extends DiscoveredSkill {
  trustedProof?: InventoryCandidateProof;
}

export async function parseSkill(skill: ParseSkillInput): Promise<ParsedSkill> {
  const markerPath = join(skill.path, "SKILL.md");
  if (skill.trustedProof) {
    await assertTrustedCandidate(skill.path, skill.trustedProof);
    await assertTrustedBundlePath(markerPath, skill.trustedProof, "file");
  }
  const markdown = await readFile(markerPath, "utf8");
  const { attributes, body } = splitFrontmatter(markdown);
  const frontmatter = frontmatterSchema.parse(attributes);
  const absoluteFiles = await listFiles(skill.path, skill.path, skill.trustedProof);
  const files: SkillFile[] = [];

  for (const absolute of absoluteFiles) {
    if (skill.trustedProof) {
      await assertTrustedBundlePath(absolute, skill.trustedProof, "file");
    }
    const bytes = await readFile(absolute);
    files.push({
      relativePath: relative(skill.path, absolute).split("\\").join("/"),
      sha256: sha256(bytes),
      bytes: bytes.byteLength
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
