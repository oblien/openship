ALTER TABLE "managed_network_preparation" ADD COLUMN "sequence" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "managed_network_operation" ADD COLUMN "sequence" integer DEFAULT 1 NOT NULL;
