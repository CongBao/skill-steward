import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative } from "node:path";
import { scanPortfolio, standardRoots } from "@skill-steward/engine";
import {
  catalogCandidateSource,
  verifyCatalogCandidateInspection
} from "@skill-steward/catalog";
import {
  applyInstallationPlan,
  inspectStagedSkills,
  installationPlanSchema,
  installationRouteSchema,
  InstallerError,
  planInstallation,
  resolveVerifiedInstallDestination,
  stagePublicGit,
  StagingRegistry,
  type InstallationPlan,
  type InstallationRoute,
  type InstallationRecord
} from "@skill-steward/installer";
import {
  assertPreflightInstallationRecommendation,
  claimReviewedPlan,
  cleanupExpiredReviewedPlans,
  discardReviewedPlan,
  readCatalogSnapshot,
  readCatalogSources,
  ReviewedPlanStoreError,
  withInstallationMutationLease,
  writeLatestReport,
  writeReviewedPlan,
  type ReviewedPlanEnvelope
} from "@skill-steward/store";
import type { CliContext } from "../context.js";
import {
  applyClaimedReviewedPlan,
  consumedReviewedPlanError,
  reviewedPlanRetryHint
} from "../reviewed-plan.js";
import { terminalSafeText } from "../terminal.js";

const INSTALLATION_PLAN_TTL_MS = 5 * 60_000;
const previewIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CatalogInstallOptions {
  catalogCandidate?: string;
  harness?: string;
  scope?: string;
  workspace?: string;
  preflight?: string;
  targetName?: string;
  replace: boolean;
  plan?: string;
  confirm: boolean;
  json: boolean;
}

interface InstallationReviewedPayload {
  plan: InstallationPlan;
  previewId: string;
  candidateName: string;
  route: InstallationRoute;
}

class InstallCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "InstallCommandError";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return terminalSafeText(
      `${error.code}: ${error.message}${reviewedPlanRetryHint(error.code)}`
    );
  }
  return terminalSafeText(error instanceof Error ? error.message : String(error));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parseInstallationPlan(input: unknown): InstallationPlan {
  const parsed = installationPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Installation plan failed domain validation"
    );
  }
  const { provenance, ...plan } = parsed.data;
  return {
    ...plan,
    ...(provenance === undefined ? {} : { provenance })
  };
}

function parseReviewedPayload(input: unknown): InstallationReviewedPayload {
  if (!isPlainRecord(input)) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Stored installation payload is not a valid object"
    );
  }
  const expectedKeys = ["candidateName", "plan", "previewId", "route"];
  if (
    Object.keys(input).sort().join("\0") !== expectedKeys.join("\0")
    || typeof input.previewId !== "string"
    || !previewIdPattern.test(input.previewId)
    || typeof input.candidateName !== "string"
    || input.candidateName.length < 1
    || input.candidateName.length > 256
  ) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Stored installation payload is invalid"
    );
  }
  const plan = parseInstallationPlan(input.plan);
  const route = installationRouteSchema.safeParse(input.route);
  if (!route.success) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Stored installation route is invalid"
    );
  }
  if (input.previewId !== plan.id) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Stored installation preview does not belong to its plan"
    );
  }
  return {
    plan,
    previewId: input.previewId,
    candidateName: input.candidateName,
    route: route.data
  };
}

function matchesEnvelopeIdentity(
  envelope: ReviewedPlanEnvelope<unknown>,
  plan: InstallationPlan
): boolean {
  return plan.id === envelope.id
    && new Date(plan.createdAt).toISOString() === envelope.createdAt
    && new Date(plan.expiresAt).toISOString() === envelope.expiresAt;
}

async function assertContainedSource(previewDirectory: string, source: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Reviewed installation source must be a physical directory"
    );
  }
  const [physicalPreview, physicalSource] = await Promise.all([
    realpath(previewDirectory),
    realpath(source)
  ]);
  const containedPath = relative(physicalPreview, physicalSource);
  if (
    containedPath.length === 0
    || containedPath === ".."
    || containedPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(containedPath)
  ) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Reviewed installation source escapes its staged preview"
    );
  }
}

async function cleanupReviewedPlans(context: CliContext, now: Date): Promise<void> {
  try {
    await cleanupExpiredReviewedPlans(context.stateDir, now);
  } catch (error) {
    if (
      !(error instanceof ReviewedPlanStoreError)
      || error.code === "REVIEWED_PLAN_UNSAFE_STATE"
    ) {
      throw error;
    }
  }
}

async function cleanupInstallState(
  staging: StagingRegistry,
  context: CliContext,
  now: Date
): Promise<void> {
  await staging.cleanupExpired();
  await cleanupReviewedPlans(context, now);
}

interface PortfolioRefreshWarning {
  code: "PORTFOLIO_REFRESH_FAILED";
  message: string;
  recoveryCommand: "skill-steward scan";
}

type PortfolioRefreshResult = {
  refresh:
    | { status: "completed" }
    | { status: "failed"; recoveryCommand: "skill-steward scan" };
  warnings: PortfolioRefreshWarning[];
};

async function refreshAfterCommit(
  workspace: string,
  context: CliContext
): Promise<PortfolioRefreshResult> {
  try {
    const report = await scanPortfolio(
      standardRoots({ home: context.home, cwd: workspace }),
      context.now?.() ?? new Date()
    );
    await writeLatestReport(context.stateDir, report);
    return { refresh: { status: "completed" }, warnings: [] };
  } catch {
    const warning: PortfolioRefreshWarning = {
      code: "PORTFOLIO_REFRESH_FAILED",
      message: "The installation committed, but the portfolio report was not refreshed.",
      recoveryCommand: "skill-steward scan"
    };
    context.stderr(
      `${warning.code}: ${warning.message} Run: ${warning.recoveryCommand}\n`
    );
    return {
      refresh: { status: "failed", recoveryCommand: warning.recoveryCommand },
      warnings: [warning]
    };
  }
}

function hasRawRequest(options: CatalogInstallOptions): boolean {
  return options.catalogCandidate !== undefined
    || options.harness !== undefined
    || options.scope !== undefined
    || options.workspace !== undefined
    || options.preflight !== undefined
    || options.targetName !== undefined
    || options.replace;
}

function requirePreviewRequest(options: CatalogInstallOptions): {
  catalogCandidate: string;
  harness: string;
  scope: string;
} {
  if (
    options.catalogCandidate === undefined
    || options.harness === undefined
    || options.scope === undefined
  ) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_PREVIEW_REQUIRED",
      "Preview requires --catalog-candidate <id>, --harness <id>, and --scope <scope>"
    );
  }
  return {
    catalogCandidate: options.catalogCandidate,
    harness: options.harness,
    scope: options.scope
  };
}

function printPlan(
  plan: InstallationPlan,
  candidateName: string,
  sourceId: string,
  sourceRevision: string,
  json: boolean,
  context: CliContext
): void {
  const ready = plan.status === "ready";
  const applyCommand = `skill-steward install --plan ${plan.id} --confirm`;
  context.stdout(json
    ? `${JSON.stringify({
        ...plan,
        ...(ready ? { planId: plan.id, applyCommand } : {})
      }, null, 2)}\n`
    : [
        `Catalog installation plan: ${terminalSafeText(candidateName)}`,
        `Source: ${terminalSafeText(sourceId)}@${terminalSafeText(sourceRevision.slice(0, 12))}`,
        `Destination: ${terminalSafeText(plan.destination)}`,
        `Status: ${plan.status}`,
        ...plan.changes.map(({ operation, path }) =>
          `- ${terminalSafeText(operation)} ${terminalSafeText(path)}`
        ),
        ...(ready
          ? [
              `Plan ID: ${terminalSafeText(plan.id)}`,
              `Expires: ${new Date(plan.expiresAt).toISOString()}`,
              `Apply: ${applyCommand}`
            ]
          : [plan.status === "noop"
              ? "No changes are required."
              : "Resolve the destination conflict and create a new preview."]),
        ""
      ].join("\n")
  );
}

async function previewInstallation(
  options: CatalogInstallOptions,
  context: CliContext,
  staging: StagingRegistry
): Promise<void> {
  if (options.confirm) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_REQUIRED",
      "--confirm requires --plan <id>; run the install request first to preview it"
    );
  }
  const request = requirePreviewRequest(options);
  const now = context.now?.() ?? new Date();
  await cleanupInstallState(staging, context, now);
  let previewId: string | undefined;
  let reviewedPlanId: string | undefined;
  let retainPreview = false;
  let operationError: unknown;
  try {
    const [sources, snapshot] = await Promise.all([
      readCatalogSources(context.stateDir),
      readCatalogSnapshot(context.stateDir)
    ]);
    const candidate = snapshot?.skills.find(({ id }) => id === request.catalogCandidate);
    if (!candidate) {
      throw new InstallerError(
        "CATALOG_CANDIDATE_NOT_FOUND",
        `Catalog candidate '${request.catalogCandidate}' was not found`
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
    const provenance = options.preflight
      ? {
          preflightId: options.preflight,
          candidateId: candidate.id,
          sourceId: candidate.sourceId,
          sourceRevision: candidate.sourceRevision
        }
      : undefined;
    if (provenance) {
      await assertPreflightInstallationRecommendation(
        context.stateDir,
        provenance.preflightId,
        provenance.candidateId
      );
    }

    const preview = await staging.create({ ttlMs: INSTALLATION_PLAN_TTL_MS });
    previewId = preview.id;
    const staged = await (context.catalogStage ?? stagePublicGit)(preview.directory, gitSource);
    const inspected = await inspectStagedSkills(staged.sourceDirectory);
    verifyCatalogCandidateInspection(candidate, {
      commitSha: staged.commitSha,
      candidates: inspected
    });
    const workspace = normalize(options.workspace ?? context.cwd);
    if (!isAbsolute(workspace)) {
      throw new InstallerError("INVALID_WORKSPACE", "Workspace must be an absolute path");
    }
    const parsedRoute = installationRouteSchema.safeParse({
      harness: request.harness,
      scope: request.scope,
      targetName: options.targetName ?? candidate.name,
      workspace
    });
    if (!parsedRoute.success) {
      throw new InstallerError("INVALID_INSTALL_ROUTE", "Installation route is invalid");
    }
    const route = parsedRoute.data;
    const { target } = await resolveVerifiedInstallDestination({
      route,
      home: context.home
    });
    const planned = await planInstallation({
      source: staged.sourceDirectory,
      sourceFingerprint: candidate.fingerprint,
      destination: target,
      ...(provenance ? { provenance } : {}),
      ...(options.replace ? { conflictAction: "replace" as const } : {}),
      now: now.getTime(),
      ttlMs: INSTALLATION_PLAN_TTL_MS
    });
    const plan = parseInstallationPlan({ ...planned, id: preview.id });

    if (plan.status === "ready") {
      const payload: InstallationReviewedPayload = {
        plan,
        previewId: preview.id,
        candidateName: candidate.name,
        route
      };
      await writeReviewedPlan(context.stateDir, {
        schemaVersion: 1,
        id: plan.id,
        kind: "installation",
        createdAt: new Date(plan.createdAt).toISOString(),
        expiresAt: new Date(plan.expiresAt).toISOString(),
        payload
      });
      reviewedPlanId = plan.id;
      printPlan(
        plan,
        candidate.name,
        source.id,
        candidate.sourceRevision,
        options.json,
        context
      );
      retainPreview = true;
      return;
    }

    printPlan(
      plan,
      candidate.name,
      source.id,
      candidate.sourceRevision,
      options.json,
      context
    );
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (previewId !== undefined && !retainPreview) {
      try {
        if (reviewedPlanId !== undefined) {
          await discardReviewedPlan(context.stateDir, reviewedPlanId);
        }
        await staging.expire(previewId);
      } catch (cleanupError) {
        if (operationError === undefined) throw cleanupError;
      }
    }
  }
}

async function expireAfterClaim(
  staging: StagingRegistry,
  previewId: string | undefined,
  context: CliContext
): Promise<void> {
  if (previewId === undefined) return;
  try {
    await staging.expire(previewId);
  } catch (error) {
    context.stderr(
      `STAGING_CLEANUP_FAILED: ${terminalSafeText(error instanceof Error ? error.message : String(error))}\n`
    );
  }
}

async function applyInstallation(
  planId: string,
  options: CatalogInstallOptions,
  context: CliContext,
  staging: StagingRegistry
): Promise<void> {
  if (!options.confirm) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_CONFIRMATION_REQUIRED",
      "Use --confirm with the reviewed plan ID"
    );
  }
  if (hasRawRequest(options)) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_AMBIGUOUS",
      "Apply accepts only --plan <id> --confirm; request options are ambiguous"
    );
  }
  if (!previewIdPattern.test(planId)) {
    throw new InstallCommandError(
      "REVIEWED_PLAN_INVALID",
      "Reviewed installation plan ID is unsafe"
    );
  }
  const contextNow = context.now;
  const transaction = await withInstallationMutationLease(context.stateDir, async () => {
    const now = context.now?.() ?? new Date();
    await staging.cleanupExpired();
    let envelope: ReviewedPlanEnvelope<unknown>;
    try {
      envelope = await claimReviewedPlan(
        context.stateDir,
        { id: planId, kind: "installation", now }
      );
    } catch (error) {
      if (
        error instanceof ReviewedPlanStoreError
        && (
          error.code === "REVIEWED_PLAN_INVALID"
          || error.code === "REVIEWED_PLAN_EXPIRED"
        )
      ) {
        await expireAfterClaim(staging, planId, context);
      }
      if (
        error instanceof ReviewedPlanStoreError
        && (
          error.code === "REVIEWED_PLAN_INVALID"
          || error.code === "REVIEWED_PLAN_EXPIRED"
          || error.code === "REVIEWED_PLAN_KIND_MISMATCH"
        )
      ) {
        throw consumedReviewedPlanError(error);
      }
      throw error;
    }
    let payload: InstallationReviewedPayload;
    let record: InstallationRecord;
    try {
      ({ payload, record } = await applyClaimedReviewedPlan(async () => {
        const parsed = parseReviewedPayload(envelope.payload);
        if (!matchesEnvelopeIdentity(envelope, parsed.plan)) {
          throw new InstallCommandError(
            "REVIEWED_PLAN_INVALID",
            "Stored installation plan identity does not match its envelope"
          );
        }
        const reviewedDestination = await resolveVerifiedInstallDestination({
          route: parsed.route,
          home: context.home
        });
        if (reviewedDestination.target !== parsed.plan.destination) {
          throw new InstallCommandError(
            "REVIEWED_PLAN_INVALID",
            "Stored installation destination does not match its reviewed route"
          );
        }
        const preview = await staging.resolve(envelope.id);
        await assertContainedSource(preview.directory, parsed.plan.source);
        const currentDestination = await resolveVerifiedInstallDestination({
          route: parsed.route,
          home: context.home
        });
        if (currentDestination.target !== parsed.plan.destination) {
          throw new InstallCommandError(
            "REVIEWED_PLAN_INVALID",
            "Installation destination changed from its reviewed route"
          );
        }
        return {
          payload: parsed,
          record: await applyInstallationPlan(parsed.plan, {
            stateDirectory: context.stateDir,
            ...(contextNow ? { now: () => contextNow().getTime() } : {})
          })
        };
      }));
    } catch (error) {
      await expireAfterClaim(staging, envelope.id, context);
      throw error;
    }
    await expireAfterClaim(staging, envelope.id, context);
    return {
      envelope,
      payload,
      record,
      refreshResult: await refreshAfterCommit(payload.route.workspace, context)
    };
  });
  context.stdout(options.json
    ? `${JSON.stringify({
        record: transaction.record,
        planId: transaction.envelope.id,
        ...transaction.refreshResult
      }, null, 2)}\n`
    : [
        `Installed '${terminalSafeText(transaction.payload.candidateName)}' (${terminalSafeText(transaction.record.id)}).`,
        `Plan ID: ${terminalSafeText(transaction.envelope.id)}`,
        ""
      ].join("\n")
  );
}

export async function catalogInstallCommand(
  options: CatalogInstallOptions,
  context: CliContext
): Promise<number> {
  const contextNow = context.now;
  const staging = new StagingRegistry({
    stateDirectory: context.stateDir,
    ...(contextNow ? { now: () => contextNow().getTime() } : {})
  });
  try {
    if (options.plan !== undefined) {
      await applyInstallation(options.plan, options, context, staging);
    } else {
      await previewInstallation(options, context, staging);
    }
    return 0;
  } catch (error) {
    context.stderr(`${errorText(error)}\n`);
    return 1;
  }
}
