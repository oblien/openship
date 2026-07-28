/**
 * Image catalog routes - mounted at /api/images.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import { rateLimiterFor } from "../../middleware/rate-limiter";
import * as ctrl from "./images.controller";

export const imageRoutes = new Hono();

imageRoutes.use("*", authMiddleware);
// RAW module (not secureRouter): rate-limit AFTER auth for the per-user
// default-authed key — the global /api/* limiter is gone (fixes #123).
imageRoutes.use("*", rateLimiterFor("default-authed"));
imageRoutes.get("/", ctrl.list);
