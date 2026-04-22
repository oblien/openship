/**
 * Servers CRUD controller — manage SSH server configurations.
 *
 * Security: Gated behind localOnly + authMiddleware (no cloud, no unauthenticated).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { invalidateOpenRestyPaths } from "@/lib/openresty-paths";
import { env } from "../../config";
import { sshManager } from "../../lib/ssh-manager";

/** Guard — returns 404 in cloud mode (defense-in-depth) */
function assertNotCloud(c: Context): boolean {
  if (env.CLOUD_MODE) {
    c.status(404);
    c.body(null);
    return false;
  }
  return true;
}

/** GET /servers — list all servers */
export async function listServers(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const all = await repos.server.list();

  return c.json(
    all.map((s) => ({
      id: s.id,
      name: s.name,
      sshHost: s.sshHost,
      sshPort: s.sshPort,
      sshUser: s.sshUser,
      sshAuthMethod: s.sshAuthMethod,
      sshKeyPath: s.sshKeyPath,
      sshJumpHost: s.sshJumpHost,
      sshArgs: s.sshArgs,
      createdAt: s.createdAt,
    })),
  );
}

/** GET /servers/:id — get a single server */
export async function getServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  const server = await repos.server.get(id);
  if (!server) return c.json({ error: "Server not found" }, 404);

  return c.json({
    id: server.id,
    name: server.name,
    sshHost: server.sshHost,
    sshPort: server.sshPort,
    sshUser: server.sshUser,
    sshAuthMethod: server.sshAuthMethod,
    sshKeyPath: server.sshKeyPath,
    sshJumpHost: server.sshJumpHost,
    sshArgs: server.sshArgs,
    createdAt: server.createdAt,
  });
}

/** POST /servers — create a new server */
export async function createServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  const host = (body.sshHost as string)?.trim();
  if (!host) return c.json({ error: "SSH host is required" }, 400);

  const server = await repos.server.create({
    name: body.name?.trim() || null,
    sshHost: host,
    sshPort: body.sshPort ?? 22,
    sshUser: body.sshUser?.trim() || "root",
    sshAuthMethod: body.sshAuthMethod || null,
    sshPassword: body.sshPassword || null,
    sshKeyPath: body.sshKeyPath || null,
    sshKeyPassphrase: body.sshKeyPassphrase || null,
    sshJumpHost: body.sshJumpHost?.trim() || null,
    sshArgs: body.sshArgs?.trim() || null,
  });

  sshManager.invalidate(server.id);
  invalidateOpenRestyPaths(server.id);

  return c.json({
    id: server.id,
    name: server.name,
    sshHost: server.sshHost,
    sshPort: server.sshPort,
    sshUser: server.sshUser,
    sshAuthMethod: server.sshAuthMethod,
  }, 201);
}

/** PATCH /servers/:id — update a server */
export async function updateServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  const existing = await repos.server.get(id);
  if (!existing) return c.json({ error: "Server not found" }, 404);

  const body = await c.req.json();
  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) patch.name = body.name?.trim() || null;
  if (body.sshHost !== undefined) patch.sshHost = body.sshHost?.trim() || existing.sshHost;
  if (body.sshPort !== undefined) patch.sshPort = body.sshPort ?? 22;
  if (body.sshUser !== undefined) patch.sshUser = body.sshUser?.trim() || "root";
  if (body.sshAuthMethod !== undefined) patch.sshAuthMethod = body.sshAuthMethod || null;
  if (body.sshPassword !== undefined) patch.sshPassword = body.sshPassword || null;
  if (body.sshKeyPath !== undefined) patch.sshKeyPath = body.sshKeyPath || null;
  if (body.sshKeyPassphrase !== undefined) patch.sshKeyPassphrase = body.sshKeyPassphrase || null;
  if (body.sshJumpHost !== undefined) patch.sshJumpHost = body.sshJumpHost?.trim() || null;
  if (body.sshArgs !== undefined) patch.sshArgs = body.sshArgs?.trim() || null;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const updated = await repos.server.update(id, patch);
  sshManager.invalidate(id);
  invalidateOpenRestyPaths(id);

  return c.json({
    id: updated.id,
    name: updated.name,
    sshHost: updated.sshHost,
    sshPort: updated.sshPort,
    sshUser: updated.sshUser,
    sshAuthMethod: updated.sshAuthMethod,
  });
}

/** DELETE /servers/:id — delete a server */
export async function deleteServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  const existing = await repos.server.get(id);
  if (!existing) return c.json({ error: "Server not found" }, 404);

  await repos.server.delete(id);
  sshManager.invalidate(id);
  invalidateOpenRestyPaths(id);

  return c.json({ ok: true });
}
