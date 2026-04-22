-- Full schema: single init from TypeScript source of truth (packages/db/src/schema/*)

-- ── Auth (Better Auth core) ─────────────────────────────────────────────────

CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"auto_provisioned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint

-- ── Settings ────────────────────────────────────────────────────────────────

CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"tunnel_provider" text,
	"tunnel_token" text,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"default_build_mode" text DEFAULT 'auto' NOT NULL,
	"default_rollback_window" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22,
	"ssh_user" text DEFAULT 'root',
	"ssh_auth_method" text,
	"ssh_password" text,
	"ssh_key_path" text,
	"ssh_key_passphrase" text,
	"ssh_jump_host" text,
	"ssh_args" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"build_mode" text DEFAULT 'auto' NOT NULL,
	"cloud_session_token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint

-- ── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"local_path" text,
	"git_provider" text DEFAULT 'github',
	"git_owner" text,
	"git_repo" text,
	"git_branch" text DEFAULT 'main',
	"git_url" text,
	"installation_id" integer,
	"framework" text DEFAULT 'unknown',
	"package_manager" text DEFAULT 'npm',
	"install_command" text,
	"build_command" text,
	"output_directory" text,
	"production_paths" text,
	"root_directory" text,
	"start_command" text,
	"build_image" text,
	"production_mode" text DEFAULT 'host',
	"port" integer DEFAULT 3000,
	"has_server" boolean DEFAULT true NOT NULL,
	"has_build" boolean DEFAULT true NOT NULL,
	"resources" jsonb,
	"build_resources" jsonb,
	"sleep_mode" text DEFAULT 'auto_sleep',
	"rollback_window" integer,
	"active_deployment_id" text,
	"webhook_id" integer,
	"webhook_domain" text,
	"auto_deploy" boolean DEFAULT false NOT NULL,
	"favicon" text,
	"favicon_checked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_var" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"service_id" text,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Deployments ─────────────────────────────────────────────────────────────

CREATE TABLE "deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"commit_message" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"framework" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"image_ref" text,
	"build_duration_ms" integer,
	"container_id" text,
	"url" text,
	"meta" jsonb,
	"env_vars" jsonb,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_session" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"logs" jsonb,
	"duration_ms" integer,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Domains ─────────────────────────────────────────────────────────────────

CREATE TABLE "domain" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"service_id" text,
	"hostname" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_token" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"ssl_status" text DEFAULT 'none' NOT NULL,
	"ssl_issuer" text,
	"ssl_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domain_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint

-- ── Git ─────────────────────────────────────────────────────────────────────

CREATE TABLE "git_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"installation_id" integer NOT NULL,
	"owner" text NOT NULL,
	"owner_type" text DEFAULT 'User' NOT NULL,
	"provider_user_id" text,
	"provider_owner_id" text,
	"is_org" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Services ────────────────────────────────────────────────────────────────

CREATE TABLE "service" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"build" text,
	"dockerfile" text,
	"ports" jsonb DEFAULT '[]'::jsonb,
	"depends_on" jsonb DEFAULT '[]'::jsonb,
	"environment" jsonb DEFAULT '{}'::jsonb,
	"volumes" jsonb DEFAULT '[]'::jsonb,
	"command" text,
	"restart" text DEFAULT 'unless-stopped',
	"exposed" boolean DEFAULT false NOT NULL,
	"exposed_port" text,
	"domain" text,
	"custom_domain" text,
	"domain_type" text DEFAULT 'free',
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"service_id" text NOT NULL,
	"container_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_ref" text,
	"host_port" integer,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Analytics ───────────────────────────────────────────────────────────────

CREATE TABLE "server_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"domain" text NOT NULL,
	"minute" integer NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"unique_requests" integer DEFAULT 0 NOT NULL,
	"bandwidth_in" integer DEFAULT 0 NOT NULL,
	"bandwidth_out" integer DEFAULT 0 NOT NULL,
	"response_time" real DEFAULT 0 NOT NULL,
	"countries" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_analytics_geo" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"domain" text NOT NULL,
	"day" text NOT NULL,
	"countries" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "uq_analytics_server_domain_minute" ON "server_analytics" ("server_id", "domain", "minute");
--> statement-breakpoint
CREATE INDEX "idx_analytics_domain_minute" ON "server_analytics" ("domain", "minute");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_analytics_geo_server_domain_day" ON "server_analytics_geo" ("server_id", "domain", "day");
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────

ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "build_session" ADD CONSTRAINT "build_session_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "build_session" ADD CONSTRAINT "build_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "server_analytics" ADD CONSTRAINT "server_analytics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "server_analytics_geo" ADD CONSTRAINT "server_analytics_geo_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
