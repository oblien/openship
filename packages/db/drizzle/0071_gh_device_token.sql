ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "gh_device_token_encrypted" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "gh_device_token_set_at" timestamp;
