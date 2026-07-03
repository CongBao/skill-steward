import { catalogSourceSchema } from "@skill-steward/catalog";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import {
  CatalogServiceError,
  type CatalogServices
} from "../catalog-services.js";

function sendCatalogError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof CatalogServiceError)) throw error;
  const status = error.code === "CATALOG_SOURCE_NOT_FOUND" ||
    error.code === "CATALOG_CANDIDATE_NOT_FOUND"
    ? 404
    : 409;
  return reply.code(status).send(apiFailure(error.code, error.message));
}

function parseSource(value: unknown) {
  const body = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return catalogSourceSchema.safeParse({
    id: body.id,
    name: body.name,
    kind: "git",
    url: body.url,
    ...(body.ref === undefined ? {} : { ref: body.ref }),
    ...(body.subdirectory === undefined ? {} : { subdirectory: body.subdirectory }),
    enabled: false,
    trust: "user",
    preset: false
  });
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  services: CatalogServices
): void {
  app.get("/api/v1/catalog/sources", async () => apiSuccess(await services.list()));

  app.post<{ Body: unknown }>("/api/v1/catalog/sources", async (request, reply) => {
    const parsed = parseSource(request.body);
    if (!parsed.success) {
      return reply.code(400).send(apiFailure(
        "INVALID_CATALOG_SOURCE",
        parsed.error.issues[0]?.message ?? "Invalid catalog source"
      ));
    }
    try {
      return apiSuccess(await services.add(parsed.data));
    } catch (error) {
      return sendCatalogError(reply, error);
    }
  });

  for (const [path, enabled] of [["enable", true], ["disable", false]] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/catalog/sources/:id/${path}`,
      async (request, reply) => {
        try {
          return apiSuccess(await services.enable(request.params.id, enabled));
        } catch (error) {
          return sendCatalogError(reply, error);
        }
      }
    );
  }

  app.delete<{ Params: { id: string } }>(
    "/api/v1/catalog/sources/:id",
    async (request, reply) => {
      try {
        await services.remove(request.params.id);
        return apiSuccess({ removed: true });
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    }
  );

  app.post("/api/v1/catalog/refresh", async (_request, reply) => {
    try {
      return apiSuccess(await services.refresh());
    } catch (error) {
      return sendCatalogError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/catalog/candidates/:id/inspect-installation",
    async (request, reply) => {
      try {
        const body = typeof request.body === "object" && request.body !== null
          ? request.body as Record<string, unknown>
          : {};
        if (body.preflightId !== undefined && typeof body.preflightId !== "string") {
          return reply.code(400).send(apiFailure(
            "INVALID_INSTALL_PROVENANCE",
            "preflightId must be a string"
          ));
        }
        return apiSuccess(await services.inspectCandidate(
          request.params.id,
          typeof body.preflightId === "string" ? body.preflightId : undefined
        ));
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    }
  );
}
