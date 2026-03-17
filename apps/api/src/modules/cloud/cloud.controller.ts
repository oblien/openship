/**
 * Cloud controller — two sides of the same coin:
 *
 * SaaS (CLOUD_MODE):
 *   POST /api/cloud/token           — mint namespace-scoped Oblien tokens
 *   GET  /api/cloud/desktop-handoff — OAuth → one-time code → redirect to desktop
 *   POST /api/cloud/exchange-code   — exchange code for user + session (no auth)
 *
 * Local (!CLOUD_MODE):
 *   POST /api/cloud/disconnect      — clear stored session
 *   GET  /api/cloud/status          — check connection state
 *   GET  /api/cloud/connect-callback — exchange code from external auth
 */

import type { Context } from "hono";
import { getUserId } from "../../lib/controller-helpers";

// ─── SaaS: namespace token minting ───────────────────────────────────────────

export async function getToken(c: Context) {
  const { issueNamespaceToken } = await import("../../lib/openship-cloud");
  const userId = getUserId(c);
  const result = await issueNamespaceToken(userId);
  return c.json({ data: result });
}

// ─── SaaS: desktop OAuth handoff ─────────────────────────────────────────────

/**
 * GET /api/cloud/desktop-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Called from the authorize page after the user clicks "Authorize".
 * Reads the authenticated session, generates a one-time code, and
 * redirects to the desktop's local callback with that code + state.
 *
 * Security:
 *   - redirect MUST be localhost (desktop callback) — no open redirect
 *   - state is passed through unchanged for CSRF protection
 *   - code_challenge (PKCE S256) is bound to the one-time code
 */
export async function desktopHandoff(c: Context) {
  const { auth } = await import("../../lib/auth");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  // Security: only allow localhost — desktop is the only consumer
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return c.json({ error: "Redirect must target localhost" }, 400);
  }
  // Restrict to safe port range — prevent redirect to unrelated local services
  const port = parseInt(url.port || "80", 10);
  if (port < 1024 || port > 65535) {
    return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
  }

  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");

  const { generateHandoffCode } = await import("../../lib/cloud-auth-proxy");
  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
    codeChallenge || undefined,
  );

  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

/**
 * GET /api/cloud/connect-handoff?redirect=<url>
 *
 * Used by self-hosted "Connect to Cloud" flow. After the user logs in
 * on the SaaS, the login page redirects here. This generates a one-time
 * code and redirects back to the self-hosted callback.
 *
 * Security:
 *   - redirect MUST be HTTPS (no downgrade to HTTP)
 *   - No PKCE (self-hosted server handles its own security)
 *   - Codes are single-use with 60s TTL
 */
export async function connectHandoff(c: Context) {
  const { auth } = await import("../../lib/auth");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  // Allow localhost HTTP (desktop connects via http://localhost:PORT)
  // and require HTTPS for all other hosts (self-hosted production)
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalhost && url.protocol !== "https:") {
    return c.json({ error: "Redirect must use HTTPS" }, 400);
  }
  if (isLocalhost) {
    const port = parseInt(url.port || "80", 10);
    if (port < 1024 || port > 65535) {
      return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
    }
  }

  const { generateHandoffCode } = await import("../../lib/cloud-auth-proxy");
  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
  );

  url.searchParams.set("code", code);
  return c.redirect(url.toString());
}

/**
 * POST /api/cloud/exchange-code  { code: string, code_verifier?: string }
 *
 * Called by the desktop instance to exchange a one-time code for the OAuth
 * user data + cloud session token. No auth required — the code is the credential.
 *
 * If the code was generated with a PKCE code_challenge, the matching
 * code_verifier must be provided or the exchange is rejected.
 */
export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code: string; code_verifier?: string }>();
  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const { exchangeHandoffCode } = await import("../../lib/cloud-auth-proxy");
  const result = exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  return c.json({ data: result });
}

// ─── Local: cloud account management ─────────────────────────────────────────

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

  // Return cloud user info alongside status
  const user = c.get("user");
  return c.json({
    connected: true,
    user: user ? { name: user.name, email: user.email, image: user.image } : undefined,
  });
}

/**
 * GET /api/cloud/connect-callback?code=<one-time-code>
 *
 * Used by self-hosted settings page. After the user authenticates on
 * Openship Cloud, they're redirected here with a code.
 * We exchange it for the cloud session token and store it for deploys.
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
