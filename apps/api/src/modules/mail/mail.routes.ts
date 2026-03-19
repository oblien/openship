/**
 * Mail setup routes — mounted at /api/mail in app.ts.
 *
 * Self-hosted only (dynamic import, gated by localOnly middleware).
 */

import { Hono } from "hono";
import { authMiddleware, localOnly } from "../../middleware";
import * as mail from "./mail.controller";

export const mailRoutes = new Hono();

mailRoutes.use("*", localOnly);
mailRoutes.use("*", authMiddleware);

/* ── Setup wizard ─────────────────────────────────────────────────── */
mailRoutes.get("/steps", mail.getSteps);
mailRoutes.get("/status", mail.getStatus);
mailRoutes.post("/setup", mail.startSetup);
mailRoutes.post("/setup/cancel", mail.cancelSetup);

/* ── Port conflict management ─────────────────────────────────────── */
mailRoutes.post("/ports/check", mail.checkPorts);
mailRoutes.post("/ports/resolve", mail.resolvePorts);
