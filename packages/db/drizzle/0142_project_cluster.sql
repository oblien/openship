ALTER TABLE "project" ADD COLUMN "cluster_id" text REFERENCES "compute_cluster"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "cluster_config" jsonb;
--> statement-breakpoint
CREATE INDEX "project_cluster_idx" ON "project" ("cluster_id") WHERE "cluster_id" IS NOT NULL;
