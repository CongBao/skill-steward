import { afterEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app.js";

describe("dashboard security boundary", () => {
  const apps: Array<ReturnType<typeof createDashboardApp>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("accepts loopback hosts and applies browser security headers", async () => {
    const { app } = createDashboardApp({ mutationToken: "test-token" });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:4762" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: "ok" }, error: null });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects non-loopback hosts, cross-origin mutations, and missing tokens", async () => {
    const { app } = createDashboardApp({ mutationToken: "test-token" });
    apps.push(app);
    app.post("/api/v1/test-mutation", async () => ({ ok: true }));

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/health",
          headers: { host: "evil.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/test-mutation",
          headers: { host: "localhost:4762" }
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/test-mutation",
          headers: {
            host: "localhost:4762",
            origin: "https://evil.example",
            "x-skill-steward-token": "test-token"
          }
        })
      ).statusCode
    ).toBe(403);
  });
});
