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
    return reply.code(error.code === "INVALID_INTEGRATION_HARNESS" ? 400 : 409)
      .send(apiFailure(error.code, error.message));
  }
  if (error instanceof IntegrationError || error instanceof CompanionSkillError) {
    return reply.code(409).send(apiFailure(error.code, error.message));
  }
  throw error;
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
        return apiSuccess(await services.plan(request.params.harness));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.post<{ Params: { harness: string } }>(
    "/api/v1/integrations/:harness/apply",
    async (request, reply) => {
      try {
        return apiSuccess(await services.apply(request.params.harness));
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
