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
import { env } from "../../config/env";

// ─── Result page (shown in popup / browser tab after connect) ────────────────

function connectResultPage(title: string, message: string, success = false): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title>
<script>
// Auto-close popup windows; the opener detects the close event.
if (window.opener) { window.close(); }
</script></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa">
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">${success ? "\u2713" : "\u26A0"}</div>
  <h2 style="margin:0 0 8px">${title}</h2>
  <p style="color:#888;margin:0 0 24px">${message}</p>
  ${success ? '<p style="color:#555;font-size:14px">You can close this window.</p>' : ""}
</div>
</body></html>`;
}

// ─── Cloud account management ────────────────────────────────────────────────

export async function disconnect(c: Context) {
  const userId = getUserId(c);
  const { disconnectCloud } = await import("../../lib/cloud-client");
  await disconnectCloud(userId);
  return c.json({ connected: false });
}

export async function status(c: Context) {
  const userId = getUserId(c);
  const { getCloudConnectionStatus } = await import("../../lib/cloud-client");
  return c.json(await getCloudConnectionStatus(userId));
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
    return c.html(connectResultPage("Missing Code", "The authentication code was not provided. Please try again."));
  }

  try {
    const { exchangeCodeWithCloud, storeCloudSession } = await import("../../lib/cloud-auth-proxy");

    const data = await exchangeCodeWithCloud(code);
    if (!data) {
      return c.html(connectResultPage("Connection Failed", "Could not verify with Openship Cloud. Please try again."));
    }

    await storeCloudSession(userId, data.sessionToken);

    return c.html(connectResultPage("Connected to Openship Cloud", "Your instance is now linked. You can close this window.", true));
  } catch {
    return c.html(connectResultPage("Connection Failed", "Something went wrong. Please try again."));
  }
}
