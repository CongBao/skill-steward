import { performance } from "node:perf_hooks";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendEvidenceEvent } from "../src/evidence-event-store.js";

it("keeps the p95 append latency below 25 ms across 1,000 local events", async () => {
  const state = await mkdtemp(join(tmpdir(), "steward-evidence-performance-"));
  const durations: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    await appendEvidenceEvent(state, {
      schemaVersion: 1,
      id: `benchmark-${index}`,
      createdAt: new Date(1_783_036_800_000 + index).toISOString(),
      kind: "prompt-observed",
      harness: "github-copilot",
      sessionKey: `hmac-sha256:${index.toString(16).padStart(64, "0")}`
    });
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  process.stdout.write(`[evidence-performance] events=1000 p95=${p95.toFixed(3)}ms budget=25ms\n`);
  expect(p95).toBeLessThan(25);
}, 30_000);
