ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "security_advisory_checks_enabled" boolean DEFAULT true NOT NULL;
