ALTER TABLE "swarm_stack" ADD COLUMN IF NOT EXISTS "source_branch" text;--> statement-breakpoint
ALTER TABLE "swarm_stack" ADD COLUMN IF NOT EXISTS "source_commit_sha" text;--> statement-breakpoint
ALTER TABLE "swarm_stack" ADD COLUMN IF NOT EXISTS "source_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_stack_revision" ADD COLUMN IF NOT EXISTS "source_commit_sha" text;
