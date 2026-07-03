import { join } from "node:path";
import type {
  InstallableHarnessId,
  InstallScope
} from "@skill-steward/engine";
import {
  applyInstallationPlan,
  inspectStagedSkills,
  installationSourceSchema,
  InstallerError,
  planInstallation,
  readInstallationHistory,
  resolveInstallDestination,
  rollbackInstallation,
  stageFolderUpload,
  stagePublicGit,
  stageZipArchive,
  StagingRegistry,
  type ConflictAction,
  type InstallCandidate,
  type InstallationPlan,
  type InstallationProvenance,
  type InstallationRecord,
  type InstallationSource,
  type UploadedFile
} from "@skill-steward/installer";

export interface InspectionResult {
  previewId: string;
  expiresAt: number;
  source: InstallationSource;
  candidates: Array<Partial<InstallCandidate> & Pick<InstallCandidate, "id" | "name" | "fingerprint">>;
  provenance?: InstallationProvenance;
}

export interface InstallationPlanRequest {
  previewId: string;
  candidateId: string;
  harness: InstallableHarnessId;
  scope: InstallScope;
  workspace?: string;
  targetName: string;
  conflictAction?: ConflictAction;
}

export interface InstallationServices {
  inspectFolder(source: { kind: "folder"; label: string }, files: UploadedFile[]): Promise<InspectionResult>;
  inspectZip(source: { kind: "zip"; fileName: string }, archive: Buffer): Promise<InspectionResult>;
  inspectGit(
    source: Extract<InstallationSource, { kind: "git" }>,
    provenance?: InstallationProvenance
  ): Promise<InspectionResult>;
  plan(request: InstallationPlanRequest): Promise<Partial<InstallationPlan> & Pick<InstallationPlan, "id" | "status" | "action" | "changes">>;
  commit(planId: string): Promise<Partial<InstallationRecord> & Pick<InstallationRecord, "id" | "status">>;
  history(): Promise<InstallationRecord[]>;
  rollback(transactionId: string): Promise<Partial<InstallationRecord> & Pick<InstallationRecord, "id" | "status">>;
}

interface StoredPreview {
  source: InstallationSource;
  sourceDirectory: string;
  candidates: InstallCandidate[];
  provenance?: InstallationProvenance;
}

export interface LocalInstallationServiceOptions {
  stateDirectory: string;
  home: string;
  workspace: string;
  previewTtlMs?: number;
  stageGit?: typeof stagePublicGit;
  afterCommit?: () => void | Promise<void>;
}

export function createInstallationServices(
  options: LocalInstallationServiceOptions
): InstallationServices {
  const staging = new StagingRegistry({ stateDirectory: options.stateDirectory });
  const previews = new Map<string, StoredPreview>();
  const plans = new Map<string, InstallationPlan>();
  const previewTtlMs = options.previewTtlMs ?? 15 * 60_000;

  async function recordPreview(
    source: InstallationSource,
    sourceDirectory: string,
    previewId: string,
    expiresAt: number,
    provenance?: InstallationProvenance
  ): Promise<InspectionResult> {
    const candidates = await inspectStagedSkills(sourceDirectory);
    previews.set(previewId, {
      source,
      sourceDirectory,
      candidates,
      ...(provenance ? { provenance } : {})
    });
    return {
      previewId,
      expiresAt,
      source,
      candidates,
      ...(provenance ? { provenance } : {})
    };
  }

  return {
    async inspectFolder(input, files) {
      const source = installationSourceSchema.parse(input);
      if (source.kind !== "folder") throw new InstallerError("INVALID_SOURCE", "Expected folder source");
      const preview = await staging.create({ ttlMs: previewTtlMs });
      const sourceDirectory = join(preview.directory, "source");
      await stageFolderUpload(sourceDirectory, files);
      return recordPreview(source, sourceDirectory, preview.id, preview.expiresAt);
    },
    async inspectZip(input, archive) {
      const source = installationSourceSchema.parse(input);
      if (source.kind !== "zip") throw new InstallerError("INVALID_SOURCE", "Expected ZIP source");
      const preview = await staging.create({ ttlMs: previewTtlMs });
      const sourceDirectory = join(preview.directory, "source");
      await stageZipArchive(sourceDirectory, archive);
      return recordPreview(source, sourceDirectory, preview.id, preview.expiresAt);
    },
    async inspectGit(input, provenance) {
      const source = installationSourceSchema.parse(input);
      if (source.kind !== "git") throw new InstallerError("INVALID_SOURCE", "Expected Git source");
      const preview = await staging.create({ ttlMs: previewTtlMs });
      const staged = await (options.stageGit ?? stagePublicGit)(preview.directory, source);
      const result = await recordPreview(
        source,
        staged.sourceDirectory,
        preview.id,
        preview.expiresAt,
        provenance
      );
      return { ...result, source: { ...source, ref: source.ref ?? staged.commitSha } };
    },
    async plan(request) {
      await staging.resolve(request.previewId);
      const preview = previews.get(request.previewId);
      if (!preview) throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
      const candidate = preview.candidates.find(({ id }) => id === request.candidateId);
      if (!candidate || !candidate.fingerprint) {
        throw new InstallerError("CANDIDATE_NOT_INSTALLABLE", "Candidate is missing or invalid");
      }
      const { target } = resolveInstallDestination({
        harness: request.harness,
        scope: request.scope,
        home: options.home,
        workspace: request.workspace ?? options.workspace,
        name: request.targetName
      });
      const source =
        candidate.relativePath === "."
          ? preview.sourceDirectory
          : join(preview.sourceDirectory, candidate.relativePath);
      const plan = await planInstallation({
        source,
        sourceFingerprint: candidate.fingerprint,
        destination: target,
        ...(preview.provenance ? { provenance: preview.provenance } : {}),
        ...(request.conflictAction ? { conflictAction: request.conflictAction } : {})
      });
      plans.set(plan.id, plan);
      return plan;
    },
    async commit(planId) {
      const plan = plans.get(planId);
      if (!plan) throw new InstallerError("PLAN_NOT_FOUND", "Installation plan was not found or already used");
      const result = await applyInstallationPlan(plan, {
        stateDirectory: options.stateDirectory
      });
      plans.delete(planId);
      await options.afterCommit?.();
      return result;
    },
    history: () => readInstallationHistory(options.stateDirectory),
    rollback: (transactionId) =>
      rollbackInstallation(transactionId, { stateDirectory: options.stateDirectory })
  };
}
