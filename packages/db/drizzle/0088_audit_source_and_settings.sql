-- Audit log: call source + per-org recording switch.
--
--   audit_event.source — WHERE the action came in from: "dashboard", "mcp",
--     "cli", "api", "webhook", "system". Nullable on purpose: rows written
--     before this migration have no knowable source and must not be
--     mislabelled as any particular one, so they render as "Unknown". This is
--     what makes "show me only what the AI assistant did" answerable at all —
--     MCP tool calls re-enter the app through app.fetch() with nothing but an
--     Authorization header, so until now an MCP-driven write and a CLI write
--     produced identical rows.
--
--   audit_settings — recording on/off + retention, PER ORGANIZATION. Not
--     instance_settings (one row would let a single tenant disable auditing for
--     every org on a CLOUD_MODE instance) and not organization.metadata (Better
--     Auth owns those writes, which is why the auditRetentionDays documented
--     there never got a writer). Default enabled = true: auditing stays on
--     unless an admin turns it off.
ALTER TABLE "audit_event" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_event_org_source_idx" ON "audit_event" ("organization_id","source","created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_settings" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "retention_days" integer DEFAULT 90 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
