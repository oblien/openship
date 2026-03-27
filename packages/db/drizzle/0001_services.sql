-- Multi-service support: services, service deployments, and service scoping

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
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Service deployments ─────────────────────────────────────────────────────

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

-- ── Add service_id to env_var (nullable — null means project-level) ─────────

ALTER TABLE "env_var" ADD COLUMN "service_id" text;
--> statement-breakpoint

-- ── Add service_id to domain (nullable — null means main/project-level) ─────

ALTER TABLE "domain" ADD COLUMN "service_id" text;
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────

ALTER TABLE "service" ADD CONSTRAINT "service_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;
