import {
  applyIntegrationPlan,
  installCompanionSkill,
  integrationHarnessSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  removeManagedCompanionSkill,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan,
  type IntegrationStatus
} from "@skill-steward/integrations";

const harnesses: IntegrationHarness[] = ["codex", "claude-code"];

export type IntegrationServiceErrorCode =
  | "INVALID_INTEGRATION_HARNESS"
  | "INTEGRATION_PLAN_REQUIRED";

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
  plan(harness: string): Promise<IntegrationPlan>;
  apply(harness: string): Promise<IntegrationStatus>;
  remove(harness: string): Promise<IntegrationStatus>;
}

export interface IntegrationServiceOptions {
  home: string;
  stateDirectory: string;
  companionSkillDirectory: string;
  now?: () => Date;
  id?: () => string;
}

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
  options: IntegrationServiceOptions
): IntegrationServices {
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
      const installed = await installCompanionSkill(companionOptions);
      try {
        await applyIntegrationPlan(plan, configOptions);
        plans.delete(harness);
      } catch (error) {
        if (installed.created) await removeManagedCompanionSkill(companionOptions);
        throw error;
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
