import {
  applyIntegrationRecoveryPlan,
  applyIntegrationDisconnect,
  applyIntegrationPlan,
  integrationCapabilities,
  integrationHarnessSchema,
  integrationRecoveryStatus,
  integrationStatus,
  planIntegration,
  planIntegrationRecovery,
  planIntegrationDisconnect,
  removeLegacyIntegration,
  type IntegrationConfigOptions,
  type IntegrationDisconnectPlan,
  type IntegrationHarness,
  type IntegrationPlan,
  type IntegrationRecoveryPlan,
  type IntegrationRecoveryReceipt,
  type IntegrationRecoveryStatus,
  type IntegrationLegacyRemovalReceipt,
  type IntegrationStatus,
  type IntegrationTransactionReceipt
} from "@skill-steward/integrations";

const harnesses: IntegrationHarness[] = ["codex", "claude-code", "github-copilot"];

export type IntegrationServiceErrorCode =
  | "INVALID_INTEGRATION_HARNESS"
  | "INVALID_INTEGRATION_PLAN_REQUEST"
  | "INTEGRATION_PLAN_MISMATCH"
  | "INTEGRATION_PLAN_REQUIRED";

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

export interface IntegrationMutationResult {
  planId: string;
  action: "create" | "upgrade" | "connect" | "disconnect";
  receipt: IntegrationTransactionReceipt;
}

export interface IntegrationServices {
  list(): Promise<IntegrationStatus[]>;
  capabilities(): typeof integrationCapabilities;
  plan(harness: string): Promise<IntegrationPlan>;
  apply(harness: string, planId: string): Promise<IntegrationMutationResult>;
  planDisconnect(harness: string): Promise<IntegrationDisconnectPlan>;
  disconnect(harness: string, planId: string): Promise<IntegrationMutationResult>;
  removeLegacy(harness: string): Promise<IntegrationLegacyRemovalReceipt>;
  recoveryStatus(): Promise<IntegrationRecoveryStatus>;
  planRecovery(): Promise<IntegrationRecoveryPlan>;
  applyRecovery(planId: string): Promise<IntegrationRecoveryReceipt>;
}

export interface IntegrationServiceOptions {
  home: string;
  stateDirectory: string;
  companionSkillDirectory: string;
  generateReadiness: () => Promise<unknown>;
  now?: () => Date;
  id?: () => string;
}

export interface IntegrationServiceDependencies {
  plan: typeof planIntegration;
  applyPlan: typeof applyIntegrationPlan;
  status: typeof integrationStatus;
  planDisconnect: typeof planIntegrationDisconnect;
  applyDisconnect: typeof applyIntegrationDisconnect;
  removeLegacy: typeof removeLegacyIntegration;
  recoveryStatus: typeof integrationRecoveryStatus;
  planRecovery: typeof planIntegrationRecovery;
  applyRecovery: typeof applyIntegrationRecoveryPlan;
}

const integrationServiceDefaults: IntegrationServiceDependencies = {
  plan: planIntegration,
  applyPlan: applyIntegrationPlan,
  status: integrationStatus,
  planDisconnect: planIntegrationDisconnect,
  applyDisconnect: applyIntegrationDisconnect,
  removeLegacy: removeLegacyIntegration,
  recoveryStatus: integrationRecoveryStatus,
  planRecovery: planIntegrationRecovery,
  applyRecovery: applyIntegrationRecoveryPlan
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

function mutationAction(receipt: IntegrationTransactionReceipt): IntegrationMutationResult["action"] {
  if (receipt.hook === "removed") return "disconnect";
  if (receipt.companion === "created") return "create";
  if (receipt.companion === "upgraded") return "upgrade";
  return "connect";
}

export function createIntegrationServices(
  options: IntegrationServiceOptions,
  dependencyOverrides: Partial<IntegrationServiceDependencies> = {}
): IntegrationServices {
  const dependencies = { ...integrationServiceDefaults, ...dependencyOverrides };
  const configOptions: IntegrationConfigOptions = {
    home: options.home,
    stateDirectory: options.stateDirectory,
    companionSourceDirectory: options.companionSkillDirectory,
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {})
  };
  const transactionOptions = {
    ...configOptions,
    generateReadiness: options.generateReadiness
  };
  return {
    capabilities: () => integrationCapabilities,
    async list() {
      return Promise.all(harnesses.map((harness) => dependencies.status(harness, configOptions)));
    },
    async plan(value) {
      const harness = parseHarness(value);
      return dependencies.plan(harness, configOptions);
    },
    async apply(value, planId) {
      const harness = parseHarness(value);
      const receipt = await dependencies.applyPlan(planId, {
        ...transactionOptions,
        expectedHarness: harness
      });
      return { planId, action: mutationAction(receipt), receipt };
    },
    async planDisconnect(value) {
      const harness = parseHarness(value);
      return dependencies.planDisconnect(harness, configOptions);
    },
    async disconnect(value, planId) {
      const harness = parseHarness(value);
      const receipt = await dependencies.applyDisconnect(planId, {
        ...transactionOptions,
        expectedHarness: harness
      });
      return { planId, action: "disconnect", receipt };
    },
    async removeLegacy(value) {
      const harness = parseHarness(value);
      return dependencies.removeLegacy(harness, transactionOptions);
    },
    async recoveryStatus() {
      return dependencies.recoveryStatus({ stateDirectory: options.stateDirectory });
    },
    async planRecovery() {
      return dependencies.planRecovery({
        stateDirectory: options.stateDirectory,
        ...(options.now ? { now: options.now } : {})
      });
    },
    async applyRecovery(planId) {
      return dependencies.applyRecovery(planId, {
        home: options.home,
        stateDirectory: options.stateDirectory,
        ...(options.now ? { now: options.now } : {})
      });
    }
  };
}
