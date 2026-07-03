import type { FastifyInstance } from "fastify";
import { apiSuccess } from "../api.js";
import type { DashboardServices } from "../services.js";

export function registerDashboardRoute(
  app: FastifyInstance,
  services: DashboardServices
): void {
  app.get("/api/v1/dashboard", async () => apiSuccess(await services.dashboard()));
}
