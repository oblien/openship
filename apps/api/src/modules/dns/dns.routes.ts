/**
 * DNS provider routes.
 *
 * Gated on `settings:*` — a DNS credential is one org-wide infrastructure record,
 * the same shape as the edge and email settings next to it, and it is read and
 * written from the Settings page. `domain:*` is the wrong root: those tags are
 * per-domain-resource (`domain:read` on `/domains/:id`), and one token is not
 * scoped to one domain.
 *
 * The tag is a TOKEN scope, not an org role — a session user carries whatever
 * their membership allows, so the two writes also take `requireRole("admin")`,
 * matching the sidebar's `requiresRole: "admin"` on this tab. Without it any
 * member could delete the org-wide credential and silently revert every later
 * domain add to manual records. Attached per-route rather than via `r.use("*")`,
 * which would run before auth and read an empty context (see
 * permissions.routes.ts for the same note).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { requireRole } from "../../middleware";
import * as ctrl from "./dns.controller";
import { AddDnsCredentialBody, VerifyZoneBody } from "./dns.schema";

const r = secureRouter(new Hono(), {
  module: "dns",
  basePath: "/api/dns",
});

r.get(
  "/providers",
  { tag: "settings:read", mcp: { description: "List supported DNS providers and the token scopes they need." } },
  ctrl.listProviders,
);
r.get(
  "/credentials",
  { tag: "settings:read", mcp: { description: "List connected DNS provider credentials for the org." } },
  ctrl.listCredentials,
);
r.get(
  "/credentials/:id",
  { tag: "settings:read", mcp: { description: "Get one connected DNS provider credential." } },
  ctrl.getCredential,
);
r.get(
  "/credentials/:id/zones",
  { tag: "settings:read", mcp: { description: "List DNS zones available for this credential." } },
  ctrl.listZones,
);
r.post(
  "/credentials",
  {
    tag: "settings:admin",
    body: AddDnsCredentialBody,
    mcp: { description: "Connect a DNS provider credential (Cloudflare API token)." },
  },
  requireRole("admin"),
  ctrl.addCredential,
);
r.delete(
  "/credentials/:id",
  { tag: "settings:admin", mcp: { description: "Disconnect a DNS provider credential." } },
  requireRole("admin"),
  ctrl.removeCredential,
);
r.post(
  // POST to carry a hostname body, but genuinely side-effect free — see the
  // handler's note on why the credential-invalidating write moved out.
  "/verify-zone",
  {
    tag: "settings:read",
    readOnly: true,
    body: VerifyZoneBody,
    mcp: { description: "Check whether a connected DNS provider manages a hostname's zone." },
  },
  ctrl.verifyZone,
);

export const dnsRoutes = r.hono;
