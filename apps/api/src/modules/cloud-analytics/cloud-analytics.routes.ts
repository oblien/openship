import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Value } from "@sinclair/typebox/value";
import { CloudBrowserCaptureSchema, type CloudBrowserCapture } from "@repo/contracts";
import { auth } from "@repo/platform/engine/lib/auth";
import { getCloudAnalyticsConfig } from "@repo/platform/engine/modules/cloud-analytics/config";
import { cloudAnalytics } from "@repo/platform/engine/modules/cloud-analytics/index";
import { resolveActiveOrganizationId } from "../../middleware/active-organization";
import { secureRouter } from "../../lib/secure-router";

// Deliberately not an SDK/MCP operation. Public browser telemetry is optional,
// Cloud-only, origin-bound, and cannot assert identities or business outcomes.
const r = secureRouter(new Hono(), {
  module: "cloud-analytics",
  basePath: "/api/cloud/telemetry",
});
r.use("*", async (c, next) => {
  const config = getCloudAnalyticsConfig();
  if (!config) return c.body(null, 404);
  if (c.req.header("origin") !== config.dashboardOrigin || c.req.header("authorization"))
    return c.body(null, 403);
  await next();
});
r.public(
  "post",
  "/",
  {
    reason:
      "Optional hosted dashboard product telemetry; validates the exact Origin and associates only verified cookie sessions. Not an SDK/MCP operation.",
  },
  bodyLimit({ maxSize: 4_096 }),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (error instanceof SyntaxError) return c.body(null, 400);
      throw error; // Preserve the streaming body limiter's 413.
    }
    if (!Value.Check(CloudBrowserCaptureSchema, body)) return c.body(null, 400);
    try {
      // Cookie sessions only. Neither userId nor organizationId from the browser
      // is trusted, including stale active-org cookies after membership removal.
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const userId = session?.user.id ?? null;
      if ((body as CloudBrowserCapture).expectedUserId !== userId) return c.body(null, 204);
      const organizationId = session
        ? await resolveActiveOrganizationId(userId!, session.session.activeOrganizationId ?? null)
        : null;
      if (session && !organizationId) return c.body(null, 204);
      await cloudAnalytics.browser({ userId, organizationId }, body as CloudBrowserCapture);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/modules/cloud-analytics/cloud-analytics.routes");
      // Session/telemetry outages don't cause toasts or break the page. Never
      // downgrade an unresolvable signed-in session to anonymous activity.
    }
    return c.body(null, 204);
  },
);

export const cloudAnalyticsRoutes = r.hono;
