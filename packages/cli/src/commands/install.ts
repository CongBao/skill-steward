import type {
  InstallableHarnessId,
  InstallScope
} from "@skill-steward/engine";
import {
  catalogCandidateSource,
  verifyCatalogCandidateInspection
} from "@skill-steward/catalog";
import {
  applyInstallationPlan,
  inspectStagedSkills,
  InstallerError,
  planInstallation,
  resolveInstallDestination,
  stagePublicGit,
  StagingRegistry
} from "@skill-steward/installer";
import {
  readCatalogSnapshot,
  readCatalogSources,
  writeLatestReport
} from "@skill-steward/store";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import type { CliContext } from "../context.js";

export interface CatalogInstallOptions {
  catalogCandidate: string;
  harness: string;
  scope: string;
  workspace?: string;
  targetName?: string;
  replace: boolean;
  confirm: boolean;
  json: boolean;
}

function installScope(value: string): InstallScope {
  if (value === "global" || value === "project") return value;
  throw new InstallerError("INVALID_INSTALL_SCOPE", "Scope must be global or project");
}

function installHarness(value: string): InstallableHarnessId {
  if (!/^[a-z0-9-]+$/.test(value) || value === "unknown") {
    throw new InstallerError("INVALID_HARNESS", `Unsupported Harness '${value}'`);
  }
  return value as InstallableHarnessId;
}

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function catalogInstallCommand(
  options: CatalogInstallOptions,
  context: CliContext
): Promise<number> {
  const staging = new StagingRegistry({ stateDirectory: context.stateDir });
  let previewId: string | undefined;
  try {
    const [sources, snapshot] = await Promise.all([
      readCatalogSources(context.stateDir),
      readCatalogSnapshot(context.stateDir)
    ]);
    const candidate = snapshot?.skills.find(({ id }) => id === options.catalogCandidate);
    if (!candidate) {
      throw new InstallerError(
        "CATALOG_CANDIDATE_NOT_FOUND",
        `Catalog candidate '${options.catalogCandidate}' was not found`
      );
    }
    const source = sources.find(({ id }) => id === candidate.sourceId);
    if (!source?.enabled) {
      throw new InstallerError(
        "CATALOG_SOURCE_NOT_FOUND",
        `Enabled catalog source '${candidate.sourceId}' was not found`
      );
    }
    const gitSource = catalogCandidateSource(candidate, source);
    const preview = await staging.create({ ttlMs: 15 * 60_000 });
    previewId = preview.id;
    const staged = await (context.catalogStage ?? stagePublicGit)(preview.directory, gitSource);
    const inspected = await inspectStagedSkills(staged.sourceDirectory);
    verifyCatalogCandidateInspection(candidate, {
      commitSha: staged.commitSha,
      candidates: inspected
    });
    const scope = installScope(options.scope);
    const harness = installHarness(options.harness);
    const workspace = options.workspace ?? context.cwd;
    const { target } = resolveInstallDestination({
      harness,
      scope,
      home: context.home,
      ...(scope === "project" ? { workspace } : {}),
      name: options.targetName ?? candidate.name
    });
    const plan = await planInstallation({
      source: staged.sourceDirectory,
      sourceFingerprint: candidate.fingerprint,
      destination: target,
      ...(options.replace ? { conflictAction: "replace" as const } : {})
    });

    if (!options.confirm || plan.status === "noop") {
      context.stdout(options.json
        ? `${JSON.stringify(plan, null, 2)}\n`
        : [
            `Catalog installation plan: ${candidate.name}`,
            `Source: ${source.id}@${candidate.sourceRevision.slice(0, 12)}`,
            `Destination: ${target}`,
            `Status: ${plan.status}`,
            ...plan.changes.map(({ operation, path }) => `- ${operation} ${path}`),
            options.confirm ? "No changes were required." : "Rerun with --confirm to apply this exact request.",
            ""
          ].join("\n")
      );
      return 0;
    }

    const record = await applyInstallationPlan(plan, {
      stateDirectory: context.stateDir,
      ...(context.now ? { now: () => context.now!().getTime() } : {})
    });
    const report = await scanPortfolio(
      standardRoots({ home: context.home, cwd: workspace }),
      context.now?.() ?? new Date()
    );
    await writeLatestReport(context.stateDir, report);
    context.stdout(options.json
      ? `${JSON.stringify(record, null, 2)}\n`
      : `Installed '${candidate.name}' (${record.id}).\n`
    );
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  } finally {
    if (previewId) await staging.expire(previewId);
  }
}
