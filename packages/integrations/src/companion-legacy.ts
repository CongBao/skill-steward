import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readIntegrationRecordJournal } from "@skill-steward/store";
import type { IntegrationHarness } from "./domain.js";
import {
  companionTreeManifestSchema,
  type CompanionTreeManifest
} from "./companion-domain.js";
import { copilotHookConfig, copilotHookTarget } from "./config-adapters.js";

const legacyAlphaAllowlist = Object.freeze([
  Object.freeze({
    id: "skill-steward-preflight@0.3.0-alpha.1",
    fingerprints: Object.freeze({
      posix: "sha256:8a2cd894ed93650b66a85ec2c0b21be1193ea86d1daf154b63f7cce5b46491e9",
      win32: "sha256:35299b27a410876f9f2a8292a9b04aad707741833f74760ade956bd5aaafdd3e"
    })
  })
]);

const MAX_CANONICAL_CONFIG_BYTES = 1024 * 1024;

type ManagedProofResolution =
  | {
      state: "proven";
      proof: {
        kind: "recorded";
        recordId: string;
        installedFingerprint: string;
      } | {
        kind: "legacy-alpha";
        allowlistId: string;
        installedHookRecordId: string;
        canonicalConfigFingerprint: string;
        installedFingerprint: string;
      };
    }
  | { state: "conflict"; reason: string }
  | { state: "unknown"; reason: string };

type JsonObject = Record<string, unknown>;
type ManagedEvent = "UserPromptSubmit" | "Stop" | "SessionEnd";

export interface CompanionConfigProofOptions {
  lstatPath?: (path: string, options: { bigint: true }) => Promise<BigIntStats>;
  openFile?: (path: string, flags: number) => Promise<FileHandle>;
  platform?: NodeJS.Platform;
  realpathPath?: typeof realpath;
}

function hash(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonShape(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonShape(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJsonShape(left[key], right[key])
    );
}

function canonicalTarget(harness: IntegrationHarness, home: string): string {
  if (harness === "codex") return resolve(home, ".codex", "hooks.json");
  if (harness === "claude-code") return resolve(home, ".claude", "settings.json");
  return copilotHookTarget(home);
}

function managedEvents(harness: IntegrationHarness): ManagedEvent[] {
  if (harness === "codex") return ["UserPromptSubmit", "Stop"];
  if (harness === "claude-code") return ["UserPromptSubmit", "Stop", "SessionEnd"];
  return [];
}

function commandFor(harness: IntegrationHarness, event: ManagedEvent): string {
  const action = event === "UserPromptSubmit" ? "prompt" : "lifecycle";
  return `skill-steward hook ${action} --harness ${harness}`;
}

function eventGroups(config: JsonObject, event: ManagedEvent): unknown[] {
  const hooks = config.hooks;
  if (!isObject(hooks)) return [];
  const groups = hooks[event];
  return Array.isArray(groups) ? groups : [];
}

function installedEntryFingerprint(
  harness: IntegrationHarness,
  source: Buffer
):
  | { state: "exact"; fingerprint: string }
  | { state: "drift" }
  | { state: "invalid" } {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return { state: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { state: "invalid" };
  }
  if (harness === "github-copilot") {
    const expected = copilotHookConfig();
    return sameJsonShape(parsed, expected) && decoded === stableJson(expected)
      ? { state: "exact", fingerprint: hash(source) }
      : { state: "drift" };
  }
  if (!isObject(parsed)) return { state: "invalid" };
  const bundle = managedEvents(harness).flatMap((event) =>
    eventGroups(parsed, event).flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [];
      return group.hooks.some((hook) =>
        isObject(hook)
        && hook.type === "command"
        && hook.command === commandFor(harness, event)
      ) ? [{ event, group }] : [];
    })
  );
  return bundle.length === managedEvents(harness).length
    ? { state: "exact", fingerprint: hash(stableJson(bundle)) }
    : { state: "drift" };
}

type ConfigStats = BigIntStats;

function sameIdentity(left: ConfigStats, right: ConfigStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.isDirectory() === right.isDirectory()
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function identityIsProvable(metadata: ConfigStats, platform: NodeJS.Platform): boolean {
  return platform !== "win32" || metadata.ino !== 0n;
}

async function readBoundedConfig(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  let total = 0;
  while (true) {
    const remaining = MAX_CANONICAL_CONFIG_BYTES + 1 - total;
    if (remaining <= 0) throw new Error("Canonical config exceeds the byte limit");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    total += bytesRead;
  }
  if (total > MAX_CANONICAL_CONFIG_BYTES) {
    throw new Error("Canonical config exceeds the byte limit");
  }
  return Buffer.concat(chunks, total);
}

function canonicalAncestors(home: string, target: string): string[] {
  const homePath = resolve(home);
  const parent = dirname(target);
  const suffix = relative(homePath, parent);
  const ancestors = [homePath];
  let current = homePath;
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

function matchLegacyAlpha(manifest: CompanionTreeManifest): string | null {
  const exact = companionTreeManifestSchema.parse(manifest);
  return legacyAlphaAllowlist.find(
    (entry) => entry.fingerprints[exact.platform] === exact.fingerprint
  )?.id ?? null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readCanonicalConfig(
  home: string,
  record: { harness: IntegrationHarness; targetPath: string },
  options: CompanionConfigProofOptions = {}
): Promise<{ state: "exact"; fingerprint: string } | { state: "conflict" } | { state: "unknown" }> {
  const target = canonicalTarget(record.harness, home);
  if (record.targetPath !== target) return { state: "conflict" };
  const lstatPath = options.lstatPath ?? lstat;
  const openFile = options.openFile ?? open;
  const platform = options.platform ?? process.platform;
  const realpathPath = options.realpathPath ?? realpath;
  let handle: FileHandle | undefined;
  try {
    const ancestors = canonicalAncestors(home, target);
    const ancestorMetadata = await Promise.all(
      ancestors.map((path) => lstatPath(path, { bigint: true }))
    );
    if (ancestorMetadata.some((metadata) =>
      metadata.isSymbolicLink() || !metadata.isDirectory()
    )) return { state: "conflict" };
    if (ancestorMetadata.some((metadata) => !identityIsProvable(metadata, platform))) {
      return { state: "unknown" };
    }
    const metadata = await lstatPath(target, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) return { state: "conflict" };
    if (!identityIsProvable(metadata, platform)) return { state: "unknown" };
    const [physicalHome, physicalTarget] = await Promise.all([
      realpathPath(home),
      realpathPath(target)
    ]);
    if (!physicalTarget.startsWith(`${physicalHome}${sep}`)) return { state: "conflict" };
    const logicalHome = resolve(home);
    const expectedPhysicalTarget = resolve(
      physicalHome,
      target.slice(logicalHome.length + 1)
    );
    if (physicalTarget !== expectedPhysicalTarget) return { state: "conflict" };
    handle = await openFile(
      target,
      constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
    const opened = await handle.stat({ bigint: true });
    if (!identityIsProvable(opened, platform)) return { state: "unknown" };
    if (!opened.isFile() || !sameIdentity(metadata, opened)) return { state: "conflict" };
    if (opened.size > BigInt(MAX_CANONICAL_CONFIG_BYTES)) return { state: "unknown" };
    const source = await readBoundedConfig(handle);
    const afterRead = await handle.stat({ bigint: true });
    if (!identityIsProvable(afterRead, platform)) return { state: "unknown" };
    if (!sameIdentity(opened, afterRead) || BigInt(source.length) !== opened.size) {
      return { state: "conflict" };
    }
    const [currentTarget, currentAncestors, currentPhysicalTarget] = await Promise.all([
      lstatPath(target, { bigint: true }),
      Promise.all(ancestors.map((path) => lstatPath(path, { bigint: true }))),
      realpathPath(target)
    ]);
    if (
      !identityIsProvable(currentTarget, platform)
      || currentAncestors.some((current) => !identityIsProvable(current, platform))
    ) return { state: "unknown" };
    if (
      !sameIdentity(metadata, currentTarget)
      || currentAncestors.some((current, index) =>
        !sameIdentity(ancestorMetadata[index]!, current)
      )
      || currentPhysicalTarget !== physicalTarget
    ) return { state: "conflict" };
    const evidence = installedEntryFingerprint(record.harness, source);
    if (evidence.state === "invalid") return { state: "unknown" };
    if (evidence.state === "drift") return { state: "conflict" };
    return evidence;
  } catch (error) {
    return isMissing(error) ? { state: "conflict" } : { state: "unknown" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function resolveCompanionManagedProof(input: {
  home: string;
  stateDirectory: string;
  harness: IntegrationHarness;
  manifest: CompanionTreeManifest;
}, options: CompanionConfigProofOptions = {}): Promise<ManagedProofResolution> {
  let journal;
  try {
    journal = await readIntegrationRecordJournal(input.stateDirectory);
  } catch {
    return { state: "unknown", reason: "COMPANION_LIFECYCLE_RECORD_UNAVAILABLE" };
  }
  const { changedDuringRead, orderedRecords } = journal;
  if (changedDuringRead) {
    return { state: "unknown", reason: "COMPANION_LIFECYCLE_RECORD_UNPROVABLE" };
  }
  const companionHeadIndex = orderedRecords.findIndex((record) => record.schemaVersion === 2);
  if (companionHeadIndex > 0) {
    return { state: "unknown", reason: "COMPANION_LIFECYCLE_RECORD_UNPROVABLE" };
  }
  const companionHead = companionHeadIndex === -1
    ? undefined
    : orderedRecords[companionHeadIndex];
  const harnessHead = orderedRecords.find((record) => record.harness === input.harness);
  if (companionHead?.schemaVersion === 2) {
    const expectedPath = resolve(
      input.home,
      ".agents",
      "skills",
      "skill-steward-preflight"
    );
    if (
      companionHead.companion.path !== expectedPath
      || !companionHead.companion.consumers.includes(input.harness)
      || harnessHead?.status !== "installed"
    ) {
      return { state: "conflict", reason: "COMPANION_RECORDED_EVIDENCE_CONTRADICTORY" };
    }
    const config = await readCanonicalConfig(input.home, harnessHead, options);
    if (config.state === "unknown") {
      return { state: "unknown", reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE" };
    }
    if (
      config.state === "conflict"
      || config.fingerprint !== harnessHead.installedEntryFingerprint
    ) {
      return { state: "conflict", reason: "COMPANION_CANONICAL_CONFIG_DRIFT" };
    }
    return {
      state: "proven",
      proof: {
        kind: "recorded",
        recordId: companionHead.id,
        installedFingerprint: companionHead.companion.installedFingerprint
      }
    };
  }
  const allowlistId = matchLegacyAlpha(input.manifest);
  if (allowlistId === null) {
    return { state: "conflict", reason: "COMPANION_LEGACY_TREE_NOT_ALLOWLISTED" };
  }
  if (harnessHead?.schemaVersion !== 1 || harnessHead.status !== "installed") {
    return { state: "conflict", reason: "COMPANION_LEGACY_HOOK_RECORD_MISSING" };
  }
  const config = await readCanonicalConfig(input.home, harnessHead, options);
  if (config.state === "unknown") {
    return { state: "unknown", reason: "COMPANION_CANONICAL_CONFIG_UNAVAILABLE" };
  }
  if (
    config.state === "conflict"
    || config.fingerprint !== harnessHead.installedEntryFingerprint
  ) {
    return { state: "conflict", reason: "COMPANION_CANONICAL_CONFIG_DRIFT" };
  }
  return {
    state: "proven",
    proof: {
      kind: "legacy-alpha",
      allowlistId,
      installedHookRecordId: harnessHead.id,
      canonicalConfigFingerprint: config.fingerprint,
      installedFingerprint: input.manifest.fingerprint
    }
  };
}
