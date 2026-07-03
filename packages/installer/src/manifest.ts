import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  bundleFingerprint,
  ignoredBundleDirectories,
  sha256,
  type SkillFile
} from "@skill-steward/engine";

const ignored = new Set<string>(ignoredBundleDirectories);

export async function directoryManifest(
  root: string,
  current = root
): Promise<SkillFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: SkillFile[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) {
        files.push(...(await directoryManifest(root, absolute)));
      }
      continue;
    }
    const relativePath = relative(root, absolute).split("\\").join("/");
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute);
      files.push({
        relativePath,
        sha256: sha256(`symlink:${target}`),
        bytes: Buffer.byteLength(target)
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const data = await readFile(absolute);
    const metadata = await lstat(absolute);
    files.push({ relativePath, sha256: sha256(data), bytes: metadata.size });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function fingerprintDirectory(directory: string): Promise<string> {
  return bundleFingerprint(await directoryManifest(directory));
}
