/**
 * Azure DevOps module barrel - exports routes and registers the webhook provider.
 *
 * Import this module in app.ts to:
 *   1. Mount Azure DevOps REST routes at /api/azure
 *   2. Auto-register the Azure webhook provider with the unified webhook system
 */

export { azureRoutes } from "./azure.routes";

/* ─── Auto-register webhook provider ────────────────────────────────────── */

import { registerWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
import { azureWebhookProvider } from "./azure.webhook";

registerWebhookProvider(azureWebhookProvider);
