import { GovernanceError } from "@skill-steward/governance";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  GovernanceServiceError,
  type GovernancePlanRequest,
  type GovernanceServices
} from "../governance-services.js";

function parsePlanRequest(value: unknown): GovernancePlanRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernanceServiceError("GOVERNANCE_ACTION_INVALID", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (body.action === "quarantine" && typeof body.skillId === "string") {
    return { action: "quarantine", skillId: body.skillId };
  }
  if (body.action === "restore" && typeof body.transactionId === "string") {
    return { action: "restore", transactionId: body.transactionId };
  }
  throw new GovernanceServiceError(
    "GOVERNANCE_ACTION_INVALID",
    "Expected quarantine with skillId or restore with transactionId"
  );
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof GovernanceServiceError || error instanceof GovernanceError) {
    const status = error.code === "GOVERNANCE_SKILL_NOT_FOUND"
      || error.code === "GOVERNANCE_TRANSACTION_NOT_FOUND"
      ? 404
      : 409;
    return reply.code(status).send(apiFailure(
      error.code,
      error.message,
      error instanceof GovernanceError ? error.data : undefined
    ));
  }
  throw error;
}

export function registerGovernanceRoutes(app: FastifyInstance, services: GovernanceServices): void {
  app.get(
    "/api/v1/governance/transactions",
    async () => apiSuccess(await services.transactions())
  );
  app.post<{ Body: unknown }>("/api/v1/governance/plans", async (request, reply) => {
    try {
      return apiSuccess(await services.plan(parsePlanRequest(request.body)));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/governance/plans/:id/apply",
    async (request, reply) => {
      try {
        return apiSuccess(await services.apply(request.params.id));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
}
