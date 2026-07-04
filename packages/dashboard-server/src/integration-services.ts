import {
  applyIntegrationPlan,
  integrationCapabilities,
  integrationHarnessSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  rollbackIntegrationPlan,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan,
  type IntegrationStatus
} from "@skill-steward/integrations";
import { withIntegrationMutationLease } from "@skill-steward/store";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];
const MAX_REVIEWED_INTEGRATION_PLANS = 128;
const retainedCompanionMessage =
  "Shared companion retained pending reviewed consumer-aware removal";

export type IntegrationServiceErrorCode =
  | "INVALID_INTEGRATION_HARNESS"
  | "INVALID_INTEGRATION_PLAN_REQUEST"
  | "INTEGRATION_PLAN_MISMATCH"
  | "INTEGRATION_PLAN_REQUIRED"
  | "INTEGRATION_BUSY"
  | "INTEGRATION_READINESS_FAILED"
  | "INTEGRATION_ROLLBACK_FAILED";

export class IntegrationServiceError extends Error {
  constructor(
    public readonly code: IntegrationServiceErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IntegrationServiceError";
  }
}

export interface IntegrationServices {
  list(): Promise<IntegrationStatus[]>;
  capabilities(): typeof integrationCapabilities;
  plan(harness: string): Promise<IntegrationPlan>;
  apply(harness: string, planId: string): Promise<IntegrationStatus>;
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
  removePlan: typeof removeIntegration;
  withLease: typeof withIntegrationMutationLease;
}

interface IntegrationServiceInternalDependencies extends IntegrationServiceDependencies {
  plan: typeof planIntegration;
}

const integrationServiceDefaults: IntegrationServiceInternalDependencies = {
  plan: planIntegration,
  applyPlan: applyIntegrationPlan,
  rollbackPlan: rollbackIntegrationPlan,
  removePlan: removeIntegration,
  withLease: withIntegrationMutationLease
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
  dependencyOverrides: Partial<IntegrationServiceInternalDependencies> = {}
): IntegrationServices {
  const dependencies = { ...integrationServiceDefaults, ...dependencyOverrides };
  const plans = new Map<string, IntegrationPlan>();
  const currentTime = () => options.now?.() ?? new Date();
  const prunePlans = () => {
    const now = currentTime().getTime();
    for (const [id, plan] of plans) {
      if (Date.parse(plan.expiresAt) <= now) plans.delete(id);
    }
    while (plans.size > MAX_REVIEWED_INTEGRATION_PLANS) {
      let oldest: { id: string; createdAt: number } | undefined;
      for (const [id, plan] of plans) {
        const createdAt = Date.parse(plan.createdAt);
        if (!oldest || createdAt < oldest.createdAt) oldest = { id, createdAt };
      }
      if (!oldest) break;
      plans.delete(oldest.id);
    }
  };
  const configOptions: IntegrationConfigOptions = {
    home: options.home,
    stateDirectory: options.stateDirectory,
    companionSourceDirectory: options.companionSkillDirectory,
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {})
  };
  return {
    capabilities: () => integrationCapabilities,
    async list() {
      return Promise.all(harnesses.map((harness) => integrationStatus(harness, configOptions)));
    },
    async plan(value) {
      const harness = parseHarness(value);
      prunePlans();
      const plan = await dependencies.plan(harness, configOptions);
      plans.set(plan.id, plan);
      prunePlans();
      return plan;
    },
    async apply(value, planId) {
      const harness = parseHarness(value);
      try {
        return await dependencies.withLease(options.stateDirectory, async () => {
          prunePlans();
          const plan = plans.get(planId);
          if (!plan) {
            throw new IntegrationServiceError(
              "INTEGRATION_PLAN_REQUIRED",
              "Review the current integration plan before applying it"
            );
          }
          if (plan.harness !== harness) {
            throw new IntegrationServiceError(
              "INTEGRATION_PLAN_MISMATCH",
              "The reviewed integration plan belongs to a different Harness"
            );
          }
          plans.delete(planId);
          await dependencies.applyPlan(plan, configOptions);
          try {
            await options.afterApply();
          } catch (readinessError) {
            const rollbackFailures: unknown[] = [];
            if (plan.changes.length > 0) {
              try {
                await dependencies.rollbackPlan(plan, configOptions);
              } catch (error) {
                rollbackFailures.push(error);
              }
            }
            if (rollbackFailures.length > 0) {
              const details = rollbackFailures.map((error) =>
                error instanceof Error ? error.message : String(error)
              );
              throw new IntegrationServiceError(
                "INTEGRATION_ROLLBACK_FAILED",
                `The initial readiness scan failed and rollback was incomplete: ${details.join("; ")}`,
                {
                  cause: new AggregateError(
                    [readinessError, ...rollbackFailures],
                    "Integration readiness and rollback both failed"
                  )
                }
              );
            }
            throw new IntegrationServiceError(
              "INTEGRATION_READINESS_FAILED",
              "The initial readiness scan failed; artifacts created by this apply were rolled back",
              { cause: readinessError }
            );
          }
          return integrationStatus(harness, configOptions);
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "INTEGRATION_BUSY") {
          throw new IntegrationServiceError("INTEGRATION_BUSY", error.message, { cause: error });
        }
        throw error;
      }
    },
    async remove(value) {
      const harness = parseHarness(value);
      try {
        return await dependencies.withLease(options.stateDirectory, async () => {
          prunePlans();
          await dependencies.removePlan(harness, configOptions);
          for (const [id, plan] of plans) {
            if (plan.harness === harness) plans.delete(id);
          }
          const status = await integrationStatus(harness, configOptions);
          return { ...status, message: retainedCompanionMessage };
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "INTEGRATION_BUSY") {
          throw new IntegrationServiceError("INTEGRATION_BUSY", error.message, { cause: error });
        }
        throw error;
      }
    }
  };
}
