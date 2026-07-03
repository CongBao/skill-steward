import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import {
  createDashboardApp,
  createDashboardServices,
  createCatalogServices,
  createEvidenceServices,
  createGovernanceServices,
  createInstallationServices,
  createIntegrationServices,
  createPreflightServices,
  type DashboardApp,
  startDashboardServer
} from "@skill-steward/dashboard-server";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import { writeLatestReport } from "@skill-steward/store";
import type { CliContext } from "../context.js";

export interface DashboardCommandOptions {
  port: number;
  open: boolean;
}

export interface DashboardLaunchInput {
  port: number;
  context: CliContext;
}

export interface DashboardCommandDependencies {
  launch(input: DashboardLaunchInput): Promise<{ url: string }>;
  open(url: string): Promise<void>;
}

export function dashboardPort(input: string): number {
  const port = Number(input);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Dashboard port must be an integer from 0 through 65535");
  }
  return port;
}

async function launch({ port, context }: DashboardLaunchInput): Promise<{ url: string }> {
  const { app } = createDashboardApplication(
    context,
    fileURLToPath(new URL("./dashboard/", import.meta.url))
  );
  return startDashboardServer({ app, port });
}

function packagedCompanionSkillDirectory(): string {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  return moduleDirectory.endsWith(`${join("src", "commands")}${sep}`)
    ? resolve(moduleDirectory, "../../../integrations/assets/skill-steward-preflight")
    : resolve(moduleDirectory, "integrations/skill-steward-preflight");
}

export function createDashboardApplication(
  context: CliContext,
  assetsDirectory?: string
): DashboardApp {
  const dashboardServices = createDashboardServices({
    stateDirectory: context.stateDir,
    home: context.home,
    cwd: context.cwd
  });
  const installationServices = createInstallationServices({
    stateDirectory: context.stateDir,
    home: context.home,
    workspace: context.cwd,
    afterCommit: async () => {
      await dashboardServices.scan([]);
    }
  });
  const catalogServices = createCatalogServices({
    stateDirectory: context.stateDir,
    inspectInstallation: installationServices.inspectGit,
    ...(context.now ? { now: context.now } : {})
  });
  const preflightServices = createPreflightServices({
    stateDirectory: context.stateDir,
    currentPortfolio: async () => {
      const report = await scanPortfolio(
        standardRoots({ home: context.home, cwd: context.cwd })
      );
      await writeLatestReport(context.stateDir, report);
      return report;
    },
    catalogState: catalogServices.list
  });
  const integrationServices = createIntegrationServices({
    home: context.home,
    stateDirectory: context.stateDir,
    companionSkillDirectory: packagedCompanionSkillDirectory(),
    ...(context.now ? { now: context.now } : {})
  });
  const evidenceServices = createEvidenceServices({
    stateDirectory: context.stateDir,
    ...(context.now ? { now: context.now } : {})
  });
  const governanceServices = createGovernanceServices({
    stateDirectory: context.stateDir,
    activeRoots: () => standardRoots({ home: context.home, cwd: context.cwd }),
    afterCommit: async () => {
      await dashboardServices.scan([]);
    },
    ...(context.now ? { now: context.now } : {})
  });
  return createDashboardApp({
    services: dashboardServices,
    installationServices,
    preflightServices,
    catalogServices,
    integrationServices,
    evidenceServices,
    governanceServices,
    ...(assetsDirectory ? { assetsDirectory } : {})
  });
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

const defaults: DashboardCommandDependencies = {
  launch,
  open: openBrowser
};

export async function dashboardCommand(
  options: DashboardCommandOptions,
  context: CliContext,
  dependencies: DashboardCommandDependencies = defaults
): Promise<number> {
  const { url } = await dependencies.launch({ port: options.port, context });
  context.stdout(`Skill Steward dashboard: ${url}\n`);
  if (options.open) await dependencies.open(url);
  return 0;
}
