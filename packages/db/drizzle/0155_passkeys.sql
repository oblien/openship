CREATE TABLE "passkey" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "public_key" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "counter" integer NOT NULL,
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL,
  "transports" text,
  "created_at" timestamp DEFAULT now(),
  "aaguid" text
);
--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_idx" ON "passkey" ("credential_id");
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "two_factor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  CONSTRAINT "two_factor_user_id_unique" UNIQUE ("user_id")
);
