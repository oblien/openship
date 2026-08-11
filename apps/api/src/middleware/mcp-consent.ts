import type { Context, Next } from "hono";
import { auth } from "../lib/auth";

/**
 * Gate the MCP OAuth authorize flow: (1) force it through our consent page, and
 * (2) on desktop zero-auth, establish the loopback session so it reaches consent
 * instead of a dead login page.
 *
 * (1) better-auth's mcp() plugin only redirects `/mcp/authorize` to the
 * configured `consentPage` when `prompt === "consent"` EXACTLY; otherwise it
 * mints a code immediately and consent never runs. Our consent page
 * (`dashboard/mcp/authorize` → POST /api/tokens/mcp-authorize) is the ONLY writer
 * of the OAuth binding (org + scope) that `tryOAuthMcpAuth` requires — a token
 * minted on the bypass path has no binding and is denied everything. Standard
 * MCP clients (Claude, Cursor) don't send `prompt=consent`, so we inject it.
 *
 * (2) An external MCP client's authorize request carries NO session, so
 * better-auth would redirect to the login page — unreachable on the desktop's
 * dynamic dashboard port (#119). When `zeroAuthAllowed` passes (desktop +
 * authMode=none + loopback TCP peer — the existing zero-auth trust boundary) and
 * there's no session yet, mint the SAME loopback session desktop-login does and
 * set the cookie on the redirect. The browser the client opens replays with the
 * cookie → better-auth sees a session → CONSENT runs (it still gates the actual
 * org+scope grant; we only skip the impossible login step). Loop-safe: once the
 * cookie exists, `getSession` is non-null and the mint branch is skipped.
 *
 * Must be mounted BEFORE the /api/auth catch-all.
 */
export async function forceMcpConsent(c: Context, next: Next): Promise<Response | void> {
  const url = new URL(c.req.url);

  // (2) Desktop zero-auth: no session on this authorize request → mint one so we
  // land on consent, not login. Only when a session doesn't already exist.
  const existing = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!existing) {
    const { zeroAuthAllowed } = await import("./zero-auth-guard");
    const gate = await zeroAuthAllowed(c);
    if (gate.ok) {
      const { ensureLocalUser } = await import("../lib/local-user");
      const { mintSession } = await import("../lib/cloud-auth-proxy");
      const { setSessionCookie } = await import("../lib/session-cookie");
      const user = await ensureLocalUser();
      const session = await mintSession({
        purpose: "local-cookie",
        userId: user.id,
        ipAddress: "127.0.0.1",
        userAgent: "mcp-authorize",
      });
      await setSessionCookie(c, session.token, session.expiresAt);
      // Redirect to self so the just-set cookie rides the replay (better-auth
      // reads the session from the REQUEST, not this response). Force consent on
      // the way so the follow-up goes straight through (1) to the consent page.
      url.searchParams.set("prompt", "consent");
      return c.redirect(url.toString(), 302);
    }
  }

  // (1) Force the consent param for the (session-bearing) authorize request.
  if (url.searchParams.get("prompt") !== "consent") {
    url.searchParams.set("prompt", "consent");
    return c.redirect(url.toString(), 302);
  }
  return next();
}
