ALTER TABLE "project_app" ADD CONSTRAINT "project_app_git_provider_check" CHECK ("git_provider" IS NULL OR "git_provider" IN ('github','gitlab','bitbucket','self-hosted','local','upload','release'));
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_git_provider_check" CHECK ("git_provider" IS NULL OR "git_provider" IN ('github','gitlab','bitbucket','self-hosted','local','upload','release'));
