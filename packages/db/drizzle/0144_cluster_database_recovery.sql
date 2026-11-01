ALTER TABLE "cluster_database" ADD COLUMN "backup_request_id" text;
--> statement-breakpoint
ALTER TABLE "cluster_database" ADD COLUMN "restore_source" jsonb;
--> statement-breakpoint
ALTER TABLE "cluster_database" DROP CONSTRAINT "cluster_database_intent_check";
--> statement-breakpoint
ALTER TABLE "cluster_database" ADD CONSTRAINT "cluster_database_intent_check" CHECK ("intent" IN ('apply','remove','backup'));
