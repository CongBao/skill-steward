import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  companionSubplanSchema,
  companionTreeManifestSchema,
  createCompanionTreeManifest,
  type CompanionTreeEntry
} from "../src/companion-domain.js";

const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;

function manifest(character = "a") {
  const entries: CompanionTreeEntry[] = [
    {
      relativePath: ".",
      kind: "directory",
      bytes: 0,
      securityMode: "posix:0755"
    },
    {
      relativePath: "SKILL.md",
      kind: "file",
      bytes: 5,
      sha256: fingerprint(character),
      securityMode: "posix:0644"
    }
  ];
  return createCompanionTreeManifest("posix", entries);
}

function rawManifest(
  platform: "posix" | "win32",
  entries: Array<Record<string, unknown>>
) {
  const body = { schemaVersion: 1 as const, platform, entries };
  return {
    ...body,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`
  };
}

const directory = (relativePath: string, securityMode = "posix:0755") => ({
  relativePath,
  kind: "directory" as const,
  bytes: 0 as const,
  securityMode
});

const file = (relativePath: string, securityMode = "posix:0644") => ({
  relativePath,
  kind: "file" as const,
  bytes: 1,
  sha256: fingerprint("d"),
  securityMode
});

describe("companionTreeManifestSchema", () => {
  it("rejects unordered creator input instead of silently sorting it", () => {
    const entries = [
      directory("."),
      file("z.txt"),
      file("a.txt")
    ];
    expect(() => createCompanionTreeManifest("posix", entries)).toThrow(/lexical order/i);
    expect(entries.map(({ relativePath }) => relativePath)).toEqual([".", "z.txt", "a.txt"]);
  });

  it.each([
    ["case", [directory("."), file("README.md"), file("readme.md")]],
    ["Unicode normalization", [directory("."), file("e\u0301.md"), file("\u00e9.md")]]
  ])("rejects %s path collisions", (_label, entries) => {
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", entries)).success)
      .toBe(false);
  });

  it.each([
    ["a missing parent", [directory("."), file("references/guide.md")]],
    ["a file ancestor", [directory("."), file("references"), file("references/guide.md")]]
  ])("rejects %s", (_label, entries) => {
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", entries)).success)
      .toBe(false);
  });

  it("rejects paths deeper than the traversal ceiling", () => {
    const parts = Array.from({ length: 17 }, (_, index) => `d${String(index).padStart(2, "0")}`);
    const entries: Array<Record<string, unknown>> = [directory(".")];
    for (let index = 1; index <= parts.length; index += 1) {
      entries.push(directory(parts.slice(0, index).join("/")));
    }
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", entries)).success)
      .toBe(false);
  });

  it("rejects entry, individual-file, and total-byte ceiling violations", () => {
    const tooMany = [
      directory("."),
      ...Array.from({ length: 512 }, (_, index) => file(`f-${String(index).padStart(3, "0")}`))
    ];
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", tooMany)).success)
      .toBe(false);

    const oversizedFile = {
      ...file("large.bin"),
      bytes: 512 * 1024 + 1
    };
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", [
      directory("."),
      oversizedFile
    ])).success).toBe(false);

    const totalTooLarge = [
      directory("."),
      ...Array.from({ length: 5 }, (_, index) => ({
        ...file(`large-${index}.bin`),
        bytes: 512 * 1024
      }))
    ];
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", totalTooLarge)).success)
      .toBe(false);
  });

  it.each([
    ["posix", "win32:writable"],
    ["win32", "posix:0644"]
  ] as const)("rejects security modes inconsistent with %s", (platform, mode) => {
    expect(companionTreeManifestSchema.safeParse(rawManifest(platform, [
      directory(".", mode)
    ])).success).toBe(false);
  });

  it("rejects unsupported entry types even with a matching fingerprint", () => {
    expect(companionTreeManifestSchema.safeParse(rawManifest("posix", [
      directory("."),
      { relativePath: "linked", kind: "symlink", bytes: 0, securityMode: "posix:0777" }
    ])).success).toBe(false);
  });
});

function subplan(action: "none" | "create" | "upgrade" | "conflict") {
  const after = manifest();
  const base = {
    action,
    path: "/home/.agents/skills/skill-steward-preflight",
    after,
    source: {
      path: "/package/skill-steward-preflight",
      fingerprint: after.fingerprint
    }
  };
  if (action === "create") {
    return { ...base, expectedBefore: { state: "absent" }, proof: { kind: "new" } };
  }
  if (action === "none") {
    return {
      ...base,
      expectedBefore: { state: "exact", fingerprint: after.fingerprint },
      proof: {
        kind: "recorded",
        recordId: "record-current",
        installedFingerprint: after.fingerprint
      }
    };
  }
  if (action === "upgrade") {
    return {
      ...base,
      expectedBefore: { state: "exact", fingerprint: fingerprint("b") },
      proof: {
        kind: "recorded",
        recordId: "record-1",
        installedFingerprint: fingerprint("b")
      }
    };
  }
  return {
    ...base,
    expectedBefore: { state: "unknown", reason: "COMPANION_TREE_UNREADABLE" },
    proof: { kind: "unknown", reason: "COMPANION_TREE_UNREADABLE" }
  };
}

const sourceUnprovableReason = "COMPANION_SOURCE_UNPROVABLE";

function unavailableSubplan() {
  return {
    action: "conflict" as const,
    path: "/home/.agents/skills/skill-steward-preflight",
    expectedBefore: { state: "unknown" as const, reason: sourceUnprovableReason },
    after: { state: "unavailable" as const, reason: sourceUnprovableReason },
    source: {
      path: "/package/skill-steward-preflight",
      state: "unavailable" as const,
      reason: sourceUnprovableReason
    },
    proof: { kind: "unknown" as const, reason: sourceUnprovableReason }
  };
}

describe("companionSubplanSchema", () => {
  it.each(["none", "create", "upgrade", "conflict"] as const)(
    "accepts a complete internally consistent %s subplan",
    (action) => {
      expect(companionSubplanSchema.parse(subplan(action))).toMatchObject({ action });
    }
  );

  it.each(["path", "expectedBefore", "after", "source", "proof"] as const)(
    "requires %s",
    (field) => {
      const input = { ...subplan("create") } as Record<string, unknown>;
      delete input[field];
      expect(companionSubplanSchema.safeParse(input).success).toBe(false);
    }
  );

  it("rejects extra fields and action/proof mismatches", () => {
    expect(companionSubplanSchema.safeParse({
      ...subplan("create"),
      unexpected: true
    }).success).toBe(false);
    expect(companionSubplanSchema.safeParse({
      ...subplan("create"),
      proof: { kind: "conflict", reason: "COMPANION_UNMANAGED_TREE" }
    }).success).toBe(false);
    expect(companionSubplanSchema.safeParse({
      ...subplan("none"),
      proof: { kind: "package-match", fingerprint: manifest().fingerprint }
    }).success).toBe(false);
  });

  it("binds the source and expected state to the manifest fingerprints", () => {
    expect(companionSubplanSchema.safeParse({
      ...subplan("none"),
      source: { path: "/package/skill", fingerprint: fingerprint("c") }
    }).success).toBe(false);
    expect(companionSubplanSchema.safeParse({
      ...subplan("upgrade"),
      expectedBefore: { state: "exact", fingerprint: fingerprint("c") }
    }).success).toBe(false);
  });

  it("accepts a strict source-unavailable conflict with all five reason-bound fields", () => {
    expect(companionSubplanSchema.parse(unavailableSubplan())).toEqual(unavailableSubplan());
  });

  it.each(["none", "create", "upgrade"] as const)(
    "rejects unavailable source evidence for %s",
    (action) => {
      expect(companionSubplanSchema.safeParse({
        ...unavailableSubplan(),
        action
      }).success).toBe(false);
    }
  );

  it.each(["expectedBefore", "after", "source", "proof"] as const)(
    "rejects a source-unavailable conflict whose %s reason differs",
    (field) => {
      const plan = unavailableSubplan();
      expect(companionSubplanSchema.safeParse({
        ...plan,
        [field]: { ...plan[field], reason: "COMPANION_DIFFERENT_REASON" }
      }).success).toBe(false);
    }
  );

  it("rejects extra or fabricated fingerprint fields in unavailable descriptors", () => {
    const plan = unavailableSubplan();
    expect(companionSubplanSchema.safeParse({
      ...plan,
      after: { ...plan.after, fingerprint: fingerprint("e") }
    }).success).toBe(false);
    expect(companionSubplanSchema.safeParse({
      ...plan,
      source: { ...plan.source, fingerprint: fingerprint("e") }
    }).success).toBe(false);
  });
});
