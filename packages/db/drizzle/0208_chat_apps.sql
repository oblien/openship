CREATE TABLE "chat_app_connection" (
 "id" text PRIMARY KEY NOT NULL, "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,"server_id" text REFERENCES "servers"("id") ON DELETE CASCADE,
 "name" text NOT NULL,"provider" text NOT NULL,"origin" text NOT NULL,"native_id" text,"enabled" boolean DEFAULT false NOT NULL,"revision" integer DEFAULT 1 NOT NULL,"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_app_org_idx" ON "chat_app_connection" ("organization_id");
--> statement-breakpoint
CREATE TABLE "chat_app_identity" (
 "id" text PRIMARY KEY NOT NULL,"connection_id" text NOT NULL REFERENCES "chat_app_connection"("id") ON DELETE CASCADE,
 "external_workspace" text NOT NULL,"external_user" text NOT NULL,"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "client_id" text NOT NULL,"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_app_sender_idx" ON "chat_app_identity" ("connection_id","external_workspace","external_user");
--> statement-breakpoint
CREATE TABLE "chat_app_challenge" (
 "id" text PRIMARY KEY NOT NULL,"connection_id" text NOT NULL REFERENCES "chat_app_connection"("id") ON DELETE CASCADE,
 "kind" text NOT NULL,"payload" text NOT NULL,"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_app_challenge_expiry_idx" ON "chat_app_challenge" ("expires_at");
--> statement-breakpoint
CREATE TABLE "chat_app_command" (
 "id" text PRIMARY KEY NOT NULL,"connection_id" text NOT NULL REFERENCES "chat_app_connection"("id") ON DELETE CASCADE,
 "external_user" text NOT NULL,"command" text NOT NULL,"request_fingerprint" text NOT NULL,"state" text DEFAULT 'running' NOT NULL,"response" text,"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_app_command_connection_idx" ON "chat_app_command" ("connection_id","created_at");
