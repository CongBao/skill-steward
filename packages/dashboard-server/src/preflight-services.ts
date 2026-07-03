import { randomUUID } from "node:crypto";
import type { CatalogSnapshot, CatalogSource } from "@skill-steward/catalog";
import type { PortfolioReport } from "@skill-steward/engine";
import {
  analyzePreflight,
  preflightFeedbackSchema,
  preflightRequestSchema,
  type PreflightFeedback,
  type PreflightRequest,
  type PreflightResult
} from "@skill-steward/preflight";
import {
  appendPreflightEvidence,
  PreflightEvidenceError,
  recordPreflightFeedback
} from "@skill-steward/store";

export class PreflightServiceError extends Error {
  constructor(
    public readonly code:
      | "PREFLIGHT_NOT_FOUND"
      | "INVALID_FEEDBACK_CANDIDATE",
    message: string
  ) {
    super(message);
    this.name = "PreflightServiceError";
  }
}

export interface PreflightServices {
  run(input: PreflightRequest): Promise<PreflightResult>;
  feedback(id: string, input: PreflightFeedback): Promise<void>;
}

export interface PreflightServiceOptions {
  stateDirectory: string;
  currentPortfolio: () => Promise<PortfolioReport>;
  catalogState?: () => Promise<{
    sources: CatalogSource[];
    snapshot: CatalogSnapshot | null;
  }>;
  now?: () => Date;
  id?: () => string;
}

export function createPreflightServices(
  options: PreflightServiceOptions
): PreflightServices {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;

  return {
    async run(input) {
      const request = preflightRequestSchema.parse(input);
      const [report, catalog] = await Promise.all([
        options.currentPortfolio(),
        options.catalogState?.() ?? Promise.resolve({ sources: [], snapshot: null })
      ]);
      const result = analyzePreflight({
        task: request.task,
        maxSkills: request.maxSkills,
        includeAvailable: request.includeAvailable,
        ...(request.harness ? { harness: request.harness } : {}),
        report,
        catalogSkills: catalog.snapshot?.skills ?? [],
        catalogSources: catalog.sources,
        id: id(),
        now: now()
      });
      await appendPreflightEvidence(options.stateDirectory, result);
      return result;
    },
    async feedback(preflightId, input) {
      const feedback = preflightFeedbackSchema.parse(input);
      try {
        await recordPreflightFeedback(
          options.stateDirectory,
          preflightId,
          feedback,
          now()
        );
      } catch (error) {
        if (error instanceof PreflightEvidenceError) {
          throw new PreflightServiceError(error.code, error.message);
        }
        throw error;
      }
    }
  };
}
