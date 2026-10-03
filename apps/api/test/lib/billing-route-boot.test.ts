import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { enforceRouteScanAtBoot, scanRoutes } from "../../src/lib/route-scanner";
import { billingLocalRoutes } from "../../src/modules/billing/billing-local.routes";
import { billingPlansRoutes, billingSaasRoutes } from "../../src/modules/billing/billing.routes";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["Cloud", billingSaasRoutes],
  ["self-hosted", billingLocalRoutes],
] as const)("allows API startup with the real %s billing routes", (_mode, routes) => {
  const app = new Hono().route("/api/billing", billingPlansRoutes).route("/api/billing", routes);
  expect(
    app.routes.some(
      (route) => route.method === "GET" && route.path === "/api/billing/subscription/quote",
    ),
  ).toBe(true);

  // Exercise the production scanner, not a duplicate rule or mocked route spec.
  const result = scanRoutes(app);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);

  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("The route scanner refused API startup");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  enforceRouteScanAtBoot(app);
  expect(exit).not.toHaveBeenCalled();
});
