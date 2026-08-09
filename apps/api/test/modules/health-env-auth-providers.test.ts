import { describe, expect, it, vi } from "vitest";

/**
 * GET /health/env is the public, read-only surface the dashboard bootstraps
 * from (`authMode`, `selfHosted`, …). `authProviders` joins it: the list of
 * social logins this instance actually has credentials for, so the login page
 * can render the buttons that will work instead of guessing from `selfHosted`.
 *
 * This file owns the CONFIGURED case, and it has to set the credentials in
 * `process.env` before `config/env` parses them — env is validated once at
 * import time, so `vi.hoisted` (which runs before the hoisted imports) is the
 * only place a test can influence it. The not-configured case lives in
 * health-env-authmode.test.ts, which runs with the suite's bare env.
 *
 * No auth is applied to this route on purpose, which is exactly why the last
 * assertion here is about what is NOT in the body: the credential values must
 * never appear, in any field, redacted or otherwise.
 */

const CREDS = vi.hoisted(() => {
  const values = {
    GITHUB_CLIENT_ID: "Iv1.health-env-github-id",
    GITHUB_CLIENT_SECRET: "health-env-github-secret",
    GOOGLE_CLIENT_ID: "health-env-google-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "health-env-google-secret",
  };
  Object.assign(process.env, values);
  return values;
});

vi.mock("@repo/db", () => ({
  repos: { instanceSettings: { get: async () => ({}) } },
}));

async function getEnv() {
  const { Hono } = await import("hono");
  const { healthRoutes } = await import("../../src/modules/health/health.routes");
  // Mirror clientIpMiddleware (app.ts) — the route is rate-limited per IP and
  // 400s without a resolvable subject when mounted in isolation.
  const app = new Hono<{ Variables: { clientIp: string } }>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.route("/", healthRoutes);
  const res = await app.request("/env");
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /health/env authProviders — credentials configured", () => {
  it("advertises every provider whose credentials are set", async () => {
    const { res, body } = await getEnv();
    expect(res.status).toBe(200);
    expect(body.authProviders).toEqual([
      { id: "github", kind: "social" },
      { id: "google", kind: "social" },
    ]);
  });

  it("leaks no client id and no client secret on this unauthenticated route", async () => {
    const { body } = await getEnv();
    const serialized = JSON.stringify(body);
    for (const value of Object.values(CREDS)) {
      expect(serialized).not.toContain(value);
    }
  });
});
