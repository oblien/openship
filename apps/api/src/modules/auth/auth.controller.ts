/**
 * Auth controller — desktop-mode session bootstrap + cloud handoff.
 *
 * Two authentication flows are supported, both end with a
 * `better-auth.session_token` cookie:
 *
 *   1. **Zero-auth** (/desktop-login)
 *      User chose self-hosted during onboarding → we auto-provision a
 *      local admin user and create a real Better Auth session. No
 *      password; the session cookie IS the credential.
 *
 *   2. **Cloud auth** (/cloud-callback)
 *      User chose "Continue with Cloud" → authenticates on
 *      app.openship.io, exchanges a one-time code for a local session.
 *      Desktop flow uses PKCE + nonce for end-to-end binding.
 *
 * The rest of the app treats both flows identically (one session
 * cookie + active org), so middleware downstream doesn't branch.
 *
 * Dynamic imports here are intentional: `cloud-auth-proxy`,
 * `local-user`, and `auth-mode` are loaded ONLY in desktop mode so
 * they don't end up in self-hosted Docker / SaaS bundles. They also
 * break a circular-init that would otherwise touch the DB at module
 * load before drizzle migrations have run.
 */

import type { Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { alignLoopbackOrigin } from "@repo/core";
import { auth, COOKIE_PREFIX } from "../../lib/auth";
import { env, localDashboardUrl } from "../../config/env";

/**
 * Resolve the dashboard redirect target for THIS request. The session cookie
 * we set is host-only (bound to whichever loopback host the request actually
 * hit — 127.0.0.1 vs localhost), so redirecting to a fixed
 * `localDashboardUrl` breaks the round trip whenever that fixed host differs
 * from the request's. Align the two when both are loopback; a non-loopback
 * request host (or a missing Host header) falls back to the configured URL.
 */
function resolveDashboardRedirect(c: Context): string {
  const host = c.req.header("host");
  if (!host) return localDashboardUrl;
  try {
    return alignLoopbackOrigin(localDashboardUrl, new URL(`http://${host}`).hostname);
  } catch {
    return localDashboardUrl;
  }
}

// ─── HTML result page ────────────────────────────────────────────────────────

/** Minimal status page shown in the system browser after cloud auth. */
function desktopResultPage(title: string, message: string, success = false): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa">
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">${success ? "✓" : "⚠"}</div>
  <h2 style="margin:0 0 8px">${title}</h2>
  <p style="color:#888;margin:0 0 24px">${message}</p>
  ${success ? '<p style="color:#555;font-size:14px">This tab can be safely closed.</p>' : ''}
</div>
</body></html>`;
}

/**
 * Stamp the response with a signed Better Auth session cookie. Shared
 * by every successful auth path so cookie attributes (httpOnly, Lax,
 * /, expiry) stay consistent — drift between paths would cause subtle
 * "logged in but redirected to /login" bugs.
 */
async function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await setSignedCookie(
    c,
    `${COOKIE_PREFIX}.session_token`,
    token,
    env.BETTER_AUTH_SECRET,
    {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      expires: expiresAt,
    },
  );
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /api/auth/get-session
 *
 * Try a real Better Auth session first. On miss in zero-auth desktop
 * mode, bootstrap a fresh session inline so the dashboard's cookie
 * check passes on the very first navigation — otherwise dashboard's
 * proxy.ts → /login redirect would loop while we know we'd happily
 * authenticate the next request.
 */
export async function getSession(c: Context) {
  try {
    const realSession = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (realSession) {
      // activeOrganizationId is NOT NULL at the schema level — set by
      // the session.create.before hook in lib/auth.ts and by the
      // local-cookie mintSession path's explicit insert. No reactive
      // backfill needed; the migration handled any legacy rows.
      return c.json(realSession);
    }
  } catch {
    // session lookup failed — fall through to zero-auth bootstrap below
  }

  const { getAuthMode } = await import("../../lib/auth-mode");
  const authMode = await getAuthMode();
  if (authMode !== "none") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { ensureLocalUser } = await import("../../lib/local-user");
  const { mintSession } = await import("../../lib/cloud-auth-proxy");
  const user = await ensureLocalUser();
  const session = await mintSession({
    purpose: "local-cookie",
    userId: user.id,
    ipAddress: "127.0.0.1",
    userAgent: "desktop",
  });

  await setSessionCookie(c, session.token, session.expiresAt);

  const now = new Date().toISOString();
  return c.json({
    session: {
      id: session.id,
      userId: user.id,
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      ...user,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/**
 * GET /api/auth/desktop-login
 *
 * Create a Better Auth session for the zero-auth local user and
 * redirect to the dashboard. Called ONCE after self-hosted
 * onboarding completes — the BrowserWindow navigates here, picks up
 * the cookie, and reaches the dashboard.
 */
export async function desktopLogin(c: Context) {
  const dashboardUrl = resolveDashboardRedirect(c);

  const { getAuthMode } = await import("../../lib/auth-mode");
  const authMode = await getAuthMode();
  if (authMode !== "none") {
    return c.redirect(`${dashboardUrl}/login`);
  }

  const { ensureLocalUser } = await import("../../lib/local-user");
  const { mintSession } = await import("../../lib/cloud-auth-proxy");

  const user = await ensureLocalUser();
  const session = await mintSession({
    purpose: "local-cookie",
    userId: user.id,
    ipAddress: "127.0.0.1",
    userAgent: "desktop",
  });
  await setSessionCookie(c, session.token, session.expiresAt);

  return c.redirect(dashboardUrl);
}

/**
 * GET /api/auth/cloud-callback
 *
 * Exchange a cloud auth code for a local session. Three sub-flows:
 *   1. No `state` → compatibility browser flow (just the code).
 *   2. With `state` → desktop PKCE flow. Validates state + exchanges
 *      code with the PKCE verifier; resolves the Electron polling
 *      nonce so the desktop app can pick up the session.
 *   3. Cloud:connect flow — when already logged in, links the cloud
 *      session to the CURRENTLY logged-in user (preserves identity
 *      instead of mirroring as a new user).
 */
export async function cloudCallback(c: Context) {
  const code = c.req.query("code");
  if (!code) {
    return c.html(desktopResultPage("Missing authentication code", "Please return to Openship and try again."));
  }

  const state = c.req.query("state");

  try {
    const {
      exchangeCodeWithCloud,
      mirrorCloudUser,
      storeCloudSession,
      mintSession,
      resolveDesktopAuth,
      validateDesktopState,
      failDesktopAuth,
    } = await import("../../lib/cloud-auth-proxy");

    if (!state) {
      const data = await exchangeCodeWithCloud(code);
      if (!data) {
        return c.html(desktopResultPage("Authentication failed", "Could not verify with Openship Cloud. Please return to Openship and try again."));
      }

      const mirroredUserId = await mirrorCloudUser(data.user);
      await storeCloudSession(mirroredUserId, data.sessionToken);

      const session = await mintSession({
        purpose: "local-cookie",
        userId: mirroredUserId,
        ipAddress: "127.0.0.1",
        userAgent: "desktop",
      });
      await setSessionCookie(c, session.token, session.expiresAt);

      return c.redirect(localDashboardUrl);
    }

    const validated = validateDesktopState(state);
    if (!validated) {
      return c.html(desktopResultPage("Invalid or expired session", "The authorization request has expired. Please return to Openship and try again."));
    }

    const data = await exchangeCodeWithCloud(code, validated.codeVerifier);
    if (!data) {
      failDesktopAuth(validated.nonce);
      return c.html(desktopResultPage("Authentication failed", "Could not verify with Openship Cloud. Please return to Openship and try again."));
    }

    // Always mirror the cloud user for record-keeping
    const mirroredUserId = await mirrorCloudUser(data.user);

    // Cloud:connect flow — link to the CURRENTLY logged-in user when
    // present; otherwise store against the mirrored cloud user.
    const targetUserId = validated.connectUserId || mirroredUserId;
    await storeCloudSession(targetUserId, data.sessionToken);

    const session = await mintSession({
      purpose: "local-cookie",
      userId: mirroredUserId,
      ipAddress: "127.0.0.1",
      userAgent: "desktop",
    });

    // Resolve the pending nonce so Electron's polling loop can pick
    // up the session via /desktop-auth-poll.
    resolveDesktopAuth(validated.nonce, session.token, session.expiresAt);

    return c.html(desktopResultPage("Signed in to Openship", "You can return to the Openship app now.", true));
  } catch (err) {
    // Signal failure to the polling loop so Electron doesn't hang
    try {
      const { failDesktopAuth, getActiveNonce } = await import("../../lib/cloud-auth-proxy");
      const nonce = getActiveNonce();
      if (nonce) failDesktopAuth(nonce);
    } catch {
      // best-effort
    }
    console.error("[cloud-callback] error:", err);
    return c.html(desktopResultPage("Authentication failed", "Something went wrong. Please return to Openship and try again."));
  }
}

/**
 * POST /api/auth/desktop-auth-start
 *
 * Register a (nonce, state, PKCE verifier) tuple before the Electron
 * main process opens the system browser. Protected by internalAuth
 * shared token — only the Electron host should be able to register a
 * desktop auth nonce.
 *
 * Net.fetch in Electron sends cookies automatically; if the dashboard
 * is logged in, the current user is linked to the resulting cloud
 * session (cloud:connect flow). Otherwise this is onboarding and the
 * mirrored cloud user becomes the local user.
 */
export async function desktopAuthStart(c: Context) {
  const body = await c.req.json();
  const nonce = body?.nonce;
  const state = body?.state;
  const codeVerifier = body?.code_verifier;
  if (
    !nonce || typeof nonce !== "string" ||
    !state || typeof state !== "string" ||
    !codeVerifier || typeof codeVerifier !== "string"
  ) {
    return c.json({ error: "missing nonce, state, or code_verifier" }, 400);
  }

  let connectUserId: string | undefined;
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    connectUserId = session?.user?.id;
  } catch {
    // No session — onboarding flow; mirror cloud user instead.
  }

  const { registerDesktopNonce } = await import("../../lib/cloud-auth-proxy");
  registerDesktopNonce(nonce, state, codeVerifier, connectUserId);
  return c.json({ ok: true });
}

/**
 * GET /api/auth/desktop-auth-poll?nonce=...
 *
 * Electron polls this until status === "resolved". On resolve, it
 * navigates the BrowserWindow to /desktop-claim?code=... which sets
 * the cookie + redirects to the dashboard.
 */
export async function desktopAuthPoll(c: Context) {
  const nonce = c.req.query("nonce");
  if (!nonce) {
    return c.json({ error: "missing nonce" }, 400);
  }
  const { pollDesktopAuth } = await import("../../lib/cloud-auth-proxy");
  return c.json(pollDesktopAuth(nonce));
}

/**
 * GET /api/auth/desktop-claim?code=...
 *
 * Exchange a one-time claim code for a session cookie. Set-Cookie via
 * HTTP header is reliable across all Electron versions where
 * cookie-via-API has had quirks.
 */
export async function desktopClaim(c: Context) {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code", 400);
  }

  const { exchangeDesktopClaim } = await import("../../lib/cloud-auth-proxy");
  const result = exchangeDesktopClaim(code);
  if (!result) {
    return c.text("Claim expired", 400);
  }

  await setSessionCookie(c, result.token, result.expiresAt);
  return c.redirect(localDashboardUrl);
}
