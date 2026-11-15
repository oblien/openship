ALTER TABLE "build_session" ADD COLUMN "execution_fenced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_build_session_recoverable_execution" ON "build_session" ("id") WHERE "execution_fenced" AND "started_at" IS NOT NULL AND "finished_at" IS NULL;
