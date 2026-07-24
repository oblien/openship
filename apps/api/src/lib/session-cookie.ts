import type { Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { env } from "../config/env";
import { COOKIE_PREFIX } from "./auth";

/**
 * Stamp the response with a signed Better Auth session cookie. Shared by every
 * successful auth path (desktop-login, get-session bootstrap, the MCP authorize
 * zero-auth mint) so cookie attributes (httpOnly, Lax, `/`, expiry) stay
 * consistent — drift between paths causes subtle "logged in but redirected to
 * /login" bugs.
 */
export async function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: Date,
): Promise<void> {
  // Secure ONLY when actually served over TLS — SaaS (CLOUD_MODE) or a self-host
  // behind https (OPENSHIP_PUBLIC_URL). A loopback/LAN http instance (desktop,
  // dev, `openship up` without --public-url) MUST NOT set Secure, or the browser
  // silently drops the cookie and the user gets a "logged in → /login" loop.
  const secure =
    env.CLOUD_MODE || (env.OPENSHIP_PUBLIC_URL?.trim().toLowerCase().startsWith("https://") ?? false);
  await setSignedCookie(c, `${COOKIE_PREFIX}.session_token`, token, env.BETTER_AUTH_SECRET, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}
