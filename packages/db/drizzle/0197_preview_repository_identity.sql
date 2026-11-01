DROP INDEX "pull_request_preview_source_number";
--> statement-breakpoint
UPDATE "pull_request_preview" SET "owner" = lower("owner"), "repo" = lower("repo");
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_preview_source_repository_number" ON "pull_request_preview" ("source_project_id", "owner", "repo", "number");
