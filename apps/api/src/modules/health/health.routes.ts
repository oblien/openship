/** Public health adapters; deployment metadata lives in the shared engine. */
import { Hono } from "hono";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { env } from "@repo/platform/engine/config/env";
import { getSystemInfo } from "@repo/platform/engine/modules/system/system-info";
import { rateLimiterFor } from "../../middleware/rate-limiter";

export const healthRoutes = new Hono();
healthRoutes.get("/", c => c.json({ status: "ok", cloudMode: env.CLOUD_MODE === true, sdk: SDK_CAPABILITIES, timestamp: new Date().toISOString() }));
healthRoutes.get("/env", rateLimiterFor("default-anon"), async c => c.json(await getSystemInfo()));
