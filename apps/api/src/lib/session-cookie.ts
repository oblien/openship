import type { Context } from "hono";
import { auth } from "@repo/platform/engine/lib/auth";

/**
 * Stamp the response with a signed Better Auth session cookie. Shared by every
 * successful auth path (desktop-login, get-session bootstrap, the MCP authorize
 * zero-auth mint) so cookie attributes (httpOnly, Lax, `/`, expiry) stay
 * consistent — drift between paths causes subtle "logged in but redirected to
 * /login" bugs.
 */
export async function setSessionCookie(c: Context, token: string): Promise<void> {
  const requestHeaders = new Headers(c.req.raw.headers);
  requestHeaders.set("authorization", `Bearer ${token}`);
  const { headers } = await auth.api.setBridgeSessionCookie({
    headers: requestHeaders,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
}
