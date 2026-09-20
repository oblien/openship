/**
 * Personal Access Token routes — mounted at /api/tokens in app.ts.
 * Self-scoped: every handler operates on the caller's own tokens (ctx.userId).
 * Gated behind settings read/write so any org member can manage their tokens.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./token.controller";
import { CreateTokenBody, AuthorizeMcpClientBody } from "@repo/contracts";

const r = secureRouter(new Hono(), {
  module: "tokens",
  basePath: "/api/tokens",
});

r.get("/", { tag: "settings:read" }, ctrl.list);
r.post("/", { tag: "settings:write", auditHandledByOperation: true, body: CreateTokenBody }, ctrl.create);
r.delete("/:id", { tag: "settings:write", auditHandledByOperation: true }, ctrl.revoke);
r.post("/mcp-authorize", { tag: "settings:write", auditHandledByOperation: true, body: AuthorizeMcpClientBody }, ctrl.authorizeMcpClient);
// Connected MCP clients (OAuth bindings) — list + disconnect (revoke).
r.get("/mcp-clients", { tag: "settings:read" }, ctrl.listMcpClients);
// The detail route carries the binding's GRANTS, which the settings editor needs to
// prefill — `mcp-authorize` replaces them wholesale, so editing without them would
// overwrite the user's scope with whatever the form defaulted to.
r.get("/mcp-clients/:clientId", { tag: "settings:read" }, ctrl.getMcpClient);
r.delete("/mcp-clients/:clientId", { tag: "settings:write", auditHandledByOperation: true }, ctrl.disconnectMcpClient);

export const tokenRoutes = r.hono;
