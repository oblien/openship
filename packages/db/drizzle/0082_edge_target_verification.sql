-- Proof that a routing TARGET is ours, as Openship Cloud's shared edge now requires
-- before forwarding `<slug>.opsh.io` to it.
--
-- Keyed on (organization_id, target) because that is what the upstream keys it on:
-- one target serves every free domain on that box, so this is target-level state,
-- not domain-level. One install holds several rows — its own address plus one per
-- remote server it deploys to.
--
-- The token is persisted HERE, not only on the edge, because the upstream's list
-- endpoint returns id/target/status/expiry but NOT the token. Verification lasts 90
-- days and the upstream re-probes THE SAME token within 7 days of expiry; a 404 then
-- expires it and the free domain stops resolving ~83 days after a green deploy with
-- nothing in our logs. So a token that lived only on a box's disk would be
-- unrecoverable after a rebuild, and rows here are never deleted when a free domain
-- is dropped.
--
-- `server_id` is ON DELETE SET NULL, not cascade: losing the server row must not
-- take the token with it.
CREATE TABLE IF NOT EXISTS "edge_target_verification" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "host" text NOT NULL,
  "server_id" text REFERENCES "servers"("id") ON DELETE SET NULL,
  "verification_id" integer,
  "token" text,
  "retired_tokens" jsonb,
  "challenge_path" text,
  "status" text NOT NULL DEFAULT 'pending',
  "validated_ip" text,
  "expires_at" timestamp,
  "last_checked_at" timestamp,
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_edge_target_verification"
  ON "edge_target_verification" ("organization_id", "target");
