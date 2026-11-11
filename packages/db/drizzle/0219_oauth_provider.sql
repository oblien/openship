-- Add the 1.7 provider alongside the legacy tables; never reinterpret old tokens.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_jwks" (
  "id" text PRIMARY KEY NOT NULL,
  "public_key" text NOT NULL,
  "private_key" text NOT NULL,
  "created_at" timestamp NOT NULL,
  "expires_at" timestamp,
  "alg" text,
  "crv" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL UNIQUE,
  "client_secret" text,
  "client_discovery_id" text,
  "disabled" boolean DEFAULT false,
  "skip_consent" boolean,
  "enable_end_session" boolean,
  "subject_type" text,
  "scopes" text[],
  "client_credentials_scopes" text[] DEFAULT '{}'::text[],
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp,
  "updated_at" timestamp,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text[],
  "tos" text,
  "policy" text,
  "software_id" text,
  "software_version" text,
  "software_statement" text,
  "redirect_uris" text[] NOT NULL,
  "post_logout_redirect_uris" text[],
  "backchannel_logout_uri" text,
  "backchannel_logout_session_required" boolean,
  "token_endpoint_auth_method" text,
  "application_type" text,
  "jwks" text,
  "jwks_uri" text,
  "grant_types" text[],
  "response_types" text[],
  "require_pkce" boolean,
  "dpop_bound_access_tokens" boolean DEFAULT false,
  "reference_id" text,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_user_id_idx" ON "oauth_client" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_resource" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "access_token_ttl" integer,
  "refresh_token_ttl" integer,
  "signing_algorithm" text,
  "signing_key_id" text,
  "allowed_scopes" text[],
  "custom_claims" jsonb,
  "dpop_bound_access_tokens_required" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "created_at" timestamp,
  "updated_at" timestamp,
  "policy_version" integer DEFAULT 1,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "resource_id" text NOT NULL REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "created_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_client_id_idx" ON "oauth_client_resource" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" ("resource_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_client_resource_client_resource_uidx" ON "oauth_client_resource" ("client_id", "resource_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL UNIQUE,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "session_id" text REFERENCES "session"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "reference_id" text,
  "authorization_code_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL,
  "revoked" timestamp,
  "rotated_at" timestamp,
  "rotation_replay_response" text,
  "rotation_replay_expires_at" timestamp,
  "auth_time" timestamp,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" ("authorization_code_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_provider_access_token" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL UNIQUE,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "session_id" text REFERENCES "session"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "reference_id" text,
  "authorization_code_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "refresh_id" text REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL,
  "revoked" timestamp,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_client_id_idx" ON "oauth_provider_access_token" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_session_id_idx" ON "oauth_provider_access_token" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_user_id_idx" ON "oauth_provider_access_token" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_authorization_code_id_idx" ON "oauth_provider_access_token" ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_refresh_id_idx" ON "oauth_provider_access_token" ("refresh_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_provider_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "reference_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "scopes" text[] NOT NULL,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_consent_client_id_idx" ON "oauth_provider_consent" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_consent_user_id_idx" ON "oauth_provider_consent" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_token" (
  "id" text PRIMARY KEY NOT NULL,
  "access_token_hash" text NOT NULL UNIQUE,
  "access_token_encrypted" text NOT NULL,
  "refresh_token_encrypted" text,
  "access_token_expires_at" timestamp NOT NULL,
  "refresh_token_expires_at" timestamp,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "refresh_id" text REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_token_client_user_idx" ON "mcp_oauth_token" ("client_id", "user_id");
--> statement-breakpoint
-- Retain client IDs and hashed secrets, but never infer public status from a
-- missing secret. The legacy adapter did not persist authenticationScheme;
-- ambiguous confidential registrations must re-register if their method differs.
INSERT INTO "oauth_client" (
  id, client_id, client_secret, disabled, name, icon, metadata, user_id,
  redirect_uris, application_type, token_endpoint_auth_method, grant_types,
  response_types, scopes, client_credentials_scopes, require_pkce, created_at, updated_at
)
SELECT id, client_id, client_secret, disabled, name, icon,
  CASE WHEN metadata IS NULL OR metadata = '' THEN NULL ELSE metadata::jsonb END,
  user_id, string_to_array(redirect_urls, ','),
  CASE WHEN type IN ('native', 'public') THEN 'native' ELSE 'web' END,
  CASE WHEN type = 'public' THEN 'none' ELSE 'client_secret_basic' END,
  ARRAY['authorization_code', 'refresh_token'], ARRAY['code'],
  ARRAY['openid', 'profile', 'email', 'offline_access'], ARRAY[]::text[], true,
  created_at, updated_at
FROM oauth_application
ON CONFLICT (client_id) DO NOTHING;
--> statement-breakpoint
-- Retained legacy credentials must also be expired if an operator rolls back.
UPDATE oauth_access_token SET
  access_token_expires_at = LEAST(access_token_expires_at, CURRENT_TIMESTAMP),
  refresh_token_expires_at = CASE WHEN refresh_token_expires_at IS NULL THEN NULL
    ELSE LEAST(refresh_token_expires_at, CURRENT_TIMESTAMP) END
WHERE access_token_expires_at > CURRENT_TIMESTAMP OR refresh_token_expires_at > CURRENT_TIMESTAMP;
-- Old grants and consent are not copied: clients must authorize again. Keep
-- legacy records for a reviewed rollback; users/accounts are untouched.
