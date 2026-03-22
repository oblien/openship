import type { Context, Next } from "hono";
import { db, schema, eq } from "@repo/db";

/**
 * SaaS cloud-session auth.
 *
 * Local/desktop instances send the stored cloud session token as
 * `Authorization: Bearer <token>`. We resolve the user/session from the
 * SaaS session table and derive identity from that trusted server state.
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

  const [user] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, row.userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  c.set("session", row);
  return next();
}