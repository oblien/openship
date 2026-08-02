/**
 * GitLab module barrel — exports routes and registers the webhook provider.
 */

export { gitlabRoutes } from "./gitlab.routes";

import { registerWebhookProvider } from "../webhooks/webhook.service";
import { gitlabWebhookProvider } from "./gitlab.webhook";

registerWebhookProvider(gitlabWebhookProvider);
