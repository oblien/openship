import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import {
  CLOUD_SUPPORT_ACCOUNT_HEADER,
  CloudSupportCustomerInputSchema,
  CloudSupportCustomerReplySchema,
  CloudSupportCustomerStatusSchema,
  CloudSupportCustomerQuerySchema,
  CloudSupportCustomerListSchema,
  CloudSupportCustomerDetailSchema,
  CloudSupportReceiptSchema,
  CloudSupportIdSchema,
  parseInput,
} from "@repo/contracts";
import { ValidationError } from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import {
  getLinkedSupportSession,
  requestLinkedSupport,
  type LinkedSupportResult,
} from "@repo/platform/engine/modules/cloud-support/linked";
import { secureRouter } from "../../lib/secure-router";
import { authMiddleware } from "../../middleware/auth";
import { getRequestContext } from "../../lib/request-context";

const r = secureRouter(new Hono(), {
  module: "cloud-support-local",
  basePath: "/api/cloud/support",
  localOnly: true,
});
r.use("*", async (c, next) => {
  if (env.CLOUD_MODE) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  await next();
});
const customer = {
  reason:
    "Private Cloud account support. Requires a real user session; local installations use the caller's own verified Cloud link. Cloud enforces ticket ownership and message quotas. Organization grants, another member's link and API tokens do not grant access.",
};
const limitBody = bodyLimit({
  maxSize: 65_536,
  onError: (c) =>
    c.json({ error: "The message is too large. Please shorten it and try again." }, 413),
});
async function json(c: Context) {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ValidationError("Enter a valid support request.");
    throw error;
  }
}
function respond(c: Context, result: LinkedSupportResult) {
  if (result.retryAfter) c.header("Retry-After", result.retryAfter);
  return c.json(result.payload, result.status as ContentfulStatusCode);
}
function ticketPath(c: Context) {
  return `/mine/${parseInput(CloudSupportIdSchema, c.req.param("id"))}`;
}
const accountKey = (c: Context) => c.req.header(CLOUD_SUPPORT_ACCOUNT_HEADER);

r.public("get", "/session", customer, authMiddleware, async (c) =>
  respond(c, await getLinkedSupportSession(getRequestContext(c))),
);
r.public("get", "/mine", customer, authMiddleware, async (c) => {
  const query = c.req.query();
  const input = parseInput(CloudSupportCustomerQuerySchema, {
    ...query,
    limit: Number(query.limit ?? "25"),
  });
  const params = new URLSearchParams(
    Object.entries(input).map(([key, value]): [string, string] => [key, String(value)]),
  );
  return respond(
    c,
    await requestLinkedSupport(
      getRequestContext(c),
      accountKey(c),
      `/mine?${params}`,
      CloudSupportCustomerListSchema,
    ),
  );
});
r.public("post", "/mine", customer, authMiddleware, limitBody, async (c) =>
  respond(
    c,
    await requestLinkedSupport(
      getRequestContext(c),
      accountKey(c),
      "/mine",
      CloudSupportReceiptSchema,
      "POST",
      parseInput(CloudSupportCustomerInputSchema, await json(c)),
    ),
  ),
);
r.public("get", "/mine/:id", customer, authMiddleware, async (c) =>
  respond(
    c,
    await requestLinkedSupport(
      getRequestContext(c),
      accountKey(c),
      ticketPath(c),
      CloudSupportCustomerDetailSchema,
    ),
  ),
);
r.public("post", "/mine/:id/replies", customer, authMiddleware, limitBody, async (c) =>
  respond(
    c,
    await requestLinkedSupport(
      getRequestContext(c),
      accountKey(c),
      `${ticketPath(c)}/replies`,
      CloudSupportCustomerDetailSchema,
      "POST",
      parseInput(CloudSupportCustomerReplySchema, await json(c)),
    ),
  ),
);
r.public("patch", "/mine/:id", customer, authMiddleware, limitBody, async (c) =>
  respond(
    c,
    await requestLinkedSupport(
      getRequestContext(c),
      accountKey(c),
      ticketPath(c),
      CloudSupportCustomerDetailSchema,
      "PATCH",
      parseInput(CloudSupportCustomerStatusSchema, await json(c)),
    ),
  ),
);

export const cloudSupportLocalRoutes = r.hono;
