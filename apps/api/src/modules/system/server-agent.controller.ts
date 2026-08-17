/**
 * Server agent enroll / status / revoke / inbound report.
 *
 * Operator/localOnly (the router is not mounted in CLOUD_MODE). Enroll and
 * revoke are session-auth. Report is HMAC-signed by the agent itself.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import { assertNotCloud } from "../../lib/controller-helpers";
import {
  enrollServerAgent,
  publicAgentStatus,
  recordAgentReport,
  revokeServerAgent,
  verifyAgentEnvelope,
} from "./server-agent";

async function loadServer(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return { error: cloudGuard };
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: id, action: "read" });
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return { error: c.json({ error: "Server not found" }, 404) };
  return { server, ctx };
}

/** GET /api/servers/:id/agent */
export async function agentStatus(c: Context) {
  const loaded = await loadServer(c);
  if ("error" in loaded) return loaded.error;
  return c.json(publicAgentStatus(loaded.server));
}

/** POST /api/servers/:id/agent/enroll */
export async function enrollAgent(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: id, action: "admin" });
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { controlPlaneUrl?: string };
  const enrolled = await enrollServerAgent(server, {
    controlPlaneUrl: body.controlPlaneUrl,
    requestOrigin: new URL(c.req.url).origin,
  });

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.agent_enrolled",
    resourceType: "server",
    resourceId: server.id,
    after: { keyId: enrolled.keyId },
  });

  return c.json(
    {
      keyId: enrolled.keyId,
      secret: enrolled.secret,
      controlPlaneUrl: enrolled.controlPlaneUrl,
      install: enrolled.install,
      agent: enrolled.agent,
    },
    201,
  );
}

/** DELETE /api/servers/:id/agent */
export async function revokeAgent(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: id, action: "admin" });
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  await revokeServerAgent(server);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.agent_revoked",
    resourceType: "server",
    resourceId: server.id,
    before: { keyId: server.agent?.keyId ?? null },
  });
  return c.json({ ok: true, enrolled: false });
}

/**
 * POST /api/servers/:id/agent/report
 *
 * Signed by the agent (no user session). Returns any pending ops as signed
 * envelopes so the agent can execute them on its next heartbeat.
 */
export async function agentReport(c: Context) {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const id = c.req.param("id")!;
  const server = await repos.server.get(id);
  if (!server?.agent?.keyId || !server.agentSecret) {
    return c.json({ error: "not_enrolled" }, 404);
  }

  const raw = await c.req.json().catch(() => null);
  const verified = verifyAgentEnvelope(server, raw);
  if (!verified.ok) {
    return c.json({ error: verified.reason }, 401);
  }
  if (verified.envelope.op !== "report" && verified.envelope.op !== "ping") {
    return c.json({ error: "expected_report" }, 400);
  }

  const ops = await recordAgentReport(server, verified.envelope);
  return c.json({ ok: true, ops });
}
