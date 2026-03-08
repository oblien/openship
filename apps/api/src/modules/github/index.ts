/**
 * GitHub module barrel — exports routes and registers the webhook provider.
 *
 * Import this module in app.ts to:
 *   1. Mount GitHub REST routes at /api/github
 *   2. Auto-register the GitHub webhook provider with the unified webhook system
 */

export { githubRoutes } from "./github.routes";

/* ─── Auto-register webhook provider ────────────────────────────────────── */

import { registerWebhookProvider } from "../webhooks/webhook.service";
import { githubWebhookProvider } from "./github.webhook";

registerWebhookProvider(githubWebhookProvider);
