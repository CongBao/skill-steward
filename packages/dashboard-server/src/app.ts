import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import Fastify, {
  type FastifyError,
  type FastifyInstance
} from "fastify";
import { apiFailure, apiSuccess } from "./api.js";
import type { CatalogServices } from "./catalog-services.js";
import type { InstallationServices } from "./installation-services.js";
import type { IntegrationServices } from "./integration-services.js";
import type { EvidenceServices } from "./evidence-services.js";
import type { GovernanceServices } from "./governance-services.js";
import { registerDashboardRoute } from "./routes/dashboard.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerDetailRoutes } from "./routes/details.js";
import { registerHistoryRoute } from "./routes/history.js";
import { registerInstallationRoutes } from "./routes/installations.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerLabelRoute } from "./routes/labels.js";
import { registerPreflightRoutes } from "./routes/preflights.js";
import { registerRootRoute } from "./routes/roots.js";
import { registerScanRoute } from "./routes/scans.js";
import { installSecurityBoundary } from "./security.js";
import type { DashboardServices } from "./services.js";
import type { PreflightServices } from "./preflight-services.js";

export interface CreateDashboardAppOptions {
  mutationToken?: string;
  services?: DashboardServices;
  installationServices?: InstallationServices;
  preflightServices?: PreflightServices;
  catalogServices?: CatalogServices;
  integrationServices?: IntegrationServices;
  evidenceServices?: EvidenceServices;
  governanceServices?: GovernanceServices;
  assetsDirectory?: string;
}

export interface DashboardApp {
  app: FastifyInstance;
  mutationToken: string;
}

function spaShell(mutationToken: string): string {
  const bootstrap = JSON.stringify({ apiVersion: 1, mutationToken });
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill Steward</title></head>
  <body><div id="root"></div><script id="__SKILL_STEWARD_BOOTSTRAP__" type="application/json">${bootstrap}</script></body>
</html>`;
}

function injectBootstrap(index: string, mutationToken: string): string {
  const bootstrap = JSON.stringify({ apiVersion: 1, mutationToken }).replaceAll("<", "\\u003c");
  const script = `<script id="__SKILL_STEWARD_BOOTSTRAP__" type="application/json">${bootstrap}</script>`;
  return index.includes("</body>") ? index.replace("</body>", `${script}</body>`) : `${index}${script}`;
}

const contentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

export function createDashboardApp(
  options: CreateDashboardAppOptions = {}
): DashboardApp {
  const mutationToken =
    options.mutationToken ?? randomBytes(32).toString("base64url");
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024,
    disableRequestLogging: true
  });
  installSecurityBoundary(app, mutationToken);

  app.get("/api/v1/health", async () => apiSuccess({ status: "ok" }));

  if (options.services) {
    registerDashboardRoute(app, options.services);
    registerDetailRoutes(app, options.services);
    registerHistoryRoute(app, options.services);
    registerRootRoute(app, options.services);
    registerLabelRoute(app, options.services);
    registerScanRoute(app, options.services);
  }
  if (options.installationServices) {
    registerInstallationRoutes(app, options.installationServices);
  }
  if (options.preflightServices) {
    registerPreflightRoutes(app, options.preflightServices);
  }
  if (options.catalogServices) {
    registerCatalogRoutes(app, options.catalogServices);
  }
  if (options.integrationServices) {
    registerIntegrationRoutes(app, options.integrationServices);
  }
  if (options.evidenceServices) {
    registerEvidenceRoutes(app, options.evidenceServices);
  }
  if (options.governanceServices) {
    registerGovernanceRoutes(app, options.governanceServices);
  }

  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    return reply
      .code(error.statusCode && error.statusCode >= 400 ? error.statusCode : 500)
      .send(apiFailure("INTERNAL_ERROR", error.message));
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send(apiFailure("NOT_FOUND", "API route was not found"));
    }
    if (options.assetsDirectory && request.url.startsWith("/assets/")) {
      const root = resolve(options.assetsDirectory);
      const pathname = new URL(request.url, "http://localhost").pathname;
      const target = resolve(root, `.${pathname}`);
      if (!target.startsWith(`${root}${sep}`)) {
        return reply.code(404).send(apiFailure("NOT_FOUND", "Asset was not found"));
      }
      try {
        const asset = await readFile(target);
        return reply.type(contentTypes[extname(target)] ?? "application/octet-stream").send(asset);
      } catch {
        return reply.code(404).send(apiFailure("NOT_FOUND", "Asset was not found"));
      }
    }
    if (options.assetsDirectory) {
      try {
        const index = await readFile(resolve(options.assetsDirectory, "index.html"), "utf8");
        return reply
          .type("text/html; charset=utf-8")
          .send(injectBootstrap(index, mutationToken));
      } catch {
        // Fall through to the embedded first-run shell.
      }
    }
    return reply.type("text/html; charset=utf-8").send(spaShell(mutationToken));
  });

  return { app, mutationToken };
}
