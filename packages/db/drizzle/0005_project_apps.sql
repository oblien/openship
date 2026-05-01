CREATE TABLE IF NOT EXISTS "project_app" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"git_provider" text DEFAULT 'github',
	"git_owner" text,
	"git_repo" text,
	"git_url" text,
	"installation_id" integer,
	"favicon" text,
	"favicon_checked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_app" ADD CONSTRAINT "project_app_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "app_id" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "environment_name" text DEFAULT 'Production' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "environment_slug" text DEFAULT 'production' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "environment_type" text DEFAULT 'production' NOT NULL;
--> statement-breakpoint
INSERT INTO "project_app" (
	"id",
	"user_id",
	"name",
	"slug",
	"git_provider",
	"git_owner",
	"git_repo",
	"git_url",
	"installation_id",
	"favicon",
	"favicon_checked_at",
	"created_at",
	"updated_at"
)
SELECT
	'app_' || "id",
	"user_id",
	"name",
	"slug",
	"git_provider",
	"git_owner",
	"git_repo",
	"git_url",
	"installation_id",
	"favicon",
	"favicon_checked_at",
	"created_at",
	"updated_at"
FROM "project"
WHERE "app_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "project"
SET "app_id" = 'app_' || "id"
WHERE "app_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "app_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_app_id_project_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."project_app"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_app_environment_slug_active" ON "project" ("app_id", "environment_slug") WHERE "deleted_at" IS NULL;
