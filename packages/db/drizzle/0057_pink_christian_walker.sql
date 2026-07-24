CREATE TABLE "monitor" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"expected_status" integer,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp,
	"last_status_code" integer,
	"last_response_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_check" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"response_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "monitor_incident" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"error" text,
	"failed_checks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_check" ADD CONSTRAINT "monitor_check_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_incident" ADD CONSTRAINT "monitor_incident_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_monitor_project" ON "monitor" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_monitor_due" ON "monitor" USING btree ("enabled","last_checked_at");--> statement-breakpoint
CREATE INDEX "idx_monitor_check_monitor_checked" ON "monitor_check" USING btree ("monitor_id","checked_at");--> statement-breakpoint
CREATE INDEX "idx_monitor_incident_monitor_started" ON "monitor_incident" USING btree ("monitor_id","started_at");