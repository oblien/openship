import type { Context, Next } from "hono";
import { db, schema, eq } from "@repo/db";
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

  const token = header.slice(7);

  const [row] = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.token, token))
    .limit(1);

  if (!row || row.expiresAt < new Date()) {
    return c.json({ error: "Unauthorized" }, 401);
  }

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

    const ipMismatch = storedIp && incomingIp && storedIp !== incomingIp;
    const uaMismatch = storedUa && incomingUa && storedUa !== incomingUa;

    if (ipMismatch || uaMismatch) {
      const reason = [
        ipMismatch ? `ip(stored=${storedIp},seen=${incomingIp})` : null,
        uaMismatch ? `ua-changed` : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.warn(
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

  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, row.userId)).limit(1);

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  c.set("session", row);
  return next();
}
