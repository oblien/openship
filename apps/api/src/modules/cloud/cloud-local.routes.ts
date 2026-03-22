import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as local from "./cloud-local.controller";

/** Local-only cloud routes. */
export const cloudLocalRoutes = new Hono();

cloudLocalRoutes.use("*", authMiddleware);
cloudLocalRoutes.post("/disconnect", local.disconnect);
cloudLocalRoutes.get("/status", local.status);
cloudLocalRoutes.get("/connect-callback", local.connectCallback);