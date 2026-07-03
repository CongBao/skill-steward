import {
  applyIntegrationPlan,
  installCompanionSkill,
  integrationCapabilities,
  integrationHarnessSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  removeManagedCompanionSkill,
  rethrowAfterIntegrationApplyFailure,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan,
  type IntegrationStatus
} from "@skill-steward/integrations";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];

export type IntegrationServiceErrorCode =
  | "INVALID_INTEGRATION_HARNESS"
  | "INTEGRATION_PLAN_REQUIRED"
  | "INTEGRATION_READINESS_FAILED"
  | "INTEGRATION_ROLLBACK_FAILED";

export class IntegrationServiceError extends Error {
  constructor(
    public readonly code: IntegrationServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IntegrationServiceError";
  }
}

export interface IntegrationServices {
  list(): Promise<IntegrationStatus[]>;
  capabilities(): typeof integrationCapabilities;
  plan(harness: string): Promise<IntegrationPlan>;
  apply(harness: string): Promise<IntegrationStatus>;
  remove(harness: string): Promise<IntegrationStatus>;
}

export interface IntegrationServiceOptions {
  home: string;
  stateDirectory: string;
  companionSkillDirectory: string;
  afterApply: () => Promise<void>;
  now?: () => Date;
  id?: () => string;
}

export interface IntegrationServiceDependencies {
  applyPlan: typeof applyIntegrationPlan;
  rollbackPlan: typeof rollbackIntegrationPlan;
  removeCompanion: typeof removeManagedCompanionSkill;
}

const integrationServiceDefaults: IntegrationServiceDependencies = {
  applyPlan: applyIntegrationPlan,
  rollbackPlan: rollbackIntegrationPlan,
  removeCompanion: removeManagedCompanionSkill
};

function parseHarness(value: string): IntegrationHarness {
  const parsed = integrationHarnessSchema.safeParse(value);
  if (!parsed.success) {
    throw new IntegrationServiceError(
      "INVALID_INTEGRATION_HARNESS",
      `Unsupported Harness '${value}'`
    );
  }
  return parsed.data;
}

export function createIntegrationServices(
  options: IntegrationServiceOptions,
  dependencyOverrides: Partial<IntegrationServiceDependencies> = {}
): IntegrationServices {
  const dependencies = { ...integrationServiceDefaults, ...dependencyOverrides };
  const plans = new Map<IntegrationHarness, IntegrationPlan>();
  const configOptions: IntegrationConfigOptions = {
    home: options.home,
    stateDirectory: options.stateDirectory,
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {})
  };
  const companionOptions = {
    home: options.home,
    sourceDirectory: options.companionSkillDirectory
  };

  return {
    capabilities: () => integrationCapabilities,
    async list() {
      return Promise.all(harnesses.map((harness) => integrationStatus(harness, configOptions)));
    },
    async plan(value) {
      const harness = parseHarness(value);
      const plan = await planIntegration(harness, configOptions);
      plans.set(harness, plan);
      return plan;
    },
    async apply(value) {
      const harness = parseHarness(value);
      const plan = plans.get(harness);
      if (!plan) {
        throw new IntegrationServiceError(
          "INTEGRATION_PLAN_REQUIRED",
          "Review the current integration plan before applying it"
        );
      }
      plans.delete(harness);
      const installed = await installCompanionSkill(companionOptions);
      let applied = false;
      try {
        await dependencies.applyPlan(plan, configOptions);
        applied = true;
        try {
          await options.afterApply();
        } catch (readinessError) {
          const failures: string[] = [];
          if (plan.changes.length > 0) {
            try {
              await dependencies.rollbackPlan(plan, configOptions);
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (installed.created && failures.length === 0) {
            try {
              if (!await dependencies.removeCompanion(companionOptions)) {
                failures.push("Companion Skill changed before rollback");
              }
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (failures.length > 0) {
            throw new IntegrationServiceError(
              "INTEGRATION_ROLLBACK_FAILED",
              `The initial readiness scan failed and rollback was incomplete: ${failures.join("; ")}`
            );
          }
          throw new IntegrationServiceError(
            "INTEGRATION_READINESS_FAILED",
            "The initial readiness scan failed; artifacts created by this apply were rolled back"
          );
        }
      } catch (error) {
        return rethrowAfterIntegrationApplyFailure({
          error,
          companionCreated: !applied && installed.created,
          removeCompanion: () => dependencies.removeCompanion(companionOptions)
        });
      }
      return integrationStatus(harness, configOptions);
    },
    async remove(value) {
      const harness = parseHarness(value);
      await removeIntegration(harness, configOptions);
      plans.delete(harness);
      const statuses = await Promise.all(
        harnesses.map((entry) => integrationStatus(entry, configOptions))
      );
      if (!statuses.some(({ status }) => status === "installed" || status === "needs-trust")) {
        await removeManagedCompanionSkill(companionOptions);
      }
      return integrationStatus(harness, configOptions);
    }
  };
}
