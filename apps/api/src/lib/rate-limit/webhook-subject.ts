import { createHash } from "node:crypto";
import type { Context } from "hono";

/** Endpoint hints partition quotas; they never authenticate a delivery. The
 * independent per-IP flood ceiling still applies if an attacker rotates them.
 * Do not use delivery IDs (unique per request), query strings or raw secrets. */
export function webhookSubject(c: Context, clientIp: string): string {
  const route = c.req.routePath || c.req.path;
  let identity = "";
  if (/\/incoming\/:id$/.test(route)) {
    identity = c.req.param("id") ?? "";
  } else if (/\/backup$/.test(route)) {
    identity = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
  } else if (c.req.param("provider") === "github") {
    const hookId = c.req.header("x-github-hook-id") ?? "";
    identity = /^\d{1,20}$/.test(hookId) ? hookId : "";
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([c.req.method, route, c.req.param("provider") ?? "", identity]))
    .digest("hex");
  return `${clientIp}:${fingerprint}`;
}
