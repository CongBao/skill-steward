import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { InstallerError } from "./domain.js";

export interface UploadedFile {
  relativePath: string;
  data: Buffer;
}

export interface FolderLimits {
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

export interface StagedFolderResult {
  fileCount: number;
  bytes: number;
}

export function normalizeSourcePath(input: string): string {
  const value = input.replaceAll("\\", "/");
  const segments = value.split("/");
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.length > 1024 ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".."
    )
  ) {
    throw new InstallerError("UNSAFE_SOURCE_PATH", `Unsafe source path '${input}'`);
  }
  return segments.join("/");
}

export async function stageFolderUpload(
  directory: string,
  files: UploadedFile[],
  limits: FolderLimits = {}
): Promise<StagedFolderResult> {
  const maxFiles = limits.maxFiles ?? 5_000;
  const maxBytes = limits.maxBytes ?? 50 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes ?? 10 * 1024 * 1024;
  if (files.length > maxFiles) {
    throw new InstallerError("SOURCE_LIMIT_EXCEEDED", "Folder contains too many files");
  }

  const root = resolve(directory);
  const seen = new Set<string>();
  let bytes = 0;
  const normalized = files.map((file) => {
    const relativePath = normalizeSourcePath(file.relativePath);
    const key = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new InstallerError(
        "UNSAFE_SOURCE_PATH",
        `Duplicate or case-colliding path '${relativePath}'`
      );
    }
    seen.add(key);
    if (file.data.byteLength > maxFileBytes) {
      throw new InstallerError("SOURCE_LIMIT_EXCEEDED", `File '${relativePath}' is too large`);
    }
    bytes += file.data.byteLength;
    return { ...file, relativePath };
  });
  if (bytes > maxBytes) {
    throw new InstallerError("SOURCE_LIMIT_EXCEEDED", "Folder exceeds the expanded byte limit");
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of normalized) {
    const target = resolve(root, file.relativePath);
    if (!target.startsWith(`${root}${sep}`)) {
      throw new InstallerError("UNSAFE_SOURCE_PATH", `Path escapes staging root`);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { flag: "wx", mode: 0o600 });
  }
  return { fileCount: normalized.length, bytes };
}
