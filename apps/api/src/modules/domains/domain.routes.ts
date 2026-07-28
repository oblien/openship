/**
 * Domain routes - mounted at /api/domains in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter.
 */

import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { secureRouter } from "../../lib/secure-router";
import { cloudDomainProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./domain.controller";
import { AddDomainBody, UploadCertBody } from "./domain.schema";

const r = secureRouter(new Hono(), {
  module: "domains",
  basePath: "/api/domains",
});


/* ─── Domains ──────────────────────────────────────────────────────────── */
r.get("/", { tag: "domain:list", mcp: { description: "List domains for the org / project." } }, ctrl.list);
r.post(
  "/",
  { tag: "domain:write", mcp: { description: "Add a domain (free subdomain or custom).", body: AddDomainBody } },
  tbValidator("json", AddDomainBody),
  ctrl.add,
);
// Side-effect-free DNS probe — POST is used to carry hostname in body.
// readOnly opts out of the scanner's "POST must be write/admin" rule.
r.post("/preview", { tag: "domain:read", readOnly: true, mcp: { description: "Preview the DNS records a domain will need, before adding it." } }, ctrl.preview);
// Per-domain routes carry cloudDomainProxy (after the permission middleware):
// a domain belonging to a cloud project is proxied to the SaaS; a local domain
// falls through to the local handler.
r.delete("/:id", { tag: "domain:admin" }, cloudDomainProxy, ctrl.remove);
r.post("/:id/verify", { tag: "domain:write", mcp: { description: "Verify a domain's ownership / DNS." } }, cloudDomainProxy, ctrl.verify);
// Self-hosted live-log verify (SSE): streams certbot's standalone HTTP-01 run.
r.post("/:id/verify/stream", { tag: "domain:write" }, ctrl.verifyStream);
r.post("/:id/primary", { tag: "domain:write", mcp: { description: "Set this domain as the project's primary domain." } }, cloudDomainProxy, ctrl.setPrimary);
r.get("/:id/records", { tag: "domain:read", mcp: { description: "Get the DNS records for a domain." } }, cloudDomainProxy, ctrl.records);
r.post("/:id/renew", { tag: "domain:write", mcp: { description: "Renew the domain's SSL certificate." } }, cloudDomainProxy, ctrl.renewSsl);
r.post("/:id/verify-ssl", { tag: "domain:write", mcp: { description: "Check/verify the domain's SSL certificate." } }, cloudDomainProxy, ctrl.verifySsl);
// Self-hosted only: installs a cert into the box's OpenResty. On Openship Cloud
// TLS is owned by the managed edge, so this 404s in CLOUD_MODE (localOnly gate).
r.post(
  "/:id/certificate",
  { tag: "domain:write", localOnly: true, mcp: { description: "Install an operator-supplied TLS certificate (bring-your-own / Cloudflare Origin CA).", body: UploadCertBody } },
  tbValidator("json", UploadCertBody),
  cloudDomainProxy,
  ctrl.uploadCert,
);
r.post("/renew-all", { tag: "domain:write" }, ctrl.renewAllSsl);
r.post("/verify-pending", { tag: "domain:write" }, ctrl.verifyPending);

export const domainRoutes = r.hono;
