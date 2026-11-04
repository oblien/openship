CREATE TABLE "chat_app_transport_state" (
  "connection_id" text PRIMARY KEY REFERENCES "chat_app_connection"("id") ON DELETE CASCADE,
  "configuration" text NOT NULL,
  "bot_key" text NOT NULL UNIQUE,
  "cursor" text,
  "owner" text,
  "lease_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "chat_app_inbox" (
  "id" text PRIMARY KEY,
  "connection_id" text NOT NULL REFERENCES "chat_app_connection"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "payload" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "lease" text,
  "lease_until" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "chat_app_inbox_pending_idx" ON "chat_app_inbox" ("connection_id", "state", "created_at");
