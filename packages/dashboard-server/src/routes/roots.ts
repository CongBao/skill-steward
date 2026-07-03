import type { FastifyInstance } from "fastify";
import { apiSuccess } from "../api.js";
import type { DashboardServices } from "../services.js";

export function registerRootRoute(app: FastifyInstance, services: DashboardServices): void {
  app.get("/api/v1/roots", async () => apiSuccess(await services.roots()));
}
