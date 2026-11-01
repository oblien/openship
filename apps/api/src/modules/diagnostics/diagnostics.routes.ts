import { reportError } from "@repo/core/diagnostics";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { secureRouter } from "../../lib/secure-router";

// Client reports cannot assert a tenant, user, severity, timestamp, or stack
// ownership. They are untrusted diagnostic hints, never audit/security events.
export const clientErrorBatch = z
  .object({
    events: z
      .array(
        z
          .object({
            name: z.string().max(80),
            message: z.string().max(2049),
            component: z.string().min(1).max(160).optional(),
            stack: z.string().max(4097).optional(),
            code: z
              .string()
              .regex(/^[\w.-]{1,100}$/)
              .optional(),
            page: z.string().max(512).optional(),
            requestId: z.string().uuid().optional(),
            eventId: z.string().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

const router = secureRouter(new Hono(), {
  module: "diagnostics",
  basePath: "/api/diagnostics",
  mcpExcluded: "Browser error intake; no user operation or data access.",
});
router.public(
  "post",
  "/client-errors",
  {
    reason:
      "Dashboard errors must be reportable before authentication; bounded and rate-limited, with no read API.",
    rateLimit: "diagnostics",
  },
  bodyLimit({ maxSize: 65_536 }),
  async (c) => {
    const { events } = clientErrorBatch.parse(await c.req.json());
    for (const event of events) {
      // Re-sanitize in the server reporter. Never trust that the sender used our
      // browser SDK or that its supplied stack/code describes a real exception.
      reportError(
        {
          name: event.name,
          message: event.message,
          stack: event.stack,
          code: event.code,
        },
        {
          source: "dashboard",
          kind: "client",
          component: event.component ?? "dashboard",
          untrusted: true,
          route: event.page,
          parentRequestId: event.requestId,
          clientEventId: event.eventId,
          severity: "warn",
          handled: true,
        },
      );
    }
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  },
);

export const diagnosticsRoutes = router.hono;
