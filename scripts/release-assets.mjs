import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const RELEASE_REPOSITORY = "CongBao/skill-steward";
export const RELEASE_MANIFEST = "release-manifest.json";
export const RELEASE_CHECKSUMS = "SHA256SUMS";
export const MAX_REGISTRY_METADATA_BYTES = 128 * 1024;
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_UNPACKED_PACKAGE_BYTES = 128 * 1024 * 1024;

export const NATIVE_TARGETS = Object.freeze(new Map([
  ["@skill-steward/rename-noreplace-darwin-arm64", Object.freeze(["darwin", "arm64", "none"])],
  ["@skill-steward/rename-noreplace-darwin-x64", Object.freeze(["darwin", "x64", "none"])],
  ["@skill-steward/rename-noreplace-linux-arm64-gnu", Object.freeze(["linux", "arm64", "gnu"])],
  ["@skill-steward/rename-noreplace-linux-arm64-musl", Object.freeze(["linux", "arm64", "musl"])],
  ["@skill-steward/rename-noreplace-linux-x64-gnu", Object.freeze(["linux", "x64", "gnu"])],
  ["@skill-steward/rename-noreplace-linux-x64-musl", Object.freeze(["linux", "x64", "musl"])]
]));

export function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(compareCodepoints), [...expected].sort(compareCodepoints));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(compareCodepoints).map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
}

export function packageAssetFilename(name, version) {
  const normalized = name.replace(/^@/u, "").replaceAll("/", "-");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error(`RELEASE_ASSET_NAME_INVALID: unsupported package name ${boundedDiagnostic(name)}`);
  }
  return `${normalized}-${version}.tgz`;
}

export function digest(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function sha256(bytes) {
  return digest("sha256", bytes);
}

export function sha512Integrity(bytes) {
  return `sha512-${digest("sha512", bytes, "base64")}`;
}

export function parseSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) {
    throw new Error("REGISTRY_INTEGRITY_INVALID: expected one canonical SHA-512 SRI digest");
  }
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    throw new Error("REGISTRY_INTEGRITY_INVALID: expected one canonical SHA-512 SRI digest");
  }
  return value;
}

export function validateSourceCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("RELEASE_SOURCE_COMMIT_INVALID: source commit must be a full lowercase Git SHA");
  }
  return value;
}

export function boundedDiagnostic(value, maximum = 2_048) {
  return String(value)
    .trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`)
    .slice(0, maximum);
}

export function nativeTarget(name) {
  const target = NATIVE_TARGETS.get(name);
  if (!target) throw new Error(`RELEASE_NATIVE_TARGET_INVALID: unknown native package ${boundedDiagnostic(name)}`);
  return target;
}
