CREATE TABLE "git_source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"name" text NOT NULL,
	"app_id" integer NOT NULL,
	"slug" text NOT NULL,
	"client_id" text,
	"app_name" text,
	"avatar_url" text,
	"api_base_url" text DEFAULT 'https://api.github.com' NOT NULL,
	"web_base_url" text DEFAULT 'https://github.com' NOT NULL,
	"webhook_url" text NOT NULL,
	"secrets_enc" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_verified_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_source_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_git_source_org_provider"
	ON "git_source" USING btree ("organization_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_git_source_org_provider_name"
	ON "git_source" USING btree ("organization_id", "provider", lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_git_source_org_provider_app"
	ON "git_source" USING btree ("organization_id", "provider", "api_base_url", "app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_git_source_org_provider_default"
	ON "git_source" USING btree ("organization_id", "provider")
	WHERE "git_source"."is_default" = true;
--> statement-breakpoint
ALTER TABLE "git_installation" ADD COLUMN "source_id" text;
--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_source_id_git_source_id_fk"
	FOREIGN KEY ("source_id") REFERENCES "public"."git_source"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_git_installation_provider_owner_org";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_git_installation_provider_owner_org_legacy"
	ON "git_installation" USING btree ("provider", "owner", "organization_id")
	WHERE "git_installation"."source_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_git_installation_provider_owner_org_source"
	ON "git_installation" USING btree ("provider", "owner", "organization_id", "source_id")
	WHERE "git_installation"."source_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_git_installation_source"
	ON "git_installation" USING btree ("source_id", "installation_id");
--> statement-breakpoint
ALTER TABLE "github_install_state" ADD COLUMN "source_id" text;
--> statement-breakpoint
ALTER TABLE "github_install_state" ADD COLUMN "flow" text DEFAULT 'install' NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_install_state" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_install_state" ADD CONSTRAINT "github_install_state_source_id_git_source_id_fk"
	FOREIGN KEY ("source_id") REFERENCES "public"."git_source"("id")
	ON DELETE cascade ON UPDATE no action;
