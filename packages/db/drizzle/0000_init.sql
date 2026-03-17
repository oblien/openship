-- Full schema: squashed from TypeScript source of truth (packages/db/src/schema/*)

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
	"ssh_host" text,
	"ssh_port" integer DEFAULT 22,
	"ssh_user" text DEFAULT 'root',
	"ssh_auth_method" text,
	"ssh_password" text,
	"ssh_key_path" text,
	"ssh_key_passphrase" text,
	"ssh_jump_host" text,
	"ssh_args" text,
	"tunnel_provider" text,
	"tunnel_token" text,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"default_build_mode" text DEFAULT 'auto' NOT NULL,
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
	"active_deployment_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_var" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
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
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
