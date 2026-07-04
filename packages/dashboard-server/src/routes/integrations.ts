import {
  CompanionSkillError,
  IntegrationError
} from "@skill-steward/integrations";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  IntegrationServiceError,
  type IntegrationServices
} from "../integration-services.js";

function sendIntegrationError(reply: FastifyReply, error: unknown) {
  if (error instanceof IntegrationServiceError) {
    return reply.code(
      error.code === "INVALID_INTEGRATION_HARNESS"
      || error.code === "INVALID_INTEGRATION_PLAN_REQUEST"
        ? 400
        : 409
    )
      .send(apiFailure(error.code, error.message));
  }
  if (error instanceof IntegrationError || error instanceof CompanionSkillError) {
    return reply.code(409).send(apiFailure(error.code, error.message));
  }
  throw error;
}

function applyPlanId(body: unknown): string {
  if (
    typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !("planId" in body)
    || typeof body.planId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.planId)
  ) {
    throw new IntegrationServiceError(
      "INVALID_INTEGRATION_PLAN_REQUEST",
      "Apply requires a strict JSON body containing only { planId }"
    );
  }
  return body.planId;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  services: IntegrationServices
): void {
  app.get("/api/v1/integrations", async () => apiSuccess(await services.list()));
  app.get(
    "/api/v1/integrations/capabilities",
    async () => apiSuccess(services.capabilities())
  );

  app.post<{ Params: { harness: string } }>(
    "/api/v1/integrations/:harness/plan",
    async (request, reply) => {
      try {
        const plan = await services.plan(request.params.harness);
        return apiSuccess({
          ...plan,
          applyAvailable: false as const,
          applyCommand: null,
          applyUnavailableReason: "COMPANION_TRANSACTION_NOT_ENABLED" as const
        });
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.post<{ Params: { harness: string }; Body: unknown }>(
    "/api/v1/integrations/:harness/apply",
    async (request, reply) => {
      try {
        return apiSuccess(await services.apply(
          request.params.harness,
          applyPlanId(request.body)
        ));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.delete<{ Params: { harness: string } }>(
    "/api/v1/integrations/:harness",
    async (request, reply) => {
      try {
        return apiSuccess(await services.remove(request.params.harness));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );
}
