import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planInstallation } from "../src/planner.js";
import { rollbackInstallation } from "../src/rollback.js";
import { applyInstallationPlan } from "../src/transaction.js";
import { createSkill } from "./transaction-fixture.js";

describe("rollbackInstallation", () => {
  it("removes a newly installed Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-rollback-new-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    const sourceFingerprint = await createSkill(source, "new");
    const transaction = await applyInstallationPlan(
      await planInstallation({ source, sourceFingerprint, destination }),
      { stateDirectory }
    );

    await expect(
      rollbackInstallation(transaction.id, { stateDirectory })
    ).resolves.toMatchObject({ status: "rolled-back" });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a replaced Skill from backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-rollback-replace-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    const sourceFingerprint = await createSkill(source, "new");
    await createSkill(destination, "old");
    const transaction = await applyInstallationPlan(
      await planInstallation({ source, sourceFingerprint, destination, conflictAction: "replace" }),
      { stateDirectory }
    );

    await rollbackInstallation(transaction.id, { stateDirectory });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain("old");
  });

  it("refuses rollback after destination drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-rollback-drift-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    const sourceFingerprint = await createSkill(source, "new");
    const transaction = await applyInstallationPlan(
      await planInstallation({ source, sourceFingerprint, destination }),
      { stateDirectory }
    );
    await writeFile(join(destination, "changed.md"), "user change");

    await expect(
      rollbackInstallation(transaction.id, { stateDirectory })
    ).rejects.toMatchObject({ code: "DESTINATION_DRIFT" });
    await expect(access(join(destination, "changed.md"))).resolves.toBeUndefined();
  });
});
