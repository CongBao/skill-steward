import { access, cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  applyIntegrationPlanInternal,
  integrationPlanSchema,
  planIntegration as planIntegrationInternal
} from "../src/config.js";
import {
  applyIntegrationDisconnect,
  applyIntegrationPlan,
  planIntegration,
  planIntegrationDisconnect,
  removeLegacyIntegration
} from "../src/integration-lifecycle.js";

const packagedCompanion = fileURLToPath(new URL(
  "../assets/skill-steward-preflight",
  import.meta.url
));

function readinessReport() {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-07-05T00:01:00.000Z",
    portfolioFingerprint: `sha256:${"a".repeat(64)}`,
    skills: [],
    findings: []
  };
}

describe("public integration lifecycle compatibility", () => {
  it("rejects the wrong expected Harness before consuming a reviewed apply plan", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-public-harness-bind-apply-"));
    const options = {
      home,
      stateDirectory: join(home, "state"),
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T00:00:00.000Z")
    };
    const generateReadiness = vi.fn(async () => readinessReport());
    const plan = await planIntegration("codex", options);

    await expect(applyIntegrationPlan(plan.planId, {
      ...options,
      expectedHarness: "claude-code",
      generateReadiness
    })).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_MISMATCH",
      message: "Reviewed integration plan belongs to a different Harness"
    });
    expect(generateReadiness).not.toHaveBeenCalled();
    await expect(access(plan.targets.hook)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(applyIntegrationPlan(plan.planId, {
      ...options,
      expectedHarness: "codex",
      generateReadiness
    })).resolves.toMatchObject({ outcome: "ready", hook: "installed" });
  });

  it("rejects the wrong expected Harness before consuming a reviewed disconnect plan", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-public-harness-bind-disconnect-"));
    const options = {
      home,
      stateDirectory: join(home, "state"),
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T00:00:00.000Z")
    };
    const generateReadiness = vi.fn(async () => readinessReport());
    const create = await planIntegration("codex", options);
    await applyIntegrationPlan(create.planId, { ...options, generateReadiness });
    generateReadiness.mockClear();
    const disconnect = await planIntegrationDisconnect("codex", options);
    const before = await readFile(disconnect.targets.hook, "utf8");

    await expect(applyIntegrationDisconnect(disconnect.planId, {
      ...options,
      expectedHarness: "claude-code",
      generateReadiness
    })).rejects.toMatchObject({
      code: "INTEGRATION_PLAN_MISMATCH",
      message: "Reviewed integration plan belongs to a different Harness"
    });
    expect(generateReadiness).not.toHaveBeenCalled();
    expect(await readFile(disconnect.targets.hook, "utf8")).toBe(before);

    await expect(applyIntegrationDisconnect(disconnect.planId, {
      ...options,
      expectedHarness: "codex",
      generateReadiness
    })).resolves.toMatchObject({ outcome: "ready", hook: "removed" });
  });

  it("removes an exact pure-v1 integration through one high-level domain call", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-public-legacy-remove-"));
    const stateDirectory = join(home, "state");
    const companion = join(home, ".agents", "skills", "skill-steward-preflight");
    await mkdir(dirname(companion), { recursive: true });
    await cp(packagedCompanion, companion, { recursive: true });
    const options = {
      home,
      stateDirectory,
      companionSourceDirectory: packagedCompanion,
      now: () => new Date("2026-07-05T00:00:00.000Z")
    };
    const unowned = await planIntegrationInternal("codex", options);
    if (
      !("fingerprint" in unowned.companion.after)
      || unowned.companion.expectedBefore.state !== "exact"
    ) throw new Error("Expected exact current companion fixture");
    const fingerprint = unowned.companion.after.fingerprint;
    const plan = integrationPlanSchema.parse({
      ...unowned,
      companion: {
        ...unowned.companion,
        action: "none",
        expectedBefore: { state: "exact", fingerprint },
        proof: {
          kind: "recorded",
          recordId: "legacy-fixture-record",
          installedFingerprint: fingerprint
        }
      }
    });
    await applyIntegrationPlanInternal(plan, options);
    const config = join(home, ".codex", "hooks.json");
    expect(await readFile(config, "utf8")).toContain("skill-steward hook prompt");

    const receipt = await removeLegacyIntegration("codex", {
      ...options,
      generateReadiness: async () => readinessReport()
    });

    expect(receipt).toMatchObject({
      outcome: "removed",
      harness: "codex",
      readiness: "ready",
      companion: "retained"
    });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ hooks: {} });
    expect(await readFile(join(companion, "SKILL.md"), "utf8"))
      .toContain("name: skill-steward-preflight");
  });
});
