ALTER TABLE "servers" ADD COLUMN "build_cache_budget_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_build_cache_budget_check"
  CHECK ("build_cache_budget_bytes" IS NULL OR "build_cache_budget_bytes" BETWEEN 1073741824 AND 70368744177664);
