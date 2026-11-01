ALTER TABLE "project_connection" ADD COLUMN IF NOT EXISTS "source_database_id" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_connection_source_database_id_cluster_database_id_fk') THEN
    ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_source_database_id_cluster_database_id_fk"
      FOREIGN KEY ("source_database_id") REFERENCES "cluster_database"("id") ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_connection_source_database" ON "project_connection" ("source_database_id");
