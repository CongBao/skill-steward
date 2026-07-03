import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintDirectory } from "../src/manifest.js";
import {
  installationPlanSchema,
  planInstallation
} from "../src/planner.js";

async function skill(directory: string, body: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: review\ndescription: review\n---\n${body}\n`
  );
  return fingerprintDirectory(directory);
}

describe("planInstallation", () => {
  it("plans create for a missing target and no-op for identical content", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-plan-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const sourceFingerprint = await skill(source, "instructions");

    const create = await planInstallation({ source, sourceFingerprint, destination });
    expect(create).toMatchObject({
      status: "ready",
      action: "create",
      expectedDestinationFingerprint: null,
      changes: [{ operation: "create", path: destination }]
    });

    await skill(destination, "instructions");
    const same = await planInstallation({ source, sourceFingerprint, destination });
    expect(same).toMatchObject({ status: "noop", action: "none", changes: [] });
  });

  it("stops on different content by default and only plans replacement explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-conflict-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const sourceFingerprint = await skill(source, "new");
    const oldFingerprint = await skill(destination, "old");

    const conflict = await planInstallation({ source, sourceFingerprint, destination });
    expect(conflict).toMatchObject({
      status: "conflict",
      action: "cancel",
      allowedActions: ["cancel", "rename", "replace"],
      expectedDestinationFingerprint: oldFingerprint
    });

    const replacement = await planInstallation({
      source,
      sourceFingerprint,
      destination,
      conflictAction: "replace"
    });
    expect(replacement.status).toBe("ready");
    expect(replacement.changes.map(({ operation }) => operation)).toEqual([
      "backup",
      "create"
    ]);
  });

  it("rejects source fingerprint drift before returning a plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-plan-drift-"));
    const source = join(root, "source");
    await skill(source, "instructions");

    await expect(
      planInstallation({
        source,
        sourceFingerprint: `sha256:${"f".repeat(64)}`,
        destination: join(root, "target")
      })
    ).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
  });

  it("strictly parses a complete installation plan at the trust boundary", () => {
    const source = "/private/tmp/staging/preview/source";
    const destination = "/Users/example/.agents/skills/review";
    const sourceFingerprint = `sha256:${"a".repeat(64)}`;
    const plan = {
      id: "48fd7ba6-3ab0-4d20-98ca-b20a1519ce5d",
      status: "ready",
      action: "replace",
      source,
      sourceFingerprint,
      destination,
      expectedDestinationFingerprint: `sha256:${"b".repeat(64)}`,
      allowedActions: ["cancel", "rename", "replace"],
      changes: [
        { operation: "backup", path: destination },
        { operation: "create", path: destination }
      ],
      createdAt: 1_000,
      expiresAt: 61_000,
      provenance: {
        preflightId: "run-1",
        candidateId: "review-candidate",
        sourceId: "public-catalog",
        sourceRevision: "c".repeat(40)
      }
    };

    expect(installationPlanSchema.parse(plan)).toEqual(plan);
  });

  it.each([
    ["extra field", { unexpected: true }],
    ["relative source", { source: "../../outside" }],
    ["invalid fingerprint", { sourceFingerprint: "sha256:not-a-fingerprint" }],
    ["invalid time order", { expiresAt: 1_000 }],
    ["inconsistent action", { action: "none" }],
    ["inconsistent change path", {
      changes: [{ operation: "create", path: "/tmp/another-target" }]
    }],
    ["invalid provenance", {
      provenance: {
        preflightId: "run-1",
        candidateId: "review-candidate",
        sourceId: "public-catalog",
        sourceRevision: "not-a-revision"
      }
    }]
  ])("rejects %s in a reviewed installation plan", (_label, override) => {
    const destination = "/Users/example/.agents/skills/review";
    const base = {
      id: "48fd7ba6-3ab0-4d20-98ca-b20a1519ce5d",
      status: "ready",
      action: "create",
      source: "/private/tmp/staging/preview/source",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      destination,
      expectedDestinationFingerprint: null,
      allowedActions: ["cancel", "rename", "replace"],
      changes: [{ operation: "create", path: destination }],
      createdAt: 1_000,
      expiresAt: 61_000,
      ...override
    };

    expect(installationPlanSchema.safeParse(base).success).toBe(false);
  });
});
