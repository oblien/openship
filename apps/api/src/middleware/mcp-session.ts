import { reportCaughtError } from "@repo/core/diagnostics";
import type { Context, Next } from "hono";
import { auth } from "@repo/platform/engine/lib/auth";
import { publicRequestUrl } from "../lib/mcp-resource";
import { synchronizeMcpProviderResources } from "../lib/mcp-provider-resources";

/** Desktop zero-auth still requires a real loopback peer and explicit MCP consent.
 * Better Auth owns authorization parsing and the signed consent flow.
 */
export async function bootstrapMcpSession(c: Context, next: Next): Promise<Response | void> {
  const existing = await auth.api.getSession({ headers: c.req.raw.headers }).catch((error) => {
    reportCaughtError(error, "api/middleware/mcp-session");
    return null;
  });
  if (existing) {
    await synchronizeMcpProviderResources(c.req.raw.headers);
    return next();
  }

  const { zeroAuthAllowed } = await import("./zero-auth-guard");
  if (!(await zeroAuthAllowed(c)).ok) return next();
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
  await setSessionCookie(c, session.token);
  // Replay with the cookie, preserving a POST's form body and PKCE parameters.
  return c.redirect(publicRequestUrl(c.req.raw).toString(), c.req.method === "POST" ? 307 : 302);
}
