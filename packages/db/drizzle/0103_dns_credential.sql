-- DNS provider credentials — the token that lets Openship write a domain's records.
--
-- Adding a custom domain has always ended the same way: Openship computes the exact
-- A/CNAME + `_openship-challenge` TXT records and then asks the operator to go paste
-- them somewhere else. Every minute between "added" and "pasted" is a domain that
-- doesn't resolve, can't pass ACME, and looks broken. With a scoped provider token we
-- write those records ourselves and the domain verifies on its own.
--
-- The token is the sensitive part: Zone:Read + DNS:Edit can rewrite every record in
-- every zone it can see, so it is stored ONLY as an `enc1:` AES-256-GCM envelope
-- (`encryptSecretField`) and is never returned by the API — not in full, not as a
-- prefix. `status` exists so a token that gets revoked upstream becomes visible in the
-- UI instead of silently turning auto-provisioning off forever.
CREATE TABLE IF NOT EXISTS "dns_credential" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  -- Provider name ("cloudflare"). Text, not an enum: adding a provider should be a
  -- registry entry, not a migration.
  "provider" text NOT NULL,
  -- Operator-facing label, e.g. "Cloudflare production".
  "name" text NOT NULL,
  "api_token_enc" text NOT NULL,
  -- active | invalid. Flipped to 'invalid' by the provisioning path when the provider
  -- answers 401/403, which is the only moment we learn a stored token stopped working.
  "status" text NOT NULL DEFAULT 'active',
  "last_verified_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Zone resolution runs on EVERY domain add and remove and asks one question: "this
-- org's active credentials". Leading org column means the plain org-wide listing rides
-- the same index as a prefix, so this is the only one the table needs.
CREATE INDEX IF NOT EXISTS "idx_dns_credential_org_status"
  ON "dns_credential" ("organization_id", "status");
--> statement-breakpoint
-- One label per provider per org. A second "Cloudflare production" is a double-submit,
-- and two credentials that resolve the same zone makes "which token wrote this record"
-- unanswerable at cleanup time.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_dns_credential_org_provider_name"
  ON "dns_credential" ("organization_id", "provider", "name");
