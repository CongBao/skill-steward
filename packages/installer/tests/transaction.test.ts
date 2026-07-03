import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { fingerprintDirectory } from "../src/manifest.js";
import { planInstallation } from "../src/planner.js";
import { readInstallationHistory } from "../src/journal.js";
import { applyInstallationPlan } from "../src/transaction.js";
import { createSkill } from "./transaction-fixture.js";

describe("applyInstallationPlan", () => {
  it("atomically creates a Skill and journals the transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-transaction-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    const sourceFingerprint = await createSkill(source, "new");
    const plan = await planInstallation({ source, sourceFingerprint, destination });

    const result = await applyInstallationPlan(plan, { stateDirectory });

    expect(result).toMatchObject({
      status: "installed",
      destination,
      installedFingerprint: sourceFingerprint,
      previousFingerprint: null,
      backupDirectory: null
    });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain("new");
    expect(await readInstallationHistory(stateDirectory)).toMatchObject([
      { id: result.id, status: "installed", destination }
    ]);
    expect(result).not.toHaveProperty("provenance");
  });

  it("journals only strict recommendation provenance for reviewed installs", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-provenance-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    const sourceFingerprint = await createSkill(source, "recommended");
    const provenance = {
      preflightId: "run-1",
      candidateId: "testing-available",
      sourceId: "fixture-catalog",
      sourceRevision: "a".repeat(40)
    };
    const result = await applyInstallationPlan(await planInstallation({
      source,
      sourceFingerprint,
      destination,
      provenance
    }), { stateDirectory });

    expect(result.provenance).toEqual(provenance);
    const journal = await readFile(join(stateDirectory, "installations.jsonl"), "utf8");
    expect(journal).toContain('"preflightId":"run-1"');
    expect(journal).not.toMatch(/PRIVATE|prompt|https:\/\//);

    const invalid = await planInstallation({ source, sourceFingerprint, destination: join(root, "other") });
    (invalid as unknown as { provenance: unknown }).provenance = {
      ...provenance,
      task: "PRIVATE task"
    };
    await expect(applyInstallationPlan(invalid, { stateDirectory }))
      .rejects.toThrow();
  });

  it("backs up replacement and restores it if the post-backup step fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-compensate-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const sourceFingerprint = await createSkill(source, "new");
    const oldFingerprint = await createSkill(destination, "old");
    const plan = await planInstallation({
      source,
      sourceFingerprint,
      destination,
      conflictAction: "replace"
    });

    await expect(
      applyInstallationPlan(plan, {
        stateDirectory: join(root, "state"),
        afterBackup: () => {
          throw new Error("injected failure");
        }
      })
    ).rejects.toThrow("injected failure");
    expect(await fingerprintDirectory(destination)).toBe(oldFingerprint);
  });

  it("rejects expired plans and destination drift without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-transaction-drift-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const sourceFingerprint = await createSkill(source, "new");
    const expired = await planInstallation({
      source,
      sourceFingerprint,
      destination,
      now: 1_000,
      ttlMs: 100
    });
    await expect(
      applyInstallationPlan(expired, { stateDirectory: join(root, "state"), now: () => 1_101 })
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });

    const fresh = await planInstallation({ source, sourceFingerprint, destination });
    await createSkill(destination, "unexpected");
    await expect(
      applyInstallationPlan(fresh, { stateDirectory: join(root, "state") })
    ).rejects.toMatchObject({ code: "DESTINATION_DRIFT" });
    await expect(access(join(destination, "SKILL.md"))).resolves.toBeUndefined();
  });

  it("revalidates destination drift after the staged copy and before replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "steward-transaction-copy-race-"));
    const source = join(root, "source");
    const destination = join(root, "skills", "review");
    const stateDirectory = join(root, "state");
    await createSkill(source, "new");
    for (let start = 0; start < 1_500; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) =>
        writeFile(
          join(source, `payload-${String(start + offset).padStart(4, "0")}.txt`),
          "x".repeat(8_192)
        )
      ));
    }
    const sourceFingerprint = await fingerprintDirectory(source);
    await createSkill(destination, "old");
    const plan = await planInstallation({
      source,
      sourceFingerprint,
      destination,
      conflictAction: "replace"
    });

    const applying = applyInstallationPlan(plan, { stateDirectory });
    const parent = dirname(destination);
    const deadline = Date.now() + 10_000;
    while (!(await readdir(parent)).some((name) =>
      name.startsWith(".review.skill-steward-") && name.endsWith(".tmp")
    )) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for staged copy");
      await delay(1);
    }
    await createSkill(destination, "raced");

    await expect(applying).rejects.toMatchObject({ code: "DESTINATION_DRIFT" });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain("raced");
    expect(await readInstallationHistory(stateDirectory)).toEqual([]);
  }, 20_000);
});
