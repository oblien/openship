-- MCP observability: attribute an audit row to the CLIENT that made it, and
-- count how much a credential is used.
--
-- `source` already said "an AI assistant did this" (0088), unforgeably — but not
-- WHICH assistant. With two clients connected under one user (Claude Desktop and
-- Cursor, say) every row read the same, so "what did this agent do" could not be
-- answered and disconnecting the wrong one was a coin flip. The column holds the
-- canonical principal id the auth layer already mints (`oauth:<clientId>` /
-- `pat:<tokenId>`), so it resolves to a name through existing tables.
--
-- The index is PARTIAL: only MCP rows ever carry a client id, and mcp.tool_called
-- makes audit_event's highest-volume writer, so indexing the NULLs would be paid
-- for on every insert in the table for no read.
ALTER TABLE "audit_event" ADD COLUMN IF NOT EXISTS "source_client_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_event_org_client_idx"
  ON "audit_event" ("organization_id", "source_client_id", "created_at" DESC)
  WHERE "source_client_id" IS NOT NULL;--> statement-breakpoint

-- Call counter for every bearer credential (manual PATs and the OAuth-binding
-- rows behind MCP connections alike). NOT NULL DEFAULT 0 is safe here: existing
-- rows genuinely have no counted history, and 0 alongside a non-null
-- `last_used_at` reads correctly as "used before counting existed".
ALTER TABLE "personal_access_token" ADD COLUMN IF NOT EXISTS "use_count" integer DEFAULT 0 NOT NULL;
