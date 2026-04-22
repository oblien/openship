import { Hono } from "hono";
import { rateLimiter } from "../../middleware/rate-limiter";
import { cloudSessionAuth } from "./cloud-session-auth";
import * as saas from "./cloud-saas.controller";

/** SaaS-only cloud routes. */
export const cloudSaasRoutes = new Hono();

cloudSaasRoutes.get("/desktop-handoff", saas.desktopHandoff);
cloudSaasRoutes.get("/connect-handoff", saas.connectHandoff);
cloudSaasRoutes.use("/exchange-code", rateLimiter);
cloudSaasRoutes.post("/exchange-code", saas.exchangeCode);

cloudSaasRoutes.use("/token", cloudSessionAuth);
cloudSaasRoutes.post("/token", saas.getToken);

cloudSaasRoutes.use("/account", cloudSessionAuth);
cloudSaasRoutes.get("/account", saas.account);

cloudSaasRoutes.use("/preflight", cloudSessionAuth);
cloudSaasRoutes.post("/preflight", saas.preflight);

cloudSaasRoutes.use("/edge-proxy", cloudSessionAuth);
cloudSaasRoutes.post("/edge-proxy", saas.syncEdgeProxy);

cloudSaasRoutes.use("/analytics", cloudSessionAuth);
cloudSaasRoutes.post("/analytics", saas.analyticsProxy);