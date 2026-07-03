import type { FastifyInstance } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import type { DashboardServices } from "../services.js";

export function registerDetailRoutes(
  app: FastifyInstance,
  services: DashboardServices
): void {
  app.get<{ Params: { id: string } }>("/api/v1/skills/:id", async (request, reply) => {
    const report = await services.latestReport();
    const skill = report?.skills.find(({ id }) => id === request.params.id);
    if (!skill) return reply.code(404).send(apiFailure("SKILL_NOT_FOUND", "Skill was not found"));
    return apiSuccess(skill);
  });

  app.get<{ Params: { id: string } }>("/api/v1/findings/:id", async (request, reply) => {
    const report = await services.latestReport();
    const finding = report?.findings.find(({ id }) => id === request.params.id);
    if (!finding) {
      return reply.code(404).send(apiFailure("FINDING_NOT_FOUND", "Finding was not found"));
    }
    return apiSuccess(finding);
  });
}
