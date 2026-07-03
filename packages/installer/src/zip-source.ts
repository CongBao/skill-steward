import JSZip from "jszip";
import { InstallerError } from "./domain.js";
import {
  normalizeSourcePath,
  stageFolderUpload,
  type StagedFolderResult
} from "./folder-source.js";

export interface ZipLimits {
  maxCompressedBytes?: number;
  maxExpandedBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
}

function originalName(entry: JSZip.JSZipObject): string {
  return (
    entry as JSZip.JSZipObject & { unsafeOriginalName?: string }
  ).unsafeOriginalName ?? entry.name;
}

function isSymbolicLink(entry: JSZip.JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  return (
    typeof permissions === "number" &&
    (permissions & 0o170000) === 0o120000
  );
}

export async function stageZipArchive(
  destination: string,
  archive: Buffer,
  limits: ZipLimits = {}
): Promise<StagedFolderResult> {
  const maxCompressedBytes = limits.maxCompressedBytes ?? 20 * 1024 * 1024;
  const maxExpandedBytes = limits.maxExpandedBytes ?? 50 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 5_000;
  const maxFileBytes = limits.maxFileBytes ?? 10 * 1024 * 1024;
  if (archive.byteLength > maxCompressedBytes) {
    throw new InstallerError("SOURCE_LIMIT_EXCEEDED", "ZIP exceeds the compressed byte limit");
  }

  const zip = await JSZip.loadAsync(archive, {
    checkCRC32: true,
    createFolders: false
  });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > maxEntries) {
    throw new InstallerError("SOURCE_LIMIT_EXCEEDED", "ZIP contains too many entries");
  }

  const seen = new Set<string>();
  const files: Array<{ relativePath: string; data: Buffer }> = [];
  let expandedBytes = 0;
  for (const entry of entries) {
    if (isSymbolicLink(entry)) {
      throw new InstallerError("UNSAFE_SOURCE_PATH", `ZIP link '${entry.name}' is not allowed`);
    }
    const relativePath = normalizeSourcePath(originalName(entry));
    const collisionKey = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) {
      throw new InstallerError(
        "UNSAFE_SOURCE_PATH",
        `ZIP contains a duplicate or case-colliding path '${relativePath}'`
      );
    }
    seen.add(collisionKey);
    const data = await entry.async("nodebuffer");
    if (data.byteLength > maxFileBytes) {
      throw new InstallerError("SOURCE_LIMIT_EXCEEDED", `ZIP entry '${relativePath}' is too large`);
    }
    expandedBytes += data.byteLength;
    if (expandedBytes > maxExpandedBytes) {
      throw new InstallerError("SOURCE_LIMIT_EXCEEDED", "ZIP exceeds the expanded byte limit");
    }
    files.push({ relativePath, data });
  }

  return stageFolderUpload(destination, files, {
    maxFiles: maxEntries,
    maxBytes: maxExpandedBytes,
    maxFileBytes
  });
}
