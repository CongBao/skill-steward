import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

export interface StartDashboardOptions {
  app: FastifyInstance;
  port?: number;
  host?: "127.0.0.1" | "::1";
}

export async function startDashboardServer({
  app,
  port = 4762,
  host = "127.0.0.1"
}: StartDashboardOptions): Promise<{ url: string; close: () => Promise<void> }> {
  await app.listen({ host, port });
  const address = app.server.address() as AddressInfo;
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${displayHost}:${address.port}`,
    close: () => app.close()
  };
}
