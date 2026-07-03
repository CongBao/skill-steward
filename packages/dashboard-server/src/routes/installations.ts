import { InstallationMutationLeaseError } from "@skill-steward/store";
import type { FastifyInstance, FastifyReply } from "fastify";
import { apiFailure, apiSuccess } from "../api.js";
import type {
  InstallationPlanRequest,
  InstallationServices
} from "../installation-services.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("File content must be base64");
  }
  return Buffer.from(value, "base64");
}

function sendInstallationError(reply: FastifyReply, error: unknown) {
  if (error instanceof InstallationMutationLeaseError) {
    return reply.code(409).send(apiFailure(error.code, error.message));
  }
  throw error;
}

export function registerInstallationRoutes(
  app: FastifyInstance,
  services: InstallationServices
): void {
  app.post<{ Body: unknown }>("/api/v1/install-sources/inspect", async (request, reply) => {
    try {
      const body = object(request.body);
      const source = object(body.source);
      if (source.kind === "folder") {
        if (typeof source.label !== "string" || !Array.isArray(body.files)) throw new Error("Invalid folder source");
        const files = body.files.map((value) => {
          const file = object(value);
          if (typeof file.relativePath !== "string") throw new Error("Invalid folder file path");
          return { relativePath: file.relativePath, data: decodeBase64(file.contentBase64) };
        });
        return apiSuccess(await services.inspectFolder({ kind: "folder", label: source.label }, files));
      }
      if (source.kind === "zip") {
        if (typeof source.fileName !== "string") throw new Error("Invalid ZIP source");
        return apiSuccess(
          await services.inspectZip(
            { kind: "zip", fileName: source.fileName },
            decodeBase64(body.archiveBase64)
          )
        );
      }
      if (source.kind === "git") {
        if (typeof source.url !== "string") throw new Error("Invalid Git source");
        return apiSuccess(
          await services.inspectGit({
            kind: "git",
            url: source.url,
            ...(typeof source.ref === "string" ? { ref: source.ref } : {}),
            ...(typeof source.subdirectory === "string"
              ? { subdirectory: source.subdirectory }
              : {})
          })
        );
      }
      throw new Error("Unsupported installation source");
    } catch (error) {
      return reply
        .code(400)
        .send(apiFailure("INVALID_INSTALL_SOURCE", error instanceof Error ? error.message : String(error)));
    }
  });

  app.post<{ Body: InstallationPlanRequest }>(
    "/api/v1/installations/plan",
    async (request) => apiSuccess(await services.plan(request.body))
  );

  app.post<{ Body: { planId?: string; confirmed?: boolean } }>(
    "/api/v1/installations/commit",
    async (request, reply) => {
      if (!request.body?.confirmed || typeof request.body.planId !== "string") {
        return reply
          .code(400)
          .send(apiFailure("CONFIRMATION_REQUIRED", "Explicit installation confirmation is required"));
      }
      try {
        return apiSuccess(await services.commit(request.body.planId));
      } catch (error) {
        return sendInstallationError(reply, error);
      }
    }
  );

  app.get("/api/v1/installations", async () => apiSuccess(await services.history()));

  app.post<{ Params: { transactionId: string } }>(
    "/api/v1/installations/:transactionId/rollback",
    async (request, reply) => {
      try {
        return apiSuccess(await services.rollback(request.params.transactionId));
      } catch (error) {
        return sendInstallationError(reply, error);
      }
    }
  );
}
