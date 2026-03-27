import { Hono } from "hono";
import { auth } from "../../lib/auth";
import { env } from "../../config/env";
import { setSignedCookie } from "hono/cookie";
import { internalAuth } from "../../middleware/internal-auth";

export const authRoutes = new Hono();

/** HTML page shown in the system browser after cloud auth for desktop. */
function desktopResultPage(title: string, message: string, success = false): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa">
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">${success ? "\u2713" : "\u26A0"}</div>
  <h2 style="margin:0 0 8px">${title}</h2>
  <p style="color:#888;margin:0 0 24px">${message}</p>
  ${success ? '<p style="color:#555;font-size:14px">This tab can be safely closed.</p>' : ''}
</div>
</body></html>`;
}

/**
 * Desktop-mode auth endpoints.
 *
 * Two authentication flows are supported:
 *
 * 1. Zero-auth (/desktop-login)
 *    User chose self-hosted during onboarding → auto-provision a local
 *    admin user and create a real Better Auth session with a cookie.
 *    No password, the session cookie is the only credential.
 *
 * 2. Cloud auth (/cloud-callback)
 *    User chose "Continue with Cloud" during onboarding → authenticate
 *    on app.openship.io, exchange a one-time code for a local session.
 *
 * Both flows end with a `better-auth.session_token` cookie and a
 * redirect to the dashboard. The rest of the app works the same way
 * regardless of which path was taken.
 */
if (env.DEPLOY_MODE === "desktop") {
  /**
   * GET /get-session — try real Better Auth session first, fall back
   * to auto-provisioned zero-auth session for backwards compat.
   */
  authRoutes.get("/get-session", async (c) => {
    // Try real session first (cloud-authenticated or previously created)
    try {
      const realSession = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (realSession) {
        return c.json(realSession);
      }
    } catch {
      // session lookup failed — fall through to zero-auth fallback
    }

    // Zero-auth fallback — only when authMode is "none" (self-hosted desktop).
    // Cloud-auth users must re-authenticate via Openship Cloud.
    const { getAuthMode } = await import("../../lib/auth-mode");
    const authMode = await getAuthMode();
    if (authMode !== "none") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { ensureLocalUser } = await import("../../lib/local-user");
    const user = await ensureLocalUser();
    const now = new Date().toISOString();
    return c.json({
      session: {
        id: "desktop-session",
        userId: user.id,
        token: "desktop",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
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
  });

  /**
   * GET /desktop-login — create a real Better Auth session for the
   * zero-auth local user and redirect to the dashboard.
   *
   * Called ONCE after onboarding completes (self-hosted path).
   * The BrowserWindow navigates here → gets a cookie → reaches the dashboard.
   */
  authRoutes.get("/desktop-login", async (c) => {
    // Only zero-auth mode can mint sessions without credentials
    const { getAuthMode } = await import("../../lib/auth-mode");
    const authMode = await getAuthMode();
    if (authMode !== "none") {
      return c.redirect(`${env.DASHBOARD_URL}/login`);
    }

    const { ensureLocalUser } = await import("../../lib/local-user");
    const { createLocalSession } = await import("../../lib/cloud-auth-proxy");

    const user = await ensureLocalUser();
    const session = await createLocalSession(user.id, "127.0.0.1", "desktop");

    await setSignedCookie(c, "better-auth.session_token", session.token, env.BETTER_AUTH_SECRET, {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    });

    return c.redirect(env.DASHBOARD_URL);
  });

  /**
   * GET /cloud-callback — exchange cloud auth code for a local session.
   *
   * Flow:
   *   1. User authenticates on app.openship.io (in system browser)
   *   2. Cloud generates a one-time code and redirects here with ?code=xxx&state=yyy
   *   3. We validate state (CSRF protection) and retrieve stored code_verifier (PKCE)
   *   4. We exchange the code + code_verifier for user data + cloud session token
   *   5. Mirror the cloud user locally, store cloud token, create session
   *   6. Store session token for Electron to pick up via polling
   *   7. Show a "success — close this tab" page
   */
  authRoutes.get("/cloud-callback", async (c) => {
    const code = c.req.query("code");
    if (!code) {
      return c.html(desktopResultPage("Missing authentication code", "Please return to Openship and try again."));
    }

    // Validate state parameter (CSRF) and retrieve PKCE code_verifier
    const state = c.req.query("state");
    if (!state) {
      return c.html(desktopResultPage("Missing state parameter", "Please return to Openship and try again."));
    }

    try {
      const { exchangeCodeWithCloud, mirrorCloudUser, storeCloudSession, createLocalSession, resolveDesktopAuth, validateDesktopState } =
        await import("../../lib/cloud-auth-proxy");

      const validated = validateDesktopState(state);
      if (!validated) {
        return c.html(desktopResultPage("Invalid or expired session", "The authorization request has expired. Please return to Openship and try again."));
      }

      const data = await exchangeCodeWithCloud(code, validated.codeVerifier);
      if (!data) {
        return c.html(desktopResultPage("Authentication failed", "Could not verify with Openship Cloud. Please return to Openship and try again."));
      }

      // Always mirror the cloud user for record-keeping
      const mirroredUserId = await mirrorCloudUser(data.user);

      // Store cloud session against the CURRENTLY LOGGED IN user if available
      // (cloud:connect flow), otherwise against the mirrored cloud user (onboarding flow)
      const targetUserId = validated.connectUserId || mirroredUserId;
      await storeCloudSession(targetUserId, data.sessionToken);

      const session = await createLocalSession(mirroredUserId, "127.0.0.1", "desktop");

      // Resolve the pending nonce so Electron can pick up the session via polling
      resolveDesktopAuth(validated.nonce, session.token, session.expiresAt);

      return c.html(desktopResultPage("Signed in to Openship", "You can return to the Openship app now.", true));
    } catch {
      return c.html(desktopResultPage("Authentication failed", "Something went wrong. Please return to Openship and try again."));
    }
  });

  /**
   * POST /desktop-auth-start — register a nonce + PKCE + state for desktop auth.
   * Called by the Electron main process before opening the system browser.
   *
   * Protected by internal token — prevents unauthorized registration.
   */
  authRoutes.post("/desktop-auth-start", internalAuth, async (c) => {
    const body = await c.req.json();
    const nonce = body?.nonce;
    const state = body?.state;
    const codeVerifier = body?.code_verifier;
    if (!nonce || typeof nonce !== "string" || !state || typeof state !== "string" || !codeVerifier || typeof codeVerifier !== "string") {
      return c.json({ error: "missing nonce, state, or code_verifier" }, 400);
    }

    // Try to extract the current dashboard user from the session cookie.
    // net.fetch in Electron sends cookies automatically, so if the dashboard
    // is logged in, we can link the cloud session to the right user.
    let connectUserId: string | undefined;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      connectUserId = session?.user?.id;
    } catch {
      // No session — onboarding flow, will mirror cloud user instead
    }

    const { registerDesktopNonce } = await import("../../lib/cloud-auth-proxy");
    registerDesktopNonce(nonce, state, codeVerifier, connectUserId);
    return c.json({ ok: true });
  });

  /**
   * GET /desktop-auth-poll — Electron polls this to check if cloud auth completed.
   * Returns { status: "pending" | "resolved" | "expired", claimCode? }
   */
  authRoutes.get("/desktop-auth-poll", async (c) => {
    const nonce = c.req.query("nonce");
    if (!nonce) {
      return c.json({ error: "missing nonce" }, 400);
    }
    const { pollDesktopAuth } = await import("../../lib/cloud-auth-proxy");
    return c.json(pollDesktopAuth(nonce));
  });

  /**
   * GET /desktop-claim?code=xxx — exchange a one-time claim code for a
   * session cookie. Electron navigates here after polling resolves.
   *
   * This sets the cookie via HTTP Set-Cookie (reliable across all
   * Electron versions) and then redirects to the dashboard.
   */
  authRoutes.get("/desktop-claim", async (c) => {
    const code = c.req.query("code");
    if (!code) {
      return c.text("Missing code", 400);
    }

    const { exchangeDesktopClaim } = await import("../../lib/cloud-auth-proxy");
    const result = exchangeDesktopClaim(code);
    if (!result) {
      return c.text("Claim expired", 400);
    }

    await setSignedCookie(c, "better-auth.session_token", result.token, env.BETTER_AUTH_SECRET, {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      expires: result.expiresAt,
    });

    return c.redirect(env.DASHBOARD_URL);
  });
}

/** Better Auth catch-all — handles all standard auth endpoints. */
authRoutes.on(["GET", "POST"], "/*", (c) => {
  return auth.handler(c.req.raw);
});
