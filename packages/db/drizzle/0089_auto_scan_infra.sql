-- instance_settings.auto_scan_infra — when on (default), the dashboard runs one
-- detect-only container scan on a relevant surface load (Infrastructure tab /
-- home) if the cached drift state is stale, so the attention dot + issue list
-- stay fresh without a manual Scan. Detect-only; auto-APPLY stays the separate
-- auto_update_infra. Idempotent ADD COLUMN IF NOT EXISTS + DEFAULT true so both
-- a clean create and an existing settings row converge on "on".
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "auto_scan_infra" boolean DEFAULT true NOT NULL;
