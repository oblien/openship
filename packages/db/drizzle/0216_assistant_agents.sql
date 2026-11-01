CREATE TABLE "assistant_agent" (
 "id" text PRIMARY KEY NOT NULL,
 "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "client_id" text NOT NULL,
 "server_id" text REFERENCES "servers"("id") ON DELETE CASCADE,
 "provider" text NOT NULL,
 "model" text DEFAULT '' NOT NULL,
 "native_revision" integer NOT NULL,
 "revision" integer DEFAULT 1 NOT NULL,
 "read_only" boolean DEFAULT true NOT NULL,
 "grants" jsonb NOT NULL,
 "authority" jsonb NOT NULL,
 "archived" boolean DEFAULT false NOT NULL,
 "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assistant_agent_owner_idx" ON "assistant_agent" ("organization_id", "user_id");
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "agent_id" text REFERENCES "assistant_agent"("id");
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "agent_revision" integer;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "authority" jsonb;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "execution_token" text;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "execution_token_id" text;
--> statement-breakpoint
ALTER TABLE "assistant_automation" ADD COLUMN "agent_id" text REFERENCES "assistant_agent"("id");
