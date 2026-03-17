/**
 * Domain routes — mounted at /api/domains in app.ts.
 *
 * All routes require authentication.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./domain.controller";

export const domainRoutes = new Hono();

/* All domain routes require authentication */
domainRoutes.use("*", authMiddleware);

/* ─── Domains ──────────────────────────────────────────────────────────── */
domainRoutes.get("/", ctrl.list);
domainRoutes.post("/", ctrl.add);
domainRoutes.post("/preview", ctrl.preview);
domainRoutes.delete("/:id", ctrl.remove);
domainRoutes.post("/:id/verify", ctrl.verify);
domainRoutes.get("/:id/records", ctrl.records);
domainRoutes.post("/:id/renew", ctrl.renewSsl);
domainRoutes.post("/renew-all", ctrl.renewAllSsl);
