import {
  EvidenceEventStoreError,
  EvidencePolicyStoreError
} from "@skill-steward/store";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  EvidenceServiceError,
  type EvidenceServices
} from "../evidence-services.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (
    error instanceof EvidenceServiceError
    || error instanceof EvidencePolicyStoreError
    || error instanceof EvidenceEventStoreError
  ) {
    return reply.code(409).send(apiFailure(error.code, error.message));
  }
  return reply.code(400).send(apiFailure(
    "INVALID_EVIDENCE_REQUEST",
    error instanceof Error ? error.message : String(error)
  ));
}

export function registerEvidenceRoutes(app: FastifyInstance, services: EvidenceServices): void {
  app.get("/api/v1/evidence/policy", async () => apiSuccess(await services.policy()));
  app.get("/api/v1/evidence/summary", async () => apiSuccess(await services.summary()));

  app.post<{ Body: unknown }>("/api/v1/evidence/policy/plan", async (request, reply) => {
    try {
      const body = object(request.body);
      return apiSuccess(await services.planPolicy({
        mode: body.mode as "minimal" | "learning",
        retentionDays: body.retentionDays as number,
        maxEvents: body.maxEvents as number
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/v1/evidence/policy/apply", async (request, reply) => {
    try {
      const body = object(request.body);
      if (typeof body.planId !== "string") throw new Error("planId must be a string");
      return apiSuccess(await services.applyPolicy(body.planId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/evidence/compact", async (_request, reply) => {
    try {
      return apiSuccess(await services.compact());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/v1/evidence/erase/plan", async (_request, reply) => {
    try {
      return apiSuccess(await services.planErase());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/v1/evidence/erase/apply", async (request, reply) => {
    try {
      const body = object(request.body);
      if (typeof body.planId !== "string") throw new Error("planId must be a string");
      return apiSuccess(await services.applyErase(body.planId));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
