ALTER TABLE "notification_default" ADD COLUMN "default_channel_kinds" jsonb DEFAULT '["email"]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "notification_default" SET "default_channel_kinds" = jsonb_build_array("default_channel_kind");--> statement-breakpoint
ALTER TABLE "notification_default" DROP COLUMN "default_channel_kind";
