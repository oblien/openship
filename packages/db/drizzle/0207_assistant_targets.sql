ALTER TABLE "assistant_connection" ADD COLUMN "server_id" text REFERENCES "servers"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "run_owner" text;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "server_id" text REFERENCES "servers"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "lease_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "stop_requested" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "assistant_authorization" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "payload" text NOT NULL,
  "expires_at" timestamp NOT NULL
);
