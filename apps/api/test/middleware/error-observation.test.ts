import { enrichErrorContext } from "@repo/core/diagnostics/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AppError,
  errorReporter,
  reportError,
  type ErrorEvent,
} from "@repo/core";
import { observeRequestErrors } from "../../src/middleware/error-observation";
import { handleApiError } from "../../src/middleware/error-handler";

vi.mock("@repo/platform/engine/modules/cloud-analytics/index", () => ({
  cloudAnalytics: { enabled: () => false },
}));

const events: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((batch) => {
    events.push(...batch);
  });
});
afterEach(async () => {
  await errorReporter.flush();
  errorReporter.setEnabled(false);
});

function createApp() {
  return new Hono().use("*", observeRequestErrors).onError(handleApiError);
}

async function collected() {
  // Returned JSON errors are inspected in a bounded, detached task.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await errorReporter.flush();
  return events;
}

describe("global request error observation", () => {
  it("keeps response references without reading or capturing local error bodies", async () => {
    errorReporter.setEnabled(false);
    const clone = vi.spyOn(Response.prototype, "clone");
    try {
      const app = createApp();
      app.get("/private", (c) => c.json({ error: "Private local message" }, 403));
      const response = await app.request("/private");
      expect(response.status).toBe(403);
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
      expect(await response.json()).toEqual({ error: "Private local message" });
      expect(await collected()).toHaveLength(0);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("names the intended route when an early authorization guard stops dispatch", async () => {
    const app = createApp();
    app.use("/api/*", (c) => c.json({ error: "Forbidden" }, 403));
    const handler = vi.fn((c) => c.json({ ok: true }));
    app.get("/api/projects/:projectId", handler);
    const response = await app.request(
      "/api/projects/private-project?token=private-token",
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await collected())[0]).toMatchObject({
      category: "authorization",
      context: { route: "/api/projects/:projectId", statusCode: 403 },
    });
    expect(JSON.stringify(events)).not.toMatch(/private-project|private-token/);
  });

  it.each([401, 403, 404, 409, 429, 503])(
    "records returned HTTP %s without changing status, headers or body",
    async (status) => {
      const app = createApp();
      app.get("/api/check/:id", (c) =>
        c.json({ error: "Denied", code: "DENIED" }, status as 401),
      );
      const response = await app.request("/api/check/resource?token=private");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Denied",
        code: "DENIED",
      });
      const observed = await collected();
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        context: {
          requestId: response.headers.get("X-Request-ID"),
          route: "/api/check/:id",
          statusCode: status,
          code: "DENIED",
        },
      });
      expect(JSON.stringify(observed)).not.toContain("private");
    },
  );

  it("records thrown errors once and keeps the original exception while hiding it from clients", async () => {
    const app = createApp();
    app.get("/api/crash", () => {
      throw Object.assign(
        new Error("Provider password=protected-value-913 failed"),
        { config: { token: "protected-value-913" } },
      );
    });
    const response = await app.request("/api/crash");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    const observed = await collected();
    expect(observed).toHaveLength(1);
    expect(observed[0]!.error.stack).toContain("error-observation.test");
    expect(JSON.stringify(observed)).not.toContain("protected-value-913");
  });

  it("keeps typed application errors and HTTP exception response headers", async () => {
    const app = createApp();
    app.get("/typed", () => {
      throw new AppError("Upgrade required", 402, "PLAN_UPGRADE_REQUIRED");
    });
    app.get("/limited", () => {
      throw new HTTPException(429, {
        res: new Response("Slow down", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      });
    });
    expect(await (await app.request("/typed")).json()).toMatchObject({
      error: "Upgrade required",
      code: "PLAN_UPGRADE_REQUIRED",
    });
    const limited = await app.request("/limited");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("30");
    expect(await limited.text()).toBe("Slow down");
    expect((await collected()).map((event) => event.category)).toEqual([
      "billing",
      "rate_limit",
    ]);
  });

  it("covers malformed JSON and unmatched routes before authenticated handlers", async () => {
    const app = createApp();
    app.post("/parse", async (c) => c.json(await c.req.json()));
    const response = await app.request("/parse", { method: "POST", body: "{" });
    expect(response.status).toBe(400);
    expect((await app.request("/does-not-exist?token=private")).status).toBe(
      404,
    );
    expect(
      (await collected()).map((event) => event.context.statusCode),
    ).toEqual([400, 404]);
  });

  it("generates trusted request ids and treats valid incoming ids only as a parent", async () => {
    const app = createApp();
    app.get("/denied", (c) => c.json({ error: "Forbidden" }, 403));
    const parent = "f316f24c-73c1-459b-8ba9-cb84c30dd377";
    const response = await app.request("/denied", {
      headers: { "X-Request-ID": parent },
    });
    expect(response.headers.get("X-Request-ID")).not.toBe(parent);
    expect((await collected())[0]!.context.parentRequestId).toBe(parent);
  });

  it("isolates concurrent tenant and request context across asynchronous failures", async () => {
    const app = createApp();
    app.get("/work/:tenant", async (c) => {
      const id = c.req.param("tenant");
      c.set("ctx", { organizationId: `org-${id}`, userId: `user-${id}` });
      enrichErrorContext({ organizationId: `org-${id}`, userId: `user-${id}` });
      await new Promise((resolve) => setTimeout(resolve, id === "a" ? 10 : 1));
      reportError(new Error(`worker-${id}`), {
        kind: "background",
        component: "test-worker",
      });
      throw new AppError(`request-${id}`, 503, "HOST_UNREACHABLE");
    });
    const responses = await Promise.all([
      app.request("/work/a"),
      app.request("/work/b"),
    ]);
    const observed = await collected();
    for (const [index, id] of ["a", "b"].entries()) {
      const own = observed.filter((event) =>
        event.error.message.endsWith(`-${id}`),
      );
      expect(own).toHaveLength(2);
      for (const event of own)
        expect(event.context).toMatchObject({
          organizationId: `org-${id}`,
          userId: `user-${id}`,
          requestId: responses[index]!.headers.get("X-Request-ID"),
        });
    }
  });

  it("does not buffer an arbitrary error response or await a slow diagnostic destination", async () => {
    const app = createApp();
    app.get("/large", (c) => c.json({ error: "private".repeat(50_000) }, 502));
    const response = await app.request("/large");
    expect((await response.json()).error).toHaveLength(350_000);
    expect((await collected())[0]!.error.message).toBe("HTTP 502");
  });

  it("does not turn successful requests into error events", async () => {
    const app = createApp().get("/ok", (c) => c.json({ ok: true }));
    expect((await app.request("/ok")).status).toBe(200);
    expect(await collected()).toHaveLength(0);
  });
});
