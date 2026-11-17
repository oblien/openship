ALTER TABLE "project" ADD COLUMN "replicas" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "replicas" integer;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_replicas_bounds" CHECK ("replicas" BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_replicas_bounds" CHECK ("replicas" BETWEEN 1 AND 100);
