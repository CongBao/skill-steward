import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  rename,
  rm
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  applyIntegrationPlan,
  integrationHarnessSchema,
  integrationStatus,
  planIntegration,
  removeIntegration,
  type IntegrationConfigOptions,
  type IntegrationHarness,
  type IntegrationPlan
} from "@skill-steward/integrations";
import { fingerprintDirectory } from "@skill-steward/installer";
import type { CliContext } from "../context.js";

const allHarnesses = ["codex", "claude-code"] as const;

class SharedSkillError extends Error {
  readonly code = "SHARED_SKILL_CONFLICT";
}

function packagedSkillDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith(join("src", "commands"))
    ? resolve(
        moduleDirectory,
        "../../../integrations/assets/skill-steward-preflight"
      )
    : resolve(moduleDirectory, "integrations/skill-steward-preflight");
}

function sharedSkillDirectory(home: string): string {
  return join(home, ".agents", "skills", "skill-steward-preflight");
}

function configOptions(context: CliContext): IntegrationConfigOptions {
  return {
    home: context.home,
    stateDirectory: context.stateDir,
    ...(context.now ? { now: context.now } : {})
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function installSharedSkill(context: CliContext): Promise<{ created: boolean; path: string }> {
  const source = packagedSkillDirectory();
  const destination = sharedSkillDirectory(context.home);
  const sourceFingerprint = await fingerprintDirectory(source);
  if (await exists(destination)) {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SharedSkillError("SHARED_SKILL_CONFLICT: destination is not a regular directory");
    }
    if (await fingerprintDirectory(destination) !== sourceFingerprint) {
      throw new SharedSkillError("SHARED_SKILL_CONFLICT: existing companion Skill differs");
    }
    return { created: false, path: destination };
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { created: true, path: destination };
}

async function removeSharedSkillIfUnused(context: CliContext): Promise<void> {
  const active = await Promise.all(
    allHarnesses.map((harness) => integrationStatus(harness, configOptions(context)))
  );
  if (active.some(({ status }) => status === "installed" || status === "needs-trust")) return;
  const source = packagedSkillDirectory();
  const destination = sharedSkillDirectory(context.home);
  if (!await exists(destination)) return;
  const metadata = await lstat(destination);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    await fingerprintDirectory(destination) !== await fingerprintDirectory(source)
  ) {
    return;
  }
  await rm(destination, { recursive: true, force: true });
}

function printPlan(plan: IntegrationPlan, context: CliContext, json: boolean): void {
  if (json) {
    context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const lines = [
    `Harness integration plan: ${plan.harness}`,
    `Target: ${plan.targetPath}`,
    `Companion Skill: ${sharedSkillDirectory(context.home)}`,
    ...plan.changes.map(({ operation, path }) => `- ${operation} ${path}`),
    plan.changes.length ? "Run integrate apply with --confirm to apply." : "Already configured.",
    ""
  ];
  context.stdout(lines.join("\n"));
}

function errorText(error: unknown): string {
  if (error instanceof SharedSkillError) return `${error.code}: ${error.message}`;
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
      await rm(installed.path, { recursive: true, force: true });
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
