import {
  access,
  mkdtemp,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceDataset, EvidenceEvent } from "@skill-steward/evidence";
import { describe, expect, it } from "vitest";
import {
  appendEvidenceEvent,
  applyEvidenceErasePlan,
  compactEvidenceEvents,
  EvidenceEventStoreError,
  planEvidenceErase,
  readEvidenceEvents,
  writeEvidenceExport
} from "../src/evidence-event-store.js";

const pseudonym = (character: string) => `hmac-sha256:${character.repeat(64)}` as const;

function eventFixture(index: number): EvidenceEvent {
  return {
    schemaVersion: 1,
    id: `event-${index.toString().padStart(3, "0")}`,
    createdAt: new Date(Date.parse("2026-07-03T00:00:00.000Z") - index * 1_000).toISOString(),
    kind: "preflight-delivered",
    harness: "codex",
    preflightId: `run-${index}`,
    algorithmVersion: 2,
    sessionKey: pseudonym("a")
  };
}

describe("evidence event store", () => {
  it("appends private events concurrently and compacts by retention and count", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-events-"));
    await Promise.all(Array.from({ length: 150 }, (_, index) =>
      appendEvidenceEvent(state, eventFixture(index))
    ));
    expect(await readEvidenceEvents(state)).toHaveLength(150);

    const compacted = await compactEvidenceEvents(state, {
      schemaVersion: 1,
      mode: "learning",
      retentionDays: 7,
      maxEvents: 100
    }, new Date("2026-07-03T00:00:00.000Z"));
    expect(compacted).toEqual({ before: 150, kept: 100, removed: 50 });
    const events = await readEvidenceEvents(state);
    expect(events).toHaveLength(100);
    expect(events.at(-1)?.id).toBe("event-000");
    expect((await stat(join(state, "evidence-events.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized events and a full journal with typed errors", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-events-bounds-"));
    await expect(appendEvidenceEvent(state, {
      ...eventFixture(1),
      id: "x".repeat(1_100)
    })).rejects.toMatchObject({ code: "EVIDENCE_EVENT_TOO_LARGE" });

    await writeFile(
      join(state, "evidence-events.jsonl"),
      Buffer.alloc(8 * 1024 * 1024, 0x20),
      { mode: 0o600 }
    );
    await expect(appendEvidenceEvent(state, eventFixture(2))).rejects.toMatchObject({
      code: "EVIDENCE_JOURNAL_FULL"
    });
  });

  it("preserves malformed journal bytes when compaction refuses the input", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-events-invalid-"));
    const path = join(state, "evidence-events.jsonl");
    await writeFile(path, `${JSON.stringify(eventFixture(1))}\nnot-json\n`, { mode: 0o600 });
    const before = await readFile(path);
    await expect(compactEvidenceEvents(state, {
      schemaVersion: 1,
      mode: "learning",
      retentionDays: 30,
      maxEvents: 5_000
    }, new Date("2026-07-03T00:00:00.000Z"))).rejects.toBeInstanceOf(
      EvidenceEventStoreError
    );
    expect(await readFile(path)).toEqual(before);
  });

  it("writes a private validated export and refuses accidental replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steward-export-"));
    const output = join(directory, "evidence.json");
    const dataset: EvidenceDataset = {
      schemaVersion: 1,
      preflights: [],
      events: [eventFixture(1)],
      installations: []
    };
    await writeEvidenceExport(output, dataset);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(dataset);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(writeEvidenceExport(output, dataset)).rejects.toMatchObject({
      code: "EVIDENCE_EXPORT_EXISTS"
    });
    await writeEvidenceExport(output, { ...dataset, events: [] }, { replace: true });
    expect(JSON.parse(await readFile(output, "utf8")).events).toEqual([]);
  });

  it("plans exact evidence erasure and refuses drift", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-erase-"));
    await writeFile(join(state, "preflights.json"), "{}\n", { mode: 0o600 });
    await writeFile(join(state, "evidence-salt"), Buffer.alloc(32, 1), { mode: 0o600 });
    await writeFile(join(state, "evidence-policy.json"), "keep-policy\n", { mode: 0o600 });
    await appendEvidenceEvent(state, eventFixture(1));

    const now = new Date("2026-07-03T00:00:00.000Z");
    const plan = await planEvidenceErase(state, { now, id: () => "erase-1" });
    expect(plan.paths.map(({ kind }) => kind).sort()).toEqual([
      "events", "preflights", "salt"
    ]);
    await writeFile(join(state, "preflights.json"), "drift\n", { mode: 0o600 });
    await expect(applyEvidenceErasePlan(state, plan, { now })).rejects.toMatchObject({
      code: "EVIDENCE_ERASE_DRIFT"
    });

    const refreshed = await planEvidenceErase(state, { now });
    await applyEvidenceErasePlan(state, refreshed, { now });
    for (const file of ["preflights.json", "evidence-events.jsonl", "evidence-salt"]) {
      await expect(access(join(state, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(state, "evidence-policy.json"), "utf8")).resolves.toBe(
      "keep-policy\n"
    );
  });
});
