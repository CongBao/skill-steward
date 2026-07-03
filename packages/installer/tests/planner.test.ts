import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintDirectory } from "../src/manifest.js";
import { planInstallation } from "../src/planner.js";

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
});
