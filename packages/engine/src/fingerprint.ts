import { createHash } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function bundleFingerprint(files: Array<{ relativePath: string; sha256: string }>): string {
  const canonical = [...files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => `${file.relativePath}\0${file.sha256}\0`)
    .join("");

  return sha256(canonical);
}
