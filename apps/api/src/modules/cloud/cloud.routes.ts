/**
 * Cloud routes — mounted at /api/cloud in app.ts.
 *
 * Two route sets, each importing only from their own controller:
 *   cloudSaasRoutes  (CLOUD_MODE)  — token, handoffs, edge-proxy
 *   cloudLocalRoutes (!CLOUD_MODE) — disconnect, status, connect-callback
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { db, schema, eq } from "@repo/db";
import { authMiddleware } from "../../middleware";
import { rateLimiter } from "../../middleware/rate-limiter";
import * as saas from "./cloud-saas.controller";
import * as local from "./cloud-local.controller";

/**
 * Bearer-token session auth — used by the /token route.
 *
 * Local/desktop instances send the stored cloud session token as
 * `Authorization: Bearer <token>`. Better Auth's getSession only reads
 * signed cookies, so we look up the session directly in the DB.
 */
async function bearerSessionAuth(c: Context, next: Next) {
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

  const [usr] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, row.userId))
    .limit(1);

  if (!usr) return c.json({ error: "Unauthorized" }, 401);

  c.set("user", usr);
  c.set("session", row);
  return next();
}

/** SaaS routes — top-level imports, no per-request overhead */
export const cloudSaasRoutes = new Hono();

cloudSaasRoutes.get("/desktop-handoff", saas.desktopHandoff);
cloudSaasRoutes.get("/connect-handoff", saas.connectHandoff);
cloudSaasRoutes.use("/exchange-code", rateLimiter);
cloudSaasRoutes.post("/exchange-code", saas.exchangeCode);

cloudSaasRoutes.use("/token", bearerSessionAuth);
cloudSaasRoutes.post("/token", saas.getToken);

cloudSaasRoutes.use("/edge-proxy", bearerSessionAuth);
cloudSaasRoutes.post("/edge-proxy", saas.syncEdgeProxy);

/** Local routes — dynamic imports for security isolation */
export const cloudLocalRoutes = new Hono();
cloudLocalRoutes.use("*", authMiddleware);
cloudLocalRoutes.post("/disconnect", local.disconnect);
cloudLocalRoutes.get("/status", local.status);
cloudLocalRoutes.get("/connect-callback", local.connectCallback);
