/**
 * Cloud routes — mounted at /api/cloud in app.ts.
 *
 * Two route sets from the same module:
 *   cloudSaasRoutes  (CLOUD_MODE)  — POST /token
 *   cloudLocalRoutes (!CLOUD_MODE) — POST /connect, POST /disconnect, GET /status
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import { rateLimiter } from "../../middleware/rate-limiter";
import * as ctrl from "./cloud.controller";

/** SaaS routes — mints namespace tokens for local instances + desktop OAuth handoff */
export const cloudSaasRoutes = new Hono();

// Desktop OAuth handoff — localhost only, PKCE + state
cloudSaasRoutes.get("/desktop-handoff", ctrl.desktopHandoff);
// Self-hosted connect handoff — HTTPS only
cloudSaasRoutes.get("/connect-handoff", ctrl.connectHandoff);
// Code exchange — no auth (code is the credential), rate-limited
cloudSaasRoutes.use("/exchange-code", rateLimiter);
cloudSaasRoutes.post("/exchange-code", ctrl.exchangeCode);

// Token minting requires auth
cloudSaasRoutes.use("/token", authMiddleware);
cloudSaasRoutes.post("/token", ctrl.getToken);

/** Local routes — manage connection to Openship Cloud */
export const cloudLocalRoutes = new Hono();
cloudLocalRoutes.use("*", authMiddleware);
cloudLocalRoutes.post("/disconnect", ctrl.disconnect);
cloudLocalRoutes.get("/status", ctrl.status);

/**
 * Cloud connect callback — used by self-hosted settings page.
 * After the user authenticates on Openship Cloud, they're redirected
 * here with a one-time code. We exchange it and store the cloud token.
 */
cloudLocalRoutes.get("/connect-callback", ctrl.connectCallback);
