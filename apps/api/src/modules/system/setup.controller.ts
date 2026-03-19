/**
 * Setup controller — Electron → API direct push of instance config.
 *
 * Called once after onboarding with the internal token.
 * Persists SSH credentials, tunnel config, and default build mode
 * as instance-level settings (not per-user).
 *
 * Security: These handlers are loaded via dynamic import only in
 * self-hosted mode. Additionally, each handler checks CLOUD_MODE as
 * defense-in-depth — if somehow mounted in cloud, they refuse to run.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { env } from "../../config";
import { clearAuthModeCache } from "../../lib/auth-mode";
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

/** POST /system/setup — push all instance settings from desktop app */
export async function setup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  // Instance-level config (non-SSH) → instance_settings table
  await repos.instanceSettings.upsert({
    authMode: body.authMode || "none",
    tunnelProvider: body.tunnelProvider || null,
    tunnelToken: body.tunnelToken || null,
    defaultBuildMode: body.defaultBuildMode || "auto",
  });

  // SSH server config → servers table (single source of truth)
  let serverId: string | undefined;
  if (body.sshHost) {
    // If caller specifies serverId, update that server; otherwise fall back to
    // the first existing server (desktop onboarding always has at most one).
    const existing = body.serverId
      ? await repos.server.get(body.serverId)
      : (await repos.server.list())[0] ?? null;

    if (existing) {
      await repos.server.update(existing.id, {
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: body.sshPassword || null,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: body.sshKeyPassphrase || null,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = existing.id;
    } else {
      const created = await repos.server.create({
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: body.sshPassword || null,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: body.sshKeyPassphrase || null,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = created.id;
    }
    sshManager.invalidate(serverId);
  }

  clearAuthModeCache();
  return c.json({ ok: true });
}

/** GET /system/setup — retrieve current instance settings */
export async function getSetup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const settings = await repos.instanceSettings.get();
  const servers = await repos.server.list();
  const hasServer = servers.length > 0;

  return c.json({
    configured: hasServer,
    authMode: settings?.authMode ?? "none",
    tunnelProvider: settings?.tunnelProvider ?? null,
    defaultBuildMode: settings?.defaultBuildMode ?? "auto",
  });
}

/** PATCH /system/settings — partial update instance-level settings (non-SSH) */
export async function updateSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  // Only instance-level fields — SSH changes go through the servers API.
  const patch: Record<string, unknown> = {};

  if (body.authMode !== undefined) patch.authMode = body.authMode || "none";
  if (body.tunnelProvider !== undefined) patch.tunnelProvider = body.tunnelProvider || null;
  if (body.tunnelToken !== undefined) patch.tunnelToken = body.tunnelToken || null;
  if (body.defaultBuildMode !== undefined) patch.defaultBuildMode = body.defaultBuildMode || "auto";

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await repos.instanceSettings.upsert(patch);

  clearAuthModeCache();
  return c.json({ ok: true });
}

/** DELETE /system/settings — remove server configuration */
export async function deleteSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  await repos.instanceSettings.delete();

  // Also clear all servers since SSH config lives in the servers table
  const serverList = await repos.server.list();
  for (const s of serverList) {
    await repos.server.delete(s.id);
  }

  sshManager.invalidate();
  clearAuthModeCache();
  return c.json({ ok: true });
}
