import { Hono } from "hono";
import * as webhookController from "./webhook.controller";

export const webhookRoutes = new Hono();

/* Git provider webhooks (push events trigger deployments) */
webhookRoutes.post("/github", webhookController.github);
webhookRoutes.post("/gitlab", webhookController.gitlab);
webhookRoutes.post("/bitbucket", webhookController.bitbucket);

/* Generic webhook for custom integrations */
webhookRoutes.post("/custom/:projectId", webhookController.custom);
