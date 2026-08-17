ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent" jsonb;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_secret" text;
