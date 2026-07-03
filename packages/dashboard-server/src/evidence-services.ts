import {
  aggregateEvidence,
  evidenceDatasetSchema,
  type EvidenceDataset,
  type EvidencePolicy,
  type EvidenceSummary
} from "@skill-steward/evidence";
import { readInstallationHistory } from "@skill-steward/installer";
import {
  applyEvidenceErasePlan,
  applyEvidencePolicyPlan,
  compactEvidenceEvents,
  planEvidenceErase,
  planEvidencePolicyChange,
  readEvidenceEvents,
  readEvidencePolicy,
  readNormalizedPreflightEvidence,
  type EvidenceErasePlan,
  type EvidencePolicyPlan
} from "@skill-steward/store";

export class EvidenceServiceError extends Error {
  constructor(
    public readonly code: "EVIDENCE_POLICY_PLAN_NOT_FOUND" | "EVIDENCE_ERASE_PLAN_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "EvidenceServiceError";
  }
}

export interface EvidenceServices {
  policy(): Promise<EvidencePolicy>;
  planPolicy(change: Omit<EvidencePolicy, "schemaVersion">): Promise<EvidencePolicyPlan>;
  applyPolicy(planId: string): Promise<EvidencePolicy>;
  summary(): Promise<EvidenceSummary>;
  compact(): Promise<{ before: number; kept: number; removed: number }>;
  planErase(): Promise<EvidenceErasePlan>;
  applyErase(planId: string): Promise<{ erased: true }>;
}

export interface EvidenceServiceOptions {
  stateDirectory: string;
  now?: () => Date;
}

async function localDataset(stateDirectory: string): Promise<EvidenceDataset> {
  const [preflights, events, installations] = await Promise.all([
    readNormalizedPreflightEvidence(stateDirectory),
    readEvidenceEvents(stateDirectory),
    readInstallationHistory(stateDirectory)
  ]);
  return evidenceDatasetSchema.parse({
    schemaVersion: 1,
    preflights,
    events,
    installations: installations
      .filter((record) => record.status === "installed" && record.provenance)
      .map((record) => ({
        schemaVersion: 1,
        id: record.id,
        createdAt: record.createdAt,
        preflightId: record.provenance!.preflightId,
        candidateId: record.provenance!.candidateId
      }))
  });
}

export function createEvidenceServices(options: EvidenceServiceOptions): EvidenceServices {
  const now = options.now ?? (() => new Date());
  const policyPlans = new Map<string, EvidencePolicyPlan>();
  const erasePlans = new Map<string, EvidenceErasePlan>();
  return {
    policy: () => readEvidencePolicy(options.stateDirectory),
    async planPolicy(change) {
      const plan = await planEvidencePolicyChange(options.stateDirectory, change, { now: now() });
      policyPlans.set(plan.id, plan);
      return plan;
    },
    async applyPolicy(planId) {
      const plan = policyPlans.get(planId);
      if (!plan) {
        throw new EvidenceServiceError(
          "EVIDENCE_POLICY_PLAN_NOT_FOUND",
          "Review a current evidence policy plan before applying it"
        );
      }
      policyPlans.delete(planId);
      return applyEvidencePolicyPlan(options.stateDirectory, plan, { now: now() });
    },
    async summary() {
      return aggregateEvidence(await localDataset(options.stateDirectory), now());
    },
    async compact() {
      return compactEvidenceEvents(
        options.stateDirectory,
        await readEvidencePolicy(options.stateDirectory),
        now()
      );
    },
    async planErase() {
      const plan = await planEvidenceErase(options.stateDirectory, { now: now() });
      erasePlans.set(plan.id, plan);
      return plan;
    },
    async applyErase(planId) {
      const plan = erasePlans.get(planId);
      if (!plan) {
        throw new EvidenceServiceError(
          "EVIDENCE_ERASE_PLAN_NOT_FOUND",
          "Review a current evidence erase plan before applying it"
        );
      }
      erasePlans.delete(planId);
      await applyEvidenceErasePlan(options.stateDirectory, plan, { now: now() });
      return { erased: true };
    }
  };
}
