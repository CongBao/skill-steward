import type { FastifyInstance } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import type { DashboardServices, FindingLabelValue } from "../services.js";

const allowed = new Set<FindingLabelValue>([
  "useful",
  "incorrect",
  "unclear",
  "already-known"
]);

export function registerLabelRoute(app: FastifyInstance, services: DashboardServices): void {
  app.post<{
    Params: { id: string };
    Body: { label?: string; comment?: string };
  }>("/api/v1/findings/:id/labels", async (request, reply) => {
    const { label, comment } = request.body ?? {};
    if (!label || !allowed.has(label as FindingLabelValue) || (comment?.length ?? 0) > 2_000) {
      return reply.code(400).send(apiFailure("INVALID_LABEL", "Finding label is invalid"));
    }
    await services.labelFinding(
      request.params.id,
      label as FindingLabelValue,
      comment
    );
    return apiSuccess({ saved: true });
  });
}
