import { serializePublicIntegrationError } from "@skill-steward/integrations";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  IntegrationServiceError,
  type IntegrationServices
} from "../integration-services.js";

function sendIntegrationError(reply: FastifyReply, error: unknown) {
  const publicError = serializePublicIntegrationError(error);
  return reply.code(publicError.httpStatus).send(apiFailure(
    publicError.code,
    publicError.message,
    publicError.receipt ? { receipt: publicError.receipt } : undefined
  ));
}

function strictPlanId(body: unknown): string {
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
      "Mutation requires a strict JSON body containing only { planId }"
    );
  }
  return body.planId;
}

function withApplyCommand<T extends {
  planId: string;
  availability: { available: boolean };
}>(plan: T, command: "apply" | "remove"): T & { applyCommand: string | null } {
  return {
    ...plan,
    applyCommand: plan.availability.available
      ? `skill-steward integrate ${command} --plan ${plan.planId} --confirm`
      : null
  };
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  services: IntegrationServices
): void {
  app.get("/api/v1/integrations", async (_request, reply) => {
    try {
      return apiSuccess(await services.list());
    } catch (error) {
      return sendIntegrationError(reply, error);
    }
  });
  app.get(
    "/api/v1/integrations/capabilities",
    async (_request, reply) => {
      try {
        return apiSuccess(services.capabilities());
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.post<{ Params: { harness: string } }>(
    "/api/v1/integrations/:harness/plan",
    async (request, reply) => {
      try {
        return apiSuccess(withApplyCommand(
          await services.plan(request.params.harness),
          "apply"
        ));
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
          strictPlanId(request.body)
        ));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.post<{ Params: { harness: string } }>(
    "/api/v1/integrations/:harness/disconnect/plan",
    async (request, reply) => {
      try {
        return apiSuccess(withApplyCommand(
          await services.planDisconnect(request.params.harness),
          "remove"
        ));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );

  app.post<{ Params: { harness: string }; Body: unknown }>(
    "/api/v1/integrations/:harness/disconnect",
    async (request, reply) => {
      try {
        return apiSuccess(await services.disconnect(
          request.params.harness,
          strictPlanId(request.body)
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
        return apiSuccess(await services.removeLegacy(request.params.harness));
      } catch (error) {
        return sendIntegrationError(reply, error);
      }
    }
  );
}
