ALTER TABLE "servers" ADD COLUMN "gpu_override" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_gpu_override_check"
  CHECK ("gpu_override" IS NULL OR "gpu_override" IN ('yes', 'no'));
