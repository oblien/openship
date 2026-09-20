ALTER TABLE "managed_network_preparation" ADD COLUMN "replacement_preparation_id" text;
--> statement-breakpoint
ALTER TABLE "managed_network_preparation" ADD COLUMN "cleanup_operation_id" text;
--> statement-breakpoint
ALTER TABLE "managed_network_operation" ADD COLUMN "replacement_preparation_id" text;
