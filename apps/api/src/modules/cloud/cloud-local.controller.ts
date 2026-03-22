/**
 * Cloud local controller — runs only when !CLOUD_MODE.
 *
 * Dynamic imports for security isolation: cloud-client and cloud-auth-proxy
 * are never loaded on the SaaS. This prevents self-hosted code paths
 * (which handle user credentials, SSH config, etc.) from being accessible
 * in the SaaS process.
 *
 *   POST /api/cloud/disconnect      — clear stored session
 *   GET  /api/cloud/status          — check connection state
 *   GET  /api/cloud/connect-callback — exchange code from external auth
 */

import type { Context } from "hono";
import { getUserId } from "../../lib/controller-helpers";

// ─── Cloud account management ────────────────────────────────────────────────

export async function disconnect(c: Context) {
  const userId = getUserId(c);
  const { disconnectCloud } = await import("../../lib/cloud-client");
  await disconnectCloud(userId);
  return c.json({ connected: false });
}

export async function status(c: Context) {
  const userId = getUserId(c);
  const { isCloudConnected } = await import("../../lib/cloud-client");
  const connected = await isCloudConnected(userId);
  if (!connected) return c.json({ connected: false });

  const user = c.get("user");
  return c.json({
    connected: true,
    user: user ? { name: user.name, email: user.email, image: user.image } : undefined,
  });
}

/**
 * GET /api/cloud/connect-callback?code=<one-time-code>
 *
 * After the user authenticates on Openship Cloud, they're redirected
 * here with a one-time code. We exchange it and store the cloud token.
 */
export async function connectCallback(c: Context) {
  const userId = getUserId(c);
  const code = c.req.query("code");
  if (!code) {
    return c.redirect("/settings?error=missing_code");
  }

  try {
    const { exchangeCodeWithCloud, storeCloudSession } = await import("../../lib/cloud-auth-proxy");

    const data = await exchangeCodeWithCloud(code);
    if (!data) {
      return c.redirect("/settings?error=exchange_failed");
    }

    await storeCloudSession(userId, data.sessionToken);

    return c.redirect("/settings?cloud=connected");
  } catch {
    return c.redirect("/settings?error=connect_failed");
  }
}
