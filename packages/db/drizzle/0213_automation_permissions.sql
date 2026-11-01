ALTER TABLE "assistant_automation" ADD COLUMN "allowed_actions" jsonb;
--> statement-breakpoint
ALTER TABLE "assistant_automation" ADD COLUMN "read_repository" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant_automation_run" ADD COLUMN "proposal" text;
--> statement-breakpoint
ALTER TABLE "assistant_automation_run" ADD COLUMN "proposed_action" text;
--> statement-breakpoint
ALTER TABLE "assistant_automation_run" ADD COLUMN "result_url" text;
