/**
 * HTTP handlers for per-server GitHub auth (self-hosted only), mounted under
 * /api/servers/:id/github. Gating mirrors servers.controller.ts: assertNotCloud
 * + permission.assert({ resourceType: "server" }) + org-scoped existence check.
 * Secrets are never echoed — the service returns masked status.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { assertNotCloud } from "../../lib/controller-helpers";
import { safeErrorMessage } from "@repo/core";
import {
  startServerConnect,
  pollServerConnect,
  setServerToken,
  ensureServerKey,
  setDeployKeyMode,
  getServerGithubStatus,
  disconnectServerGithub,
} from "./server-github.service";

/** Resolve + authorize the server for `action`; returns the server row or a
 *  Response to short-circuit (cloud/deny/404). */
async function guardServer(
  c: Context,
  action: "read" | "write" | "admin",
): Promise<{ ctx: ReturnType<typeof getRequestContext>; id: string } | Response> {
  const cloudGuard = assertNotCloud(c);
  if (cloudGuard) return cloudGuard;
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: id, action });
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);
  return { ctx, id };
}

export async function getStatus(c: Context) {
  const g = await guardServer(c, "read");
  if (g instanceof Response) return g;
  return c.json(await getServerGithubStatus(g.id));
}

export async function startConnect(c: Context) {
  const g = await guardServer(c, "write");
  if (g instanceof Response) return g;
  try {
    const verification = await startServerConnect(g.ctx, g.id);
    return c.json({
      userCode: verification.user_code,
      verificationUri: verification.verification_uri,
      expiresIn: verification.expires_in,
      interval: verification.interval,
    });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function pollConnect(c: Context) {
  const g = await guardServer(c, "read");
  if (g instanceof Response) return g;
  return c.json({ data: pollServerConnect(g.id) });
}

export async function putToken(c: Context) {
  const g = await guardServer(c, "write");
  if (g instanceof Response) return g;
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  if (!body.token) return c.json({ error: "token is required" }, 400);
  try {
    const saved = await setServerToken(g.ctx, g.id, body.token);
    const { testServerCloneAccess } = await import("./clone-access-test");
    const cloneTest = await testServerCloneAccess({
      serverId: g.id,
      organizationId: g.ctx.organizationId,
      token: body.token,
    }).catch((err) => ({
      ok: false as const,
      via: "none" as const,
      message: err instanceof Error ? err.message : "Clone test failed",
    }));
    return c.json({ ...saved, cloneTest });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function generateSshKey(c: Context) {
  const g = await guardServer(c, "write");
  if (g instanceof Response) return g;
  try {
    return c.json(await ensureServerKey(g.ctx, g.id));
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function useDeployKeyMode(c: Context) {
  const g = await guardServer(c, "write");
  if (g instanceof Response) return g;
  await setDeployKeyMode(g.ctx, g.id);
  return c.json({ ok: true });
}

export async function disconnect(c: Context) {
  const g = await guardServer(c, "write");
  if (g instanceof Response) return g;
  await disconnectServerGithub(g.ctx, g.id);
  return c.json({ ok: true });
}
