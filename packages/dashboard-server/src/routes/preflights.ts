import {
  preflightFeedbackSchema,
  preflightRequestSchema
} from "@skill-steward/preflight";
import type { FastifyInstance } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  PreflightServiceError,
  type PreflightServices
} from "../preflight-services.js";

export function registerPreflightRoutes(
  app: FastifyInstance,
  services: PreflightServices
): void {
  app.post<{ Body: unknown }>("/api/v1/preflights", async (request, reply) => {
    const parsed = preflightRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          apiFailure(
            "INVALID_PREFLIGHT_REQUEST",
            parsed.error.issues[0]?.message ?? "Invalid preflight request"
          )
        );
    }
    return apiSuccess(await services.run(parsed.data));
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/preflights/:id/feedback",
    async (request, reply) => {
      const parsed = preflightFeedbackSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            apiFailure(
              "INVALID_PREFLIGHT_FEEDBACK",
              parsed.error.issues[0]?.message ?? "Invalid preflight feedback"
            )
          );
      }
      try {
        await services.feedback(request.params.id, parsed.data);
        return apiSuccess({ saved: true });
      } catch (error) {
        if (error instanceof PreflightServiceError) {
          const status = error.code === "PREFLIGHT_NOT_FOUND" ? 404 : 400;
          return reply.code(status).send(apiFailure(error.code, error.message));
        }
        throw error;
      }
    }
  );
}
