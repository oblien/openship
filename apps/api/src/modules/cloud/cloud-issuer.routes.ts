import { Hono } from "hono";
import { rateLimiter } from "../../middleware/rate-limiter";
import { secureRouter } from "../../lib/secure-router";
import * as issuer from "./cloud-issuer.controller";

/**
 * Desktop-link issuer for a self-hosted control plane.
 *
 * Not `localOnly`: the browser and the desktop's API call these from
 * outside the box. Billing and the rest of CLOUD_MODE stay unmounted.
 */
export const cloudIssuerRoutes = new Hono();
const r = secureRouter(cloudIssuerRoutes, {
  module: "cloud-issuer",
  basePath: "/api/cloud",
  mcpExcluded: "Internal Cloud relay or browser credential handoff. Use the authenticated project, domain, GitHub, analytics and Cloud status tools instead.",
});

r.public(
  "get",
  "/desktop-handoff",
  { reason: "Desktop handoff redirect. The one-time code is the credential." },
  issuer.desktopHandoff,
);

r.use("/exchange-code", rateLimiter);
r.public(
  "post",
  "/exchange-code",
  { reason: "OAuth code exchange. Validated by the single-use code, not a session." },
  issuer.exchangeCode,
);

r.public(
  "get",
  "/account",
  { reason: "Bearer session identity for a linked desktop. No cookie." },
  issuer.account,
);
