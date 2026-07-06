import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { scanInventory } from "@skill-steward/engine";
import {
  applyIntegrationRecoveryPlan,
  applyIntegrationDisconnect,
  applyIntegrationPlan,
  integrationHarnessSchema,
  integrationRecoveryStatus,
  integrationStatus,
  planIntegration,
  planIntegrationRecovery,
  planIntegrationDisconnect,
  removeLegacyIntegration,
  serializePublicIntegrationError,
  type IntegrationConfigOptions,
  type IntegrationDisconnectPlan,
  type IntegrationHarness,
  type IntegrationPlan,
  type IntegrationRecoveryPlan,
  type IntegrationRecoveryReceipt,
  type IntegrationRecoveryStatus,
  type IntegrationTransactionOptions,
  type IntegrationTransactionReceipt
} from "@skill-steward/integrations";
import type { CliContext } from "../context.js";
import { reviewedPlanRetryHint } from "../reviewed-plan.js";
import { terminalSafeText } from "../terminal.js";

const allHarnesses = ["codex", "claude-code", "github-copilot"] as const;

export interface IntegrateApplyOptions {
  plan?: string;
  harness?: string;
  confirm: boolean;
  json: boolean;
}

export interface IntegrateApplyDependencies {
  applyPlan: typeof applyIntegrationPlan;
}

const integrateApplyDefaults: IntegrateApplyDependencies = {
  applyPlan: applyIntegrationPlan
};

export interface IntegrateRemoveOptions {
  plan?: string;
  harness?: string;
  confirm: boolean;
  json: boolean;
}

export interface IntegrateRemoveDependencies {
  planDisconnect: typeof planIntegrationDisconnect;
  applyDisconnect: typeof applyIntegrationDisconnect;
  removeLegacy: typeof removeLegacyIntegration;
}

export interface IntegrateRecoveryApplyOptions {
  plan?: string;
  confirm: boolean;
  json: boolean;
}

export interface IntegrateRecoveryDependencies {
  status: typeof integrationRecoveryStatus;
  plan: typeof planIntegrationRecovery;
  apply: typeof applyIntegrationRecoveryPlan;
}

const integrateRecoveryDefaults: IntegrateRecoveryDependencies = {
  status: integrationRecoveryStatus,
  plan: planIntegrationRecovery,
  apply: applyIntegrationRecoveryPlan
};

const integrateRemoveDefaults: IntegrateRemoveDependencies = {
  planDisconnect: planIntegrationDisconnect,
  applyDisconnect: applyIntegrationDisconnect,
  removeLegacy: removeLegacyIntegration
};

class IntegrateCommandError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrateCommandError";
  }
}

function parseHarness(value: string): IntegrationHarness {
  const parsed = integrationHarnessSchema.safeParse(value);
  if (!parsed.success) {
    throw new IntegrateCommandError(
      "INVALID_INTEGRATION_HARNESS",
      "The requested integration Harness is not supported."
    );
  }
  return parsed.data;
}

function packagedSkillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith(join("src", "commands"))
    ? resolve(moduleDirectory, "../../../integrations/assets/skill-steward-preflight")
    : resolve(moduleDirectory, "integrations/skill-steward-preflight");
}

function configOptions(context: CliContext): IntegrationConfigOptions {
  return {
    home: context.home,
    stateDirectory: context.stateDir,
    companionSourceDirectory: packagedSkillDirectory(),
    ...(context.now ? { now: context.now } : {})
  };
}

function transactionOptions(context: CliContext): IntegrationTransactionOptions {
  return {
    ...configOptions(context),
    generateReadiness: async () => scanInventory(
      { home: context.home, cwd: context.cwd },
      context.now?.() ?? new Date()
    )
  };
}

function actionLabel(action: IntegrationPlan["action"] | "disconnect"): string {
  if (action === "create") return "Create companion Skill";
  if (action === "upgrade") return "Upgrade companion Skill";
  if (action === "connect") return "Connect Harness";
  if (action === "disconnect") return "Disconnect Harness";
  return "Review unavailable integration";
}

function printPlan(
  plan: IntegrationPlan | IntegrationDisconnectPlan,
  context: CliContext,
  json: boolean,
  command: "apply" | "remove"
): void {
  const applyCommand = plan.availability.available
    ? `skill-steward integrate ${command} --plan ${plan.planId} --confirm`
    : null;
  if (json) {
    context.stdout(`${JSON.stringify({ ...plan, applyCommand }, null, 2)}\n`);
    return;
  }
  const lines = [
    `${actionLabel(plan.action)}: ${terminalSafeText(plan.harness)}`,
    `Hook target: ${terminalSafeText(plan.targets.hook)}`,
    `Companion target: ${terminalSafeText(plan.targets.companion)}`,
    `Fingerprint category: ${plan.fingerprintCategory}`,
    `Plan ID: ${terminalSafeText(plan.planId)}`,
    `Expires: ${plan.expiresAt}`,
    ...(applyCommand
      ? [`Confirm: ${applyCommand}`]
      : [
          "Mutation: unavailable for this reviewed plan.",
          `Reason: ${plan.availability.reason}`
        ]),
    ...(plan.action === "disconnect"
      ? plan.companion === "removed"
        ? ["The exact managed companion Skill will be removed with the last consumer."]
        : [`The companion Skill will be retained for ${plan.remainingConsumers} active consumer${plan.remainingConsumers === 1 ? "" : "s"}.`]
      : []),
    ""
  ];
  context.stdout(lines.join("\n"));
}

function errorPayload(error: unknown): {
  code: string;
  message: string;
  receipt?: IntegrationTransactionReceipt;
} {
  const { code, message, receipt } = serializePublicIntegrationError(error);
  return { code, message, ...(receipt ? { receipt } : {}) };
}

function writeError(error: unknown, json: boolean, context: CliContext): void {
  const payload = errorPayload(error);
  if (json) {
    context.stderr(`${JSON.stringify({ error: payload }, null, 2)}\n`);
    return;
  }
  const retry = reviewedPlanRetryHint(payload.code);
  context.stderr(`${terminalSafeText(`${payload.code}: ${payload.message}${retry}`)}\n`);
}

function printRecoveryStatus(
  status: IntegrationRecoveryStatus,
  json: boolean,
  context: CliContext
): void {
  if (json) {
    context.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (status.state === "clear") {
    context.stdout("Integration recovery: clear.\n");
    return;
  }
  const summary = status.transaction
    ? ` (${status.transaction.harness} ${status.transaction.action}; ${status.transaction.transactionId})`
    : "";
  context.stdout(`Integration recovery: ${terminalSafeText(status.state)}${terminalSafeText(summary)}.\n`);
  context.stdout(status.recoverable
    ? "Review the exact recovery action with: skill-steward integrate recovery plan\n"
    : `No recovery action is available: ${terminalSafeText(status.reasonCode)}\n`);
}

function printRecoveryPlan(
  plan: IntegrationRecoveryPlan,
  json: boolean,
  context: CliContext
): void {
  const applyCommand = plan.availability.available
    ? `skill-steward integrate recovery apply --plan ${plan.planId} --confirm`
    : null;
  if (json) {
    context.stdout(`${JSON.stringify({ ...plan, applyCommand }, null, 2)}\n`);
    return;
  }
  context.stdout([
    `Recovery action: ${plan.action}`,
    `Transaction: ${terminalSafeText(plan.transaction.transactionId)}`,
    `Harness: ${plan.transaction.harness}`,
    `Interrupted phase: ${plan.transaction.phase}`,
    `Plan ID: ${terminalSafeText(plan.planId)}`,
    `Expires: ${plan.expiresAt}`,
    ...(applyCommand
      ? [`Confirm: ${applyCommand}`]
      : [`Mutation unavailable: ${plan.availability.reason}`]),
    ""
  ].join("\n"));
}

export async function integrateRecoveryStatusCommand(
  json: boolean,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateRecoveryDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateRecoveryDefaults, ...dependencyOverrides };
  try {
    printRecoveryStatus(await dependencies.status({
      stateDirectory: context.stateDir
    }), json, context);
    return 0;
  } catch (error) {
    writeError(error, json, context);
    return 1;
  }
}

export async function integrateRecoveryPlanCommand(
  json: boolean,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateRecoveryDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateRecoveryDefaults, ...dependencyOverrides };
  try {
    printRecoveryPlan(await dependencies.plan({
      stateDirectory: context.stateDir,
      ...(context.now ? { now: context.now } : {})
    }), json, context);
    return 0;
  } catch (error) {
    writeError(error, json, context);
    return 1;
  }
}

export async function integrateRecoveryApplyCommand(
  options: IntegrateRecoveryApplyOptions,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateRecoveryDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateRecoveryDefaults, ...dependencyOverrides };
  try {
    if (options.plan === undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_REQUIRED",
        "Recovery apply requires --plan <id> --confirm; run integrate recovery plan first"
      );
    }
    if (!options.confirm) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
        "Use --confirm with the reviewed recovery plan ID"
      );
    }
    const receipt: IntegrationRecoveryReceipt = await dependencies.apply(options.plan, {
      home: context.home,
      stateDirectory: context.stateDir,
      ...(context.now ? { now: context.now } : {})
    });
    if (options.json) {
      context.stdout(`${JSON.stringify({ planId: options.plan, receipt }, null, 2)}\n`);
    } else {
      context.stdout([
        `Integration recovery ${receipt.action} completed.`,
        `Transaction: ${terminalSafeText(receipt.transactionId)}`,
        `Result: ${receipt.finalState}`,
        ""
      ].join("\n"));
    }
    return 0;
  } catch (error) {
    writeError(error, options.json, context);
    return 1;
  }
}

export async function integratePlanCommand(
  inputHarness: string,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const harness = parseHarness(inputHarness);
    const plan = await planIntegration(harness, configOptions(context));
    printPlan(plan, context, json, "apply");
    return 0;
  } catch (error) {
    writeError(error, json, context);
    return 1;
  }
}

export async function integrateApplyCommand(
  options: IntegrateApplyOptions,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateApplyDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateApplyDefaults, ...dependencyOverrides };
  try {
    if (options.harness !== undefined) parseHarness(options.harness);
    if (options.plan === undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_REQUIRED",
        "Integration apply requires --plan <id> --confirm; run integrate plan first"
      );
    }
    if (!options.confirm) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
        "Use --confirm with the reviewed integration plan ID"
      );
    }
    if (options.harness !== undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_AMBIGUOUS",
        "Apply accepts only --plan <id> --confirm; --harness is ambiguous"
      );
    }
    const receipt = await dependencies.applyPlan(options.plan, transactionOptions(context));
    const action = receipt.companion === "created"
      ? "create"
      : receipt.companion === "upgraded"
        ? "upgrade"
        : "connect";
    context.stdout(options.json
      ? `${JSON.stringify({ planId: options.plan, action, receipt }, null, 2)}\n`
      : [
          `${actionLabel(action)} completed (${terminalSafeText(receipt.recordId)}).`,
          `Plan ID: ${terminalSafeText(options.plan)}`,
          `Result: ${receipt.outcome}`,
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    writeError(error, options.json, context);
    return 1;
  }
}

export async function integrateStatusCommand(
  inputHarness: string | undefined,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const harnesses: IntegrationHarness[] = inputHarness
      ? [parseHarness(inputHarness)]
      : [...allHarnesses];
    const statuses = await Promise.all(
      harnesses.map((harness) => integrationStatus(harness, configOptions(context)))
    );
    const output = inputHarness ? statuses[0] : statuses;
    if (json) context.stdout(`${JSON.stringify(output, null, 2)}\n`);
    else context.stdout(`${statuses.map(({ harness, hook, companion, availability }) => [
      `${harness}: Hook ${hook.status}; companion ${companion.status} (${companion.reason})`,
      `  Hook target: ${terminalSafeText(hook.target)}`,
      `  Companion target: ${terminalSafeText(companion.target)}`,
      `  Companion proof: ${companion.proofCategory}`,
      ...(availability.available
        ? []
        : [
            `  Change unavailable: ${terminalSafeText(availability.reason ?? "INTEGRATION_STATUS_UNAVAILABLE")}`,
            "  Next: resolve the reported state, then create and review a fresh plan."
          ])
    ].join("\n")).join("\n")}\n`);
    return 0;
  } catch (error) {
    writeError(error, json, context);
    return 1;
  }
}

export async function integrateRemoveCommand(
  options: IntegrateRemoveOptions,
  context: CliContext,
  dependencyOverrides: Partial<IntegrateRemoveDependencies> = {}
): Promise<number> {
  const dependencies = { ...integrateRemoveDefaults, ...dependencyOverrides };
  try {
    const inputHarness = options.harness === undefined
      ? undefined
      : parseHarness(options.harness);
    if (options.plan === undefined) {
      if (options.confirm) {
        if (inputHarness === undefined) {
          throw new IntegrateCommandError(
            "INVALID_INTEGRATION_HARNESS",
            "Legacy disconnect requires --harness <id>"
          );
        }
        const harness = inputHarness;
        const receipt = await dependencies.removeLegacy(harness, transactionOptions(context));
        context.stdout(options.json
          ? `${JSON.stringify({ action: "legacy-disconnect", receipt }, null, 2)}\n`
          : [
              `Removed legacy v1 ${terminalSafeText(harness)} integration (${terminalSafeText(receipt.recordId)}).`,
              "The companion Skill was retained.",
              ""
            ].join("\n")
        );
        return 0;
      }
      if (inputHarness === undefined) {
        throw new IntegrateCommandError(
          "INVALID_INTEGRATION_HARNESS",
          "Disconnect review requires --harness <id>"
        );
      }
      const harness = inputHarness;
      const plan = await dependencies.planDisconnect(harness, configOptions(context));
      printPlan(plan, context, options.json, "remove");
      return 0;
    }
    if (!options.confirm) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
        "Use --confirm with the reviewed disconnect plan ID"
      );
    }
    if (options.harness !== undefined) {
      throw new IntegrateCommandError(
        "REVIEWED_PLAN_AMBIGUOUS",
        "Disconnect apply accepts only --plan <id> --confirm"
      );
    }
    const receipt = await dependencies.applyDisconnect(
      options.plan,
      transactionOptions(context)
    );
    context.stdout(options.json
      ? `${JSON.stringify({ planId: options.plan, action: "disconnect", receipt }, null, 2)}\n`
      : [
          `Disconnect Harness completed (${terminalSafeText(receipt.recordId)}).`,
          `Plan ID: ${terminalSafeText(options.plan)}`,
          ...(receipt.companion === "removed"
            ? ["The last unchanged managed companion Skill was removed."]
            : receipt.companion === "retained"
              ? ["The companion Skill was retained for other active Harnesses."]
              : []),
          ""
        ].join("\n")
    );
    return 0;
  } catch (error) {
    writeError(error, options.json, context);
    return 1;
  }
}
