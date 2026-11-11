import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Type } from "@sinclair/typebox";
import {
  CLOUD_SUPPORT_ACCOUNT_HEADER,
  CloudSupportStatusSchema,
  CloudSupportIdSchema,
  CloudSupportInputSchema,
  parseInput,
} from "@repo/contracts";
import { ValidationError, AppError } from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import {
  cloudSupport,
  deliverCloudSupport,
} from "@repo/platform/engine/modules/cloud-support/index";
import { secureRouter } from "../../lib/secure-router";
import { rateLimit } from "../../lib/rate-limit";
import { internalAuth } from "../../middleware/internal-auth";
import { authMiddleware } from "../../middleware/auth";
import { getRequestContext } from "../../lib/request-context";
import { verifyContactChallenge } from "./contact-challenge";

const r = secureRouter(new Hono(), { module: "cloud-support", basePath: "/api/cloud/support" });
r.use("*", async (c, next) => {
  if (!env.CLOUD_MODE) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  await next();
});
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
const operator = {
  reason:
    "Cloud support operator API. Requires the instance's internal token; never available to customer organization owners.",
};
const statusBody = Type.Object(
  { status: CloudSupportStatusSchema },
  { additionalProperties: false },
);
function ticketId(c: Context) {
  return parseInput(CloudSupportIdSchema, c.req.param("id"));
}

const customer = {
  reason:
    "Private Cloud account support. Requires a real user session; local installations use the caller's own verified Cloud link. Cloud enforces ticket ownership and message quotas. Organization grants, another member's link and API tokens do not grant access.",
};
const customerAccount: MiddlewareHandler = async (c, next) => {
  cloudSupport.assertCustomerAccount(
    getRequestContext(c),
    c.req.header(CLOUD_SUPPORT_ACCOUNT_HEADER),
  );
  await next();
};
async function customerLimit(c: Context, subjectId: string, reply = false) {
  const result = await rateLimit({
    policy: reply ? "support-reply" : "support-contact",
    subjectId,
  });
  if (!result.allowed) {
    c.header("Retry-After", String(Math.ceil(result.resetMs / 1000)));
    throw new AppError("Too many support messages. Please try again later.", 429);
  }
  await ipLimit(c);
}

async function ipLimit(c: Context) {
  const result = await rateLimit({
    policy: "support-contact-ip",
    subjectId: c.var.clientIp ?? "unknown",
  });
  if (!result.allowed) {
    c.header("Retry-After", String(Math.ceil(result.resetMs / 1000)));
    throw new AppError("Too many messages from this connection. Please try again later.", 429);
  }
}

r.public("get", "/session", customer, authMiddleware, customerAccount, (c) =>
  c.json(cloudSupport.sessionForCustomer(getRequestContext(c))),
);
r.public("get", "/mine", customer, authMiddleware, customerAccount, async (c) => {
  const query = c.req.query();
  return c.json(
    await cloudSupport.listForCustomer(getRequestContext(c), {
      ...query,
      limit: Number(query.limit ?? "25"),
    }),
  );
});
r.public("post", "/mine", customer, authMiddleware, customerAccount, limitBody, async (c) => {
  const result = await cloudSupport.submitForCustomer(
    getRequestContext(c),
    await json(c),
    (subject) => customerLimit(c, subject),
    c.var.clientIp,
  );
  deliverCloudSupport();
  return c.json(result, 201);
});
r.public("get", "/mine/:id", customer, authMiddleware, customerAccount, async (c) =>
  c.json(await cloudSupport.getForCustomer(getRequestContext(c), ticketId(c))),
);
r.public(
  "post",
  "/mine/:id/replies",
  customer,
  authMiddleware,
  customerAccount,
  limitBody,
  async (c) => {
    const result = await cloudSupport.replyForCustomer(
      getRequestContext(c),
      ticketId(c),
      await json(c),
      (subject) => customerLimit(c, subject, true),
      c.var.clientIp,
    );
    deliverCloudSupport();
    return c.json(result, 201);
  },
);
r.public("patch", "/mine/:id", customer, authMiddleware, customerAccount, limitBody, async (c) =>
  c.json(await cloudSupport.setStatusForCustomer(getRequestContext(c), ticketId(c), await json(c))),
);

r.public(
  "post",
  "/",
  {
    reason:
      "Public contact intake requires a server-verified bot challenge. Customer support requires a signed-in account through /mine. Only receipts are returned anonymously.",
  },
  limitBody,
  async (c) => {
    const raw = await json(c);
    if (raw?.source === "support")
      throw new AppError(
        "Sign in to Openship Cloud to open a support request.",
        401,
        "SUPPORT_SESSION_REQUIRED",
      );
    const { turnstileToken, ...input } = parseInput(
      Type.Composite(
        [
          CloudSupportInputSchema,
          Type.Object({ turnstileToken: Type.String({ minLength: 1, maxLength: 2048 }) }),
        ],
        { additionalProperties: false },
      ),
      raw,
    );
    await ipLimit(c);
    await cloudSupport.assertAllowed(input.email, c.var.clientIp);
    await verifyContactChallenge(turnstileToken, c.var.clientIp);
    const ticket = await cloudSupport.submit(
      input,
      async (recipientHash) => {
        // The website proxies requests without inventing/forwarding a trusted IP.
        // In addition to the router's per-IP ceiling, limit by the contact address
        // across every API replica. Only the hash reaches the shared limiter.
        const result = await rateLimit({ policy: "support-contact", subjectId: recipientHash });
        if (!result.allowed) {
          c.header("Retry-After", String(Math.ceil(result.resetMs / 1000)));
          throw new AppError(
            "Too many support requests for this email. Please reply to your existing request or try again later.",
            429,
          );
        }
      },
      c.var.clientIp,
    );
    deliverCloudSupport();
    return c.json(ticket, 201);
  },
);

const blockBody = Type.Object(
  {
    kind: Type.Union([Type.Literal("email"), Type.Literal("ip")]),
    value: Type.String({ minLength: 1, maxLength: 254 }),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
r.public("get", "/blocks", operator, internalAuth, async (c) =>
  c.json({ blocks: await cloudSupport.listBlocks() }),
);
r.public("post", "/blocks", operator, internalAuth, limitBody, async (c) =>
  c.json(await cloudSupport.setBlock(parseInput(blockBody, await json(c)))),
);
r.public("delete", "/blocks", operator, internalAuth, limitBody, async (c) =>
  c.json(await cloudSupport.setBlock(parseInput(blockBody, await json(c)), true)),
);

r.public("get", "/tickets", operator, internalAuth, async (c) => {
  const status = c.req.query("status");
  const limit = c.req.query("limit") ?? "25";
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    throw new ValidationError("Limit must be between 1 and 100.");
  return c.json(
    await cloudSupport.list({
      ...(status ? { status: parseInput(CloudSupportStatusSchema, status) } : {}),
      before: c.req.query("before")
        ? parseInput(CloudSupportIdSchema, c.req.query("before"))
        : undefined,
      limit: Number(limit),
    }),
  );
});
r.public("get", "/tickets/:id", operator, internalAuth, async (c) =>
  c.json(await cloudSupport.get(ticketId(c))),
);
r.public("patch", "/tickets/:id", operator, internalAuth, limitBody, async (c) => {
  const { status } = parseInput(statusBody, await json(c));
  await cloudSupport.setStatus(ticketId(c), status);
  return c.json({ ok: true });
});
r.public("post", "/tickets/:id/replies", operator, internalAuth, limitBody, async (c) => {
  const message = await cloudSupport.reply(ticketId(c), await json(c));
  deliverCloudSupport();
  return c.json({ id: message.id, deliveredAt: message.deliveredAt }, 202);
});
r.public("post", "/tickets/:id/retry", operator, internalAuth, async (c) => {
  const result = await cloudSupport.retry(ticketId(c));
  deliverCloudSupport();
  return c.json(result, 202);
});

export const cloudSupportRoutes = r.hono;
