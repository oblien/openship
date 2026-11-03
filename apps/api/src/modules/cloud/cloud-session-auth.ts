import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { normalizeIP } from "@better-auth/core/utils/ip";
import type { Context, Next } from "hono";
import { auth } from "@repo/platform/engine/lib/auth";
import { env } from "@repo/platform/engine/config/env";

/**
 * SaaS cloud-session auth.
 *
 * Local/desktop instances send the stored cloud session token as
 * `Authorization: Bearer <token>`. We resolve the user/session from the
 * SaaS session table and derive identity from that trusted server state.
 *
 * Defense-in-depth: when CLOUD_SESSION_PINNING is enabled, additionally
 * verify the request's IP and User-Agent against the values recorded
 * when the session was created. This catches exfiltrated tokens being
 * used from a different network/client, at the cost of breaking legit
 * users that switch carriers / VPN. Default is "warn" — matching
 * env.ts — with "off" (permissive Better-Auth posture) and "strict"
 * available as options.
 */
export async function cloudSessionAuth(c: Context, next: Next) {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Only the supplied bearer authenticates a linked instance. Keep browser
  // cookies out of this lookup and preserve the connection's fixed lifetime.
  const identity = await auth.api.getSession({
    headers: new Headers({ authorization: header }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!identity) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const { session: row, user } = identity;

  // IP / User-Agent fingerprint check.
  //
  // env.CLOUD_SESSION_PINNING (env default: "warn"):
  //   off    → permissive — skip fingerprint check (Better-Auth posture)
  //   warn   → log mismatches but allow (runtime default from env.ts)
  //   strict → 401 on mismatch
  //
  // We compare against the session row's stored ipAddress / userAgent
  // which Better-Auth stamped at session-create time (see
  // packages/db/src/schema/auth.ts — session.ipAddress + .userAgent).
  // Null on either side means "no fingerprint recorded" — we don't
  // gate on what we don't have.
  if (env.CLOUD_SESSION_PINNING !== "off") {
    const incomingIp = c.var.clientIp ?? "";
    const incomingUa = (c.req.header("user-agent") || "").trim();
    const storedIp = row.ipAddress ?? "";
    const storedUa = row.userAgent ?? "";

    // Canonicalize spelling and IPv4-mapped IPv6 without merging IPv6 hosts.
    const ipMismatch =
      storedIp &&
      incomingIp &&
      normalizeIP(storedIp, { ipv6Subnet: 128 }) !== normalizeIP(incomingIp, { ipv6Subnet: 128 });
    const uaMismatch = storedUa && incomingUa && storedUa !== incomingUa;

    if (ipMismatch || uaMismatch) {
      const reason = [
        ipMismatch ? `ip(stored=${storedIp},seen=${incomingIp})` : null,
        uaMismatch ? `ua-changed` : null,
      ]
        .filter(Boolean)
        .join(" ");
      errorDiagnostics.warn("api/modules/cloud/cloud-session-auth",
        `[cloud-session-auth] fingerprint mismatch userId=${row.userId} sessionId=${row.id} ${reason} (mode=${env.CLOUD_SESSION_PINNING})`,
      );
      if (env.CLOUD_SESSION_PINNING === "strict") {
        return c.json(
          {
            error: "Session does not match recorded device fingerprint",
            code: "SESSION_FINGERPRINT_MISMATCH",
          },
          401,
        );
      }
      // mode === "warn": warning logged above, continue.
    }
  }

  c.set("user", user);
  c.set("session", row);
  return next();
}
