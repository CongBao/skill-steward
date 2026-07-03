import type { FastifyInstance } from "fastify";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostName(host).toLowerCase());
}

function error(code: string, message: string) {
  return { data: null, error: { code, message }, meta: { apiVersion: 1 } };
}

export function installSecurityBoundary(
  app: FastifyInstance,
  mutationToken: string
): void {
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");

    const host = request.headers.host ?? "";
    if (!isLoopbackHost(host)) {
      await reply.code(403).send(error("INVALID_HOST", "Only loopback hosts are allowed"));
      return;
    }
    if (!mutationMethods.has(request.method)) return;

    const origin = request.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        await reply.code(403).send(error("INVALID_ORIGIN", "Origin is invalid"));
        return;
      }
      if (originHost.toLowerCase() !== host.toLowerCase()) {
        await reply.code(403).send(error("INVALID_ORIGIN", "Origin does not match Host"));
        return;
      }
    }

    if (request.headers["x-skill-steward-token"] !== mutationToken) {
      await reply.code(401).send(error("INVALID_MUTATION_TOKEN", "Mutation token is missing or invalid"));
    }
  });
}
