import { Hono } from "hono";
import { actionOidcService } from "@repo/platform/engine/modules/actions/oidc";
import { secureRouter } from "../../lib/secure-router";
import { handleApiError } from "../../middleware/error-handler";

const r = secureRouter(new Hono(), { module: "actions-oidc", basePath: "/api/actions/oidc" });
const discovery = {
  reason: "Public OIDC discovery and RSA verification keys contain no credentials or tenant data.",
  rateLimit: "actions-runtime" as const,
};
r.public("get", "/.well-known/openid-configuration", discovery, (c) => {
  try {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(actionOidcService().discovery());
  } catch (error) {
    return handleApiError(error, c);
  }
});
r.public("get", "/jwks", discovery, async (c) => {
  try {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await actionOidcService().jwks());
  } catch (error) {
    return handleApiError(error, c);
  }
});
r.public(
  "get",
  "/token",
  {
    reason:
      "Requires a purpose-bound job capability and rechecks running job, actor, approval, destination and id-token permission before issuing a five-minute identity.",
    rateLimit: "actions-runtime" as const,
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await actionOidcService().token(c.req.raw));
    } catch (error) {
      return handleApiError(error, c);
    }
  },
);
export const actionOidcRoutes = r.hono;
