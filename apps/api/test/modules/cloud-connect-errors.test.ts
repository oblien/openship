import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { seedOwner, installFakeRunner, type SeededOwner } from "./jobs/_harness";
import { cloudLocalRoutes } from "../../src/modules/cloud/cloud-local.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/cloud", cloudLocalRoutes);
const remote = vi.fn();
let owner: SeededOwner;
const finalize = () =>
  app.request("/api/cloud/connect-finalize", {
    method: "POST",
    headers: { ...owner.auth, "content-type": "application/json" },
    body: JSON.stringify({ code: "secret-login-code", codeVerifier: "secret-verifier" }),
  });

beforeAll(() => vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory"));
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  owner = await seedOwner();
  remote.mockReset();
  vi.stubGlobal("fetch", remote);
});

describe("Cloud sign-in failure responses", () => {
  it("bounds an unresponsive code exchange and preserves the actionable timeout response", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    remote.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const pending = finalize();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(remote.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "CLOUD_CONNECTION_TIMEOUT",
      error: expect.stringContaining("did not respond in time"),
    });
  });

  it("reports network failure without leaking the code or verifier", async () => {
    remote.mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    );
    const response = await finalize();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      code: "CLOUD_CONNECTION_UNAVAILABLE",
      error: expect.stringContaining("Could not reach"),
    });
    expect(body).not.toContain("secret-login-code");
    expect(body).not.toContain("secret-verifier");
  });

  it.each([429, 503])(
    "does not label Cloud unavailability as a rejected login (HTTP %s)",
    async (status) => {
      remote.mockResolvedValue(new Response("unavailable", { status }));
      const response = await finalize();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CLOUD_CONNECTION_UNAVAILABLE" });
    },
  );

  it("retains rejection of an invalid or used authorization code", async () => {
    remote.mockResolvedValue(new Response("invalid code", { status: 401 }));
    expect((await finalize()).status).toBe(401);
    expect(remote).toHaveBeenCalledTimes(1);
  });
});
