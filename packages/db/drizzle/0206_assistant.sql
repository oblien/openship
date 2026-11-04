CREATE TABLE "assistant_connection" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,
  "origin" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "organization_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_connection_client_idx" ON "assistant_connection" ("client_id");
--> statement-breakpoint
CREATE TABLE "assistant_conversation" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,
  "access_fingerprint" text NOT NULL,
  "native_chat_id" text NOT NULL UNIQUE,
  "title" text DEFAULT 'New conversation' NOT NULL,
  "provider" text NOT NULL,
  "model" text DEFAULT '' NOT NULL,
  "state" text DEFAULT 'idle' NOT NULL,
  "request_id" text,
  "run_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assistant_conversation_owner_idx" ON "assistant_conversation" ("organization_id", "user_id");
--> statement-breakpoint
CREATE TABLE "assistant_request" (
  "conversation_id" text NOT NULL REFERENCES "assistant_conversation"("id") ON DELETE CASCADE,
  "id" text NOT NULL,
  "message_hash" text NOT NULL,
  "state" text DEFAULT 'running' NOT NULL,
  "run_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("conversation_id", "id")
);
