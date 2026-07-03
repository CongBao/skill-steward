import type { FastifyInstance } from "fastify";
import { apiSuccess } from "../api.js";
import type { DashboardServices } from "../services.js";

export function registerHistoryRoute(app: FastifyInstance, services: DashboardServices): void {
  app.get("/api/v1/history", async () => apiSuccess(await services.history()));
}
