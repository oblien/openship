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

  await repos.instanceSettings.upsert({
    serverName: body.serverName || null,
    authMode: body.authMode || "none",
    sshHost: body.sshHost || null,
    sshPort: body.sshPort || 22,
    sshUser: body.sshUser || "root",
    sshAuthMethod: body.sshAuthMethod || null,
    sshPassword: body.sshPassword || null,
    sshKeyPath: body.sshKeyPath || null,
    sshKeyPassphrase: body.sshKeyPassphrase || null,
    sshJumpHost: body.sshJumpHost || null,
    sshArgs: body.sshArgs || null,
    tunnelProvider: body.tunnelProvider || null,
    tunnelToken: body.tunnelToken || null,
    defaultBuildMode: body.defaultBuildMode || "auto",
  });

  sshManager.invalidate();
  clearAuthModeCache();
  return c.json({ ok: true });
}

/** GET /system/setup — retrieve current instance settings */
export async function getSetup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const settings = await repos.instanceSettings.get();

  if (!settings) {
    return c.json({ configured: false });
  }

  return c.json({
    configured: true,
    serverName: settings.serverName,
    authMode: settings.authMode,
    sshHost: settings.sshHost,
    sshPort: settings.sshPort,
    sshUser: settings.sshUser,
    sshAuthMethod: settings.sshAuthMethod,
    sshKeyPath: settings.sshKeyPath,
    sshJumpHost: settings.sshJumpHost,
    sshArgs: settings.sshArgs,
    tunnelProvider: settings.tunnelProvider,
    defaultBuildMode: settings.defaultBuildMode,
  });
}

/** PATCH /system/settings — partial update from dashboard settings page */
export async function updateSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  // Only allow updating specific fields — never overwrite passwords
  // from the dashboard unless explicitly provided.
  const patch: Record<string, unknown> = {};

  if (body.serverName !== undefined) patch.serverName = body.serverName || null;
  if (body.authMode !== undefined) patch.authMode = body.authMode || "none";
  if (body.sshHost !== undefined) patch.sshHost = body.sshHost || null;
  if (body.sshPort !== undefined) patch.sshPort = body.sshPort || 22;
  if (body.sshUser !== undefined) patch.sshUser = body.sshUser || "root";
  if (body.sshAuthMethod !== undefined) patch.sshAuthMethod = body.sshAuthMethod || null;
  if (body.sshPassword !== undefined) patch.sshPassword = body.sshPassword || null;
  if (body.sshKeyPath !== undefined) patch.sshKeyPath = body.sshKeyPath || null;
  if (body.sshKeyPassphrase !== undefined) patch.sshKeyPassphrase = body.sshKeyPassphrase || null;
  if (body.sshJumpHost !== undefined) patch.sshJumpHost = body.sshJumpHost || null;
  if (body.sshArgs !== undefined) patch.sshArgs = body.sshArgs || null;
  if (body.tunnelProvider !== undefined) patch.tunnelProvider = body.tunnelProvider || null;
  if (body.tunnelToken !== undefined) patch.tunnelToken = body.tunnelToken || null;
  if (body.defaultBuildMode !== undefined) patch.defaultBuildMode = body.defaultBuildMode || "auto";

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await repos.instanceSettings.upsert(patch);

  sshManager.invalidate();
  clearAuthModeCache();
  return c.json({ ok: true });
}

/** DELETE /system/settings — remove server configuration */
export async function deleteSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  await repos.instanceSettings.delete();

  sshManager.invalidate();
  clearAuthModeCache();
  return c.json({ ok: true });
}
