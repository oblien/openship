/**
 * Credential routes.
 *
 * Gated on `settings:*`, matching the DNS credential routes this replaces: a credential is
 * one org-wide infrastructure record, read and written from the Settings page. A
 * resource-scoped root would be wrong — one registry login is not scoped to one project or
 * one domain.
 *
 * The tag is a TOKEN scope, not an org role, so a session user carries whatever their
 * membership allows. Every write therefore also takes `requireRole("admin")`: without it
 * any member could delete the org's registry login and silently break every deploy that
 * pulls a private image. Attached per-route rather than through `r.use("*")`, which would
 * run before auth and read an empty context.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { requireRole } from "../../middleware";
import * as ctrl from "./credential.controller";
import { CreateCredentialBody, UpdateCredentialBody } from "./credential.schema";

const r = secureRouter(new Hono(), {
  module: "credentials",
  basePath: "/api/credentials",
});

r.get(
  "/providers",
  {
    tag: "settings:read",
    mcp: { description: "List the credential providers this instance supports, with the fields each needs." },
  },
  ctrl.listProviders,
);
r.get(
  "/",
  { tag: "settings:read", mcp: { description: "List the organization's stored credentials. Secrets are masked." } },
  ctrl.listCredentials,
);
r.get(
  "/:id",
  { tag: "settings:read", mcp: { description: "Get one stored credential. The secret is masked." } },
  ctrl.getCredential,
);
r.post(
  "/",
  {
    tag: "settings:admin",
    body: CreateCredentialBody,
    mcp: { description: "Store a credential for a third-party provider (registry login, DNS token)." },
  },
  requireRole("admin"),
  ctrl.createCredential,
);
r.patch(
  "/:id",
  {
    tag: "settings:admin",
    body: UpdateCredentialBody,
    mcp: { description: "Rename, re-scope or rotate a stored credential." },
  },
  requireRole("admin"),
  ctrl.updateCredential,
);
r.delete(
  "/:id",
  { tag: "settings:admin", mcp: { description: "Delete a stored credential." } },
  requireRole("admin"),
  ctrl.deleteCredential,
);
r.post(
  // A write, not a read: it records the verdict, which is what makes a credential revoked
  // upstream visible instead of silently failing every consumer.
  "/:id/verify",
  { tag: "settings:admin", mcp: { description: "Re-check a stored credential with its provider and record the result." } },
  requireRole("admin"),
  ctrl.verifyCredential,
);

export const credentialRoutes = r.hono;
