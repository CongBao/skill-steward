import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  applyIntegrationPlan,
  CompanionSkillError,
  companionSkillDirectory,
  installCompanionSkill,
  integrationHarnessSchema,
  integrationStatus,
  planIntegration,
  removeManagedCompanionSkill,
  removeIntegration,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan
} from "@skill-steward/integrations";
import type { CliContext } from "../context.js";

const allHarnesses = ["codex", "claude-code", "github-copilot"] as const;

function packagedSkillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith(join("src", "commands"))
    ? resolve(
        moduleDirectory,
        "../../../integrations/assets/skill-steward-preflight"
      )
    : resolve(moduleDirectory, "integrations/skill-steward-preflight");
}

function configOptions(context: CliContext): IntegrationConfigOptions {
  return {
    home: context.home,
    stateDirectory: context.stateDir,
    ...(context.now ? { now: context.now } : {})
  };
}

async function installSharedSkill(context: CliContext): Promise<{ created: boolean; path: string }> {
  return installCompanionSkill({
    home: context.home,
    sourceDirectory: packagedSkillDirectory()
  });
}

async function removeSharedSkillIfUnused(context: CliContext): Promise<void> {
  const active = await Promise.all(
    allHarnesses.map((harness) => integrationStatus(harness, configOptions(context)))
  );
  if (active.some(({ status }) => status === "installed" || status === "needs-trust")) return;
  await removeManagedCompanionSkill({
    home: context.home,
    sourceDirectory: packagedSkillDirectory()
  });
}

function printPlan(plan: IntegrationPlan, context: CliContext, json: boolean): void {
  if (json) {
    context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const lines = [
    `Harness integration plan: ${plan.harness}`,
    `Target: ${plan.targetPath}`,
    `Companion Skill: ${companionSkillDirectory(context.home)}`,
    ...plan.changes.map(({ operation, path }) => `- ${operation} ${path}`),
    plan.changes.length ? "Run integrate apply with --confirm to apply." : "Already configured.",
    ""
  ];
  context.stdout(lines.join("\n"));
}

function errorText(error: unknown): string {
  if (error instanceof CompanionSkillError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function integratePlanCommand(
  inputHarness: string,
  json: boolean,
  context: CliContext
): Promise<number> {
  try {
    const harness = integrationHarnessSchema.parse(inputHarness);
    const plan = await planIntegration(harness, configOptions(context));
    printPlan(plan, context, json);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function integrateApplyCommand(
  inputHarness: string,
  confirm: boolean,
  context: CliContext
): Promise<number> {
  let installed: { created: boolean; path: string } | undefined;
  try {
    if (!confirm) throw new Error("Integration apply requires --confirm");
    const harness = integrationHarnessSchema.parse(inputHarness);
    const plan = await planIntegration(harness, configOptions(context));
    installed = await installSharedSkill(context);
    const record = await applyIntegrationPlan(plan, configOptions(context));
    context.stdout(`Installed ${harness} integration (${record.id}).\n`);
    return 0;
  } catch (error) {
    if (installed?.created) {
      await removeManagedCompanionSkill({
        home: context.home,
        sourceDirectory: packagedSkillDirectory()
      });
    }
    context.stderr(`${errorText(error)}\n`);
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
      ? [integrationHarnessSchema.parse(inputHarness)]
      : [...allHarnesses];
    const statuses = await Promise.all(
      harnesses.map((harness) => integrationStatus(harness, configOptions(context)))
    );
    const output = inputHarness ? statuses[0] : statuses;
    if (json) context.stdout(`${JSON.stringify(output, null, 2)}\n`);
    else context.stdout(`${statuses.map(({ harness, status, targetPath }) =>
      `${harness}: ${status} (${targetPath})`
    ).join("\n")}\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}

export async function integrateRemoveCommand(
  inputHarness: string,
  confirm: boolean,
  context: CliContext
): Promise<number> {
  try {
    if (!confirm) throw new Error("Integration removal requires --confirm");
    const harness = integrationHarnessSchema.parse(inputHarness);
    const record = await removeIntegration(harness, configOptions(context));
    await removeSharedSkillIfUnused(context);
    context.stdout(`Removed ${harness} integration (${record.id}).\n`);
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
