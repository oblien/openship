-- Third-party credentials, in one place.
--
-- Openship needs other people's secrets for unrelated jobs — write a DNS record, pull a
-- private image, later push a backup — and each job grew its own storage: a single token
-- column on `dns_credential`, FIVE encrypted columns inlined on a backup destination, a
-- channel's own on notifications. Same `enc1:` envelope in each, three shapes, three
-- forms in the UI, and no way to reuse one credential for two features.
--
-- The unit here is the CREDENTIAL, deliberately not the thing that uses it. A backup
-- destination is a place, a DNS zone is a zone, a notification channel is a route; each
-- keeps its own row and points at a credential. That is what makes "one Cloudflare token
-- for every zone" and "one ghcr.io login for every project" possible — the reuse is the
-- point, fewer screens is the side effect.
--
-- Shape notes:
--   • `provider` is TEXT, matching dns_credential's reasoning: adding a provider should
--     be a registry entry in @repo/core, not a migration.
--   • `selector` is what the credential APPLIES TO when one per provider is not enough —
--     a registry host for `docker-registry`, NULL for an org-wide `cloudflare` token. It
--     is stored normalized (see normalizeCredentialSelector) so the value a pull derives
--     from an image reference matches the value the operator typed.
--   • `secrets_enc` is ONE `enc1:` AES-256-GCM envelope over a JSON object, so a provider
--     with several secret fields (an S3 key pair, an SFTP key + passphrase) needs no new
--     columns. The readable half lives in `public_fields`, which is what the API can
--     return without decrypting anything.
--   • `status` + `last_error` exist so a credential that was revoked upstream becomes
--     VISIBLE instead of silently failing every deploy or backup forever. `last_error` is
--     the provider's redacted reason, never its response body.
CREATE TABLE IF NOT EXISTS "credential" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  -- Provider id from CREDENTIAL_PROVIDERS ("docker-registry", "cloudflare").
  "provider" text NOT NULL,
  -- Operator-facing label, e.g. "GHCR read-only".
  "name" text NOT NULL,
  -- The resource this credential is for, normalized; NULL when the provider is org-wide.
  "selector" text,
  -- Non-secret fields (username, region, endpoint) — returned by the API as-is.
  "public_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Every secret field for this provider, as one enc1: envelope over a JSON object.
  "secrets_enc" text NOT NULL,
  -- active | invalid. Flipped to 'invalid' the moment a provider answers 401/403, which
  -- is the only time we learn a stored credential stopped working.
  "status" text NOT NULL DEFAULT 'active',
  "last_verified_at" timestamp,
  -- Redacted reason the last verify or use failed. Never provider response bodies.
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The resolve path asks exactly one question — "this org's credential for this provider
-- and this resource" — on every deploy that pulls and every domain that provisions.
-- Leading org column means the plain org-wide listing and the per-provider listing both
-- ride this index as prefixes, so it is the only lookup index the table needs. `status`
-- is filtered in code: a handful of rows per org makes an extra column here dead weight.
CREATE INDEX IF NOT EXISTS "idx_credential_org_provider_selector"
  ON "credential" ("organization_id", "provider", "selector");
--> statement-breakpoint
-- One label per provider per resource per org. A second "GHCR read-only" for the same
-- host is a double-submit, and two credentials matching one registry makes "which one
-- authenticated this pull" unanswerable when one of them starts failing.
--
-- COALESCE, not a bare column: Postgres treats NULLs as DISTINCT in a unique index, so
-- an org-wide provider (selector IS NULL — every Cloudflare token) would accept
-- unlimited duplicates of the same name and this constraint would quietly do nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_credential_org_provider_selector_name"
  ON "credential" ("organization_id", "provider", COALESCE("selector", ''), "name");
