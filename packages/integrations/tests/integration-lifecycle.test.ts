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
  integrationStatus,
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
  it("publishes separate v3 Hook and companion domains without Alpha aliases", async () => {
    const home = await mkdtemp(join(tmpdir(), "steward-public-status-v3-"));
    const value = await integrationStatus("codex", {
      home,
      stateDirectory: join(home, "state"),
      companionSourceDirectory: packagedCompanion
    });

    expect(value).toMatchObject({
      schemaVersion: 3,
      harness: "codex",
      hook: {
        status: "not-installed",
        reason: "HOOK_NOT_INSTALLED",
        target: join(home, ".codex", "hooks.json"),
        availability: { state: "available", available: true, reason: null }
      },
      companion: {
        status: "missing",
        reason: "COMPANION_MISSING",
        target: join(home, ".agents", "skills", "skill-steward-preflight"),
        proofCategory: "new",
        availability: { state: "available", available: true, reason: null }
      },
      availability: { state: "available", available: true, reason: null }
    });
    expect(value).not.toHaveProperty("status");
    expect(value).not.toHaveProperty("reason");
    expect(value).not.toHaveProperty("hookStatus");
  });

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
    await expect(integrationStatus("codex", options)).resolves.toMatchObject({
      schemaVersion: 3,
      hook: { lastChangedAt: "2026-07-05T00:00:00.000Z" },
      companion: { lastChangedAt: "2026-07-05T00:00:00.000Z" },
      lastChangedAt: "2026-07-05T00:00:00.000Z"
    });
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
    expect(disconnect).toMatchObject({
      companion: "removed",
      companionRetained: false,
      lastConsumer: true,
      remainingConsumers: 0
    });
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
    })).resolves.toMatchObject({
      outcome: "ready",
      hook: "removed",
      companion: "removed",
      cleanup: "clean",
      nextSafeAction: "none"
    });
    await expect(access(disconnect.targets.companion)).rejects.toMatchObject({ code: "ENOENT" });
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
