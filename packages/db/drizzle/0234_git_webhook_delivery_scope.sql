CREATE UNIQUE INDEX "uq_webhook_delivery_provider_delivery" ON "webhook_delivery" ("source", "delivery_id")
WHERE "source" NOT IN ('incoming', 'backup') AND "delivery_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX "uq_webhook_delivery_github_delivery";
