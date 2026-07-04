import { mkdirSync, renameSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  appendGovernanceTransaction,
  captureGovernanceStateCapability,
  readGovernanceTransactions,
  type GovernanceJournalAccessOptions,
  type GovernanceTransaction
} from "../src/index.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const execFileAsync = promisify(execFile);

function transaction(id: string): GovernanceTransaction {
  return {
    schemaVersion: 2,
    id,
    action: "quarantine",
    status: "quarantined",
    skillId: "skill-review",
    skillOwnership: { ownership: "direct" },
    originalPath: "/skills/review",
    vaultPath: "/state/quarantine/review",
    fingerprint,
    visibleAliases: [],
    createdAt: "2026-07-04T00:00:00.000Z"
  };
}

async function state(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe("governance journal", () => {
  it("creates and reads a private single-link journal", async () => {
    const stateDirectory = await state("steward-journal-new-");
    await appendGovernanceTransaction(stateDirectory, transaction("tx-new"));

    expect(await readGovernanceTransactions(stateDirectory))
      .toEqual([transaction("tx-new")]);
    const metadata = await lstat(join(stateDirectory, "governance.jsonl"));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("returns a durable receipt when the durable callback throws", async () => {
    const stateDirectory = await state("steward-journal-durable-callback-");
    const access: GovernanceJournalAccessOptions = {
      onDurable: () => { throw new Error("injected durable callback failure"); }
    };

    const receipt = await appendGovernanceTransaction(
      stateDirectory,
      transaction("tx-durable-callback"),
      access
    );

    expect(receipt).toMatchObject({
      durable: true,
      warnings: [{ code: "JOURNAL_DURABLE_CALLBACK_FAILED" }]
    });
    expect(await readGovernanceTransactions(stateDirectory))
      .toEqual([transaction("tx-durable-callback")]);
  });

  it.runIf(process.platform !== "win32")(
    "returns a durable receipt when state changes after sync",
    async () => {
      const stateDirectory = await state("steward-journal-durable-state-");
      const expectedState = await captureGovernanceStateCapability(stateDirectory);
      if (expectedState === undefined) throw new Error("Expected governance state");
      const parkedState = `${stateDirectory}-parked`;
      const access: GovernanceJournalAccessOptions = {
        expectedState,
        onDurable: () => {
          renameSync(stateDirectory, parkedState);
          mkdirSync(stateDirectory);
        }
      };

      const receipt = await appendGovernanceTransaction(
        stateDirectory,
        transaction("tx-durable-state"),
        access
      );

      expect(receipt).toMatchObject({
        durable: true,
        warnings: [{ code: "JOURNAL_DURABLE_STATE_CHANGED" }]
      });
      expect(await readGovernanceTransactions(parkedState))
        .toEqual([transaction("tx-durable-state")]);
      expect(await readGovernanceTransactions(stateDirectory)).toEqual([]);
    }
  );

  it("rejects a journal symlink for reads and appends without changing its target", async () => {
    const stateDirectory = await state("steward-journal-symlink-");
    const outside = join(await state("steward-journal-outside-"), "outside.jsonl");
    const original = `${JSON.stringify(transaction("outside"))}\n`;
    await writeFile(outside, original, { mode: 0o640 });
    await symlink(outside, join(stateDirectory, "governance.jsonl"));

    await expect(readGovernanceTransactions(stateDirectory))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });
    await expect(appendGovernanceTransaction(stateDirectory, transaction("tx-link")))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    expect(await readFile(outside, "utf8")).toBe(original);
    expect((await stat(outside)).mode & 0o777).toBe(0o640);
  });

  it("rejects a multiply-linked journal without changing the other name", async () => {
    const stateDirectory = await state("steward-journal-hardlink-");
    const outside = join(await state("steward-journal-hardlink-outside-"), "outside.jsonl");
    const original = `${JSON.stringify(transaction("outside-hardlink"))}\n`;
    await writeFile(outside, original, { mode: 0o640 });
    await link(outside, join(stateDirectory, "governance.jsonl"));

    await expect(appendGovernanceTransaction(stateDirectory, transaction("tx-hardlink")))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    expect(await readFile(outside, "utf8")).toBe(original);
    expect((await stat(outside)).mode & 0o777).toBe(0o640);
  });

  it("rejects a non-regular journal target without changing its permissions", async () => {
    const stateDirectory = await state("steward-journal-special-");
    const journalPath = join(stateDirectory, "governance.jsonl");
    await mkdir(journalPath, { mode: 0o750 });
    await chmod(journalPath, 0o750);

    await expect(appendGovernanceTransaction(stateDirectory, transaction("tx-special")))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    expect((await stat(journalPath)).mode & 0o777).toBe(0o750);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO journal without opening or changing it",
    async () => {
      const stateDirectory = await state("steward-journal-fifo-");
      const journalPath = join(stateDirectory, "governance.jsonl");
      await execFileAsync("mkfifo", [journalPath]);
      await chmod(journalPath, 0o640);

      await expect(appendGovernanceTransaction(stateDirectory, transaction("tx-fifo")))
        .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

      expect((await stat(journalPath)).mode & 0o777).toBe(0o640);
    }
  );

  it("rejects a symbolic-link state directory without creating an outside journal", async () => {
    const outsideState = await state("steward-journal-state-outside-");
    const aliasParent = await state("steward-journal-state-alias-");
    const stateAlias = join(aliasParent, "state-link");
    await symlink(outsideState, stateAlias, "dir");

    await expect(appendGovernanceTransaction(stateAlias, transaction("tx-state-alias")))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    await expect(lstat(join(outsideState, "governance.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recursively create through a symbolic-link ancestor", async () => {
    const outside = await state("steward-journal-ancestor-outside-");
    const base = await state("steward-journal-ancestor-base-");
    const linkedAncestor = join(base, "linked-parent");
    await symlink(outside, linkedAncestor, "dir");
    const requestedState = join(linkedAncestor, "created-outside", "state");

    await expect(appendGovernanceTransaction(requestedState, transaction("tx-ancestor-link")))
      .rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    await expect(lstat(join(outside, "created-outside")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a typed failure for a non-directory state ancestor", async () => {
    const base = await state("steward-journal-special-ancestor-");
    const fileAncestor = join(base, "not-a-directory");
    await writeFile(fileAncestor, "outside", { mode: 0o640 });

    await expect(appendGovernanceTransaction(
      join(fileAncestor, "state"),
      transaction("tx-special-ancestor")
    )).rejects.toMatchObject({ code: "JOURNAL_UNSAFE" });

    await expect(readFile(fileAncestor, "utf8")).resolves.toBe("outside");
  });
});
