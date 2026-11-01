-- Durable, organization-scoped workflow execution and worker leases.
CREATE TABLE "action_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"job_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_job" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"job_key" text NOT NULL,
	"matrix_index" integer NOT NULL,
	"spec" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"runner_id" text,
	"directory" text,
	"worker_binary" text,
	"provider_workspace_id" text,
	"provider_requested_at" timestamp,
	"worker_started_at" timestamp,
	"last_event_sequence" integer DEFAULT 0 NOT NULL,
	"log_bytes" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"check_run_id" text,
	"check_status" text,
	"check_error" text,
	"check_retry_at" timestamp,
	"cancel_requested_at" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"cleaned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"number" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"original_run_id" text,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source" text NOT NULL,
	"plan" jsonb NOT NULL,
	"configuration" jsonb NOT NULL,
	"authority" jsonb NOT NULL,
	"revision" text NOT NULL,
	"ref" text NOT NULL,
	"event_name" text NOT NULL,
	"event" jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp,
	"approved_by" text,
	"concurrency_group" text,
	"cancel_in_progress" boolean DEFAULT false NOT NULL,
	"expanded_jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancel_requested_at" timestamp,
	"lease_owner" text,
	"lease_until" timestamp,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_runner" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"server_id" text,
	"cloud_pool_id" text,
	"config" jsonb NOT NULL,
	"capabilities" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"checked_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "action_runner_destination_check" CHECK (("action_runner"."server_id" IS NULL) <> ("action_runner"."cloud_pool_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "action_workflow" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"path" text NOT NULL,
	"ref" text NOT NULL,
	"source" text,
	"definition" jsonb NOT NULL,
	"last_error" text,
	"runner_ids" jsonb NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_destination_id" text REFERENCES "backup_destination" ("id") ON DELETE restrict,
	"authority" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_forks" boolean DEFAULT false NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_event_job_sequence_unique" ON "action_event" USING btree ("job_id","sequence");
--> statement-breakpoint
CREATE INDEX "action_event_run_idx" ON "action_event" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_job_owner_unique" ON "action_job" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_job_matrix_unique" ON "action_job" USING btree ("run_id","job_key","matrix_index");
--> statement-breakpoint
CREATE INDEX "action_job_runner_active_idx" ON "action_job" USING btree ("runner_id","cleaned_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_run_owner_unique" ON "action_run" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_run_idempotency_unique" ON "action_run" USING btree ("organization_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_run_number_attempt_unique" ON "action_run" USING btree ("workflow_id","number","attempt");
--> statement-breakpoint
CREATE INDEX "action_run_workflow_created_idx" ON "action_run" USING btree ("workflow_id","created_at");
--> statement-breakpoint
CREATE INDEX "action_run_pending_idx" ON "action_run" USING btree ("settled_at","lease_until");
--> statement-breakpoint
CREATE INDEX "action_run_concurrency_idx" ON "action_run" USING btree ("organization_id","concurrency_group","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runner_owner_unique" ON "action_runner" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE INDEX "action_runner_org_idx" ON "action_runner" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runner_server_unique" ON "action_runner" USING btree ("server_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_workflow_owner_unique" ON "action_workflow" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_workflow_repo_path_unique" ON "action_workflow" USING btree ("organization_id","owner","repo","path");
--> statement-breakpoint
CREATE INDEX "action_workflow_repo_idx" ON "action_workflow" USING btree ("owner","repo");
--> statement-breakpoint
ALTER TABLE "action_event" ADD CONSTRAINT "action_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_event" ADD CONSTRAINT "action_event_run_owner_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."action_run"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_event" ADD CONSTRAINT "action_event_job_owner_fk" FOREIGN KEY ("job_id","organization_id") REFERENCES "public"."action_job"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_job" ADD CONSTRAINT "action_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_job" ADD CONSTRAINT "action_job_run_owner_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."action_run"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_job" ADD CONSTRAINT "action_job_runner_owner_fk" FOREIGN KEY ("runner_id","organization_id") REFERENCES "public"."action_runner"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_run" ADD CONSTRAINT "action_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_run" ADD CONSTRAINT "action_run_workflow_owner_fk" FOREIGN KEY ("workflow_id","organization_id") REFERENCES "public"."action_workflow"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_runner" ADD CONSTRAINT "action_runner_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_runner" ADD CONSTRAINT "action_runner_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD CONSTRAINT "action_workflow_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "action_storage_object" (
  "id" serial PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization" ("id") ON DELETE cascade,
  "run_id" text NOT NULL,
  "job_id" text NOT NULL,
  "destination_id" text NOT NULL REFERENCES "backup_destination" ("id") ON DELETE restrict,
  "kind" text NOT NULL,
  "repository" text NOT NULL,
  "ref" text NOT NULL,
  "name" text NOT NULL,
  "version" text DEFAULT '' NOT NULL,
  "key" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "reserved_bytes" bigint NOT NULL,
  "max_bytes" bigint NOT NULL,
  "size" bigint,
  "sha256" text,
  "final_key" text,
  "lease_until" timestamp,
  "lease_owner" text,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_storage_run_owner_fk" FOREIGN KEY ("run_id", "organization_id") REFERENCES "action_run" ("id", "organization_id") ON DELETE restrict,
  CONSTRAINT "action_storage_job_owner_fk" FOREIGN KEY ("job_id", "organization_id") REFERENCES "action_job" ("id", "organization_id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_storage_object_owner_unique" ON "action_storage_object" ("id", "organization_id");
--> statement-breakpoint
CREATE INDEX "action_storage_run_idx" ON "action_storage_object" ("organization_id", "run_id", "kind", "state");
--> statement-breakpoint
CREATE INDEX "action_storage_cache_idx" ON "action_storage_object" ("organization_id", "repository", "ref", "kind", "state");
--> statement-breakpoint
CREATE INDEX "action_storage_expiry_idx" ON "action_storage_object" ("expires_at");
--> statement-breakpoint
CREATE TABLE "action_storage_chunk" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL,
  "object_id" integer NOT NULL,
  "kind" text DEFAULT 'part' NOT NULL,
  "name" text NOT NULL,
  "key" text NOT NULL,
  "size" integer NOT NULL,
  "sha256" text,
  "state" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_storage_chunk_owner_fk" FOREIGN KEY ("object_id", "organization_id") REFERENCES "action_storage_object" ("id", "organization_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "action_storage_chunk_object_idx" ON "action_storage_chunk" ("object_id", "created_at");
