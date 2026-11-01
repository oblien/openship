CREATE TABLE IF NOT EXISTS "action_oidc_key" (
  "id" text PRIMARY KEY NOT NULL,
  "kid" text NOT NULL,
  "private_key_enc" text NOT NULL,
  "public_key" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
