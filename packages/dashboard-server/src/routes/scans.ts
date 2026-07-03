import type { FastifyInstance } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import type { DashboardServices } from "../services.js";

export function registerScanRoute(app: FastifyInstance, services: DashboardServices): void {
  let scanRunning = false;
  app.post<{ Body: { roots?: unknown } }>("/api/v1/scans", async (request, reply) => {
    if (scanRunning) {
      return reply.code(409).send(apiFailure("SCAN_IN_PROGRESS", "A scan is already running"));
    }
    const roots = request.body?.roots ?? [];
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
      return reply.code(400).send(apiFailure("INVALID_ROOTS", "Scan roots must be strings"));
    }
    scanRunning = true;
    try {
      return apiSuccess(await services.scan(roots));
    } finally {
      scanRunning = false;
    }
  });
}
