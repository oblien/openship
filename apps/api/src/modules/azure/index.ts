export { azureRoutes } from "./azure.routes";

import { registerWebhookProvider } from "../webhooks/webhook.service";
import { azureWebhookProvider } from "./azure.webhook";

registerWebhookProvider(azureWebhookProvider);
