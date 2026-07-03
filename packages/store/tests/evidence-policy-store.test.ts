import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEvidencePolicyPlan,
  EvidencePolicyStoreError,
  planEvidencePolicyChange,
  readEvidencePolicy
} from "../src/evidence-policy-store.js";

describe("evidence policy store", () => {
  it("defaults to minimal and applies an exact private plan once", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-policy-"));
    expect(await readEvidencePolicy(state)).toEqual({
      schemaVersion: 1,
      mode: "minimal",
      retentionDays: 30,
      maxEvents: 5_000
    });
    const now = new Date("2026-07-03T00:00:00.000Z");
    const plan = await planEvidencePolicyChange(state, {
      mode: "learning",
      retentionDays: 45,
      maxEvents: 2_000
    }, { now, id: () => "policy-plan-1" });
    expect(plan).toMatchObject({ id: "policy-plan-1", before: { mode: "minimal" } });

    await applyEvidencePolicyPlan(state, plan, { now });
    expect((await readEvidencePolicy(state)).mode).toBe("learning");
    expect((await stat(join(state, "evidence-policy.json"))).mode & 0o777).toBe(0o600);
    await expect(applyEvidencePolicyPlan(state, plan, { now })).rejects.toMatchObject({
      code: "POLICY_DRIFT"
    });
  });

  it("refuses expired or drifted plans without replacing the policy", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-policy-drift-"));
    const now = new Date("2026-07-03T00:00:00.000Z");
    const plan = await planEvidencePolicyChange(state, {
      mode: "learning",
      retentionDays: 30,
      maxEvents: 5_000
    }, { now, ttlMs: 1_000 });
    await expect(applyEvidencePolicyPlan(
      state,
      plan,
      { now: new Date(now.getTime() + 1_001) }
    )).rejects.toMatchObject({ code: "POLICY_PLAN_EXPIRED" });

    await writeFile(join(state, "evidence-policy.json"), `${JSON.stringify({
      schemaVersion: 1,
      mode: "minimal",
      retentionDays: 60,
      maxEvents: 5_000
    })}\n`, { mode: 0o600 });
    await expect(applyEvidencePolicyPlan(state, plan, { now })).rejects.toBeInstanceOf(
      EvidencePolicyStoreError
    );
    expect((await readEvidencePolicy(state)).retentionDays).toBe(60);
  });
});
