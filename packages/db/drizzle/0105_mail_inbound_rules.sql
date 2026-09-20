-- Inbound-mail notification rules — "mail arrives at a watched address, tell me in a channel".
--
-- Capture is Postfix's own `recipient_bcc_maps`, which the shipped main.cf already points
-- at two SQL tables in the engine's `vmail` DB (main.cf.pgsql:36-38). Arming a rule is
-- therefore ONE row in `vmail.recipient_bcc_domain` — no postmap, no reload, no container
-- recreate, and identical on the container and legacy host flavors, so it reaches every
-- mail box already provisioned.
--
-- ONE TABLE, ON PURPOSE. The obvious second table — a record of each armed collector —
-- would only cache state the mail engine already holds authoritatively: the token is
-- literally inside `recipient_bcc_domain.bcc_address`
-- (`openship-hook+<token>@<domain>`), the maildir is in `vmail.mailbox`, and "a foreign
-- BCC took the slot" is derivable by comparing that address against our own prefix. A
-- cache of the engine's own state is a thing that goes stale; the collector is READ from
-- vmail instead.
--
-- What genuinely has to persist here is the RULES: they reference
-- `notification_channel` ids, which exist only in this database, and they are created and
-- edited from a dashboard tab. Keeping them on the mail box would make every list and
-- toggle an SSH round-trip, and would make the rules unreadable exactly when the mail box
-- is unreachable.
--
-- No cursor table either. The BCC copy is a full message in the collector's maildir, so
-- the read job dispatches and then DELETES the file: deletion is the cursor, and it
-- doubles as the prune that keeps a second full copy of every watched message from
-- growing forever on a bind mount with no quota of its own.
CREATE TABLE IF NOT EXISTS "mail_inbound_rule" (
  "id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL REFERENCES "mail_servers"("server_id") ON DELETE CASCADE,
  -- Carried so dispatch can fan out to the right org's channels without joining back
  -- through `servers`. This does NOT make the table organization-scope for dump purposes
  -- (see dump.ts): its FK targets are instance-scope.
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  -- Operator-facing label, e.g. "Support inbox → #support".
  "name" text NOT NULL,
  -- mailbox | domain | all. Text, not an enum: a new scope should be a registry entry and
  -- a UI option, not a migration.
  "scope" text NOT NULL,
  -- Full address for `mailbox`, the domain for `domain`, NULL for `all`.
  --
  -- `all` is a genuine fan-out: there is no global `always_bcc` anywhere in the shipped
  -- Postfix config, and the domain lookup keys on exact equality with no wildcard
  -- convention — so it arms one row per domain and needs a reconcile when a domain is
  -- added. There is deliberately no CHECK tying scope to target: this schema has no CHECK
  -- constraints anywhere, and the SQL and the drizzle schema are hand-maintained in
  -- parallel. The invariant is enforced fail-closed at the write boundary and in the
  -- filter, where a mailbox rule with no target matches NOTHING rather than everything.
  "target" text,
  -- Optional extra matching, applied in the control plane at filter time so editing one
  -- never touches the mail box.  NULL = match everything.
  "from_pattern" text,
  "subject_pattern" text,
  -- Spam gate, and not optional in practice. The shipped amavis policy sets
  -- spam_lover='Y' AND bad_header_lover='Y' on the catch-all '@.' policy with empty
  -- quarantine targets, so the global $final_spam_destiny = D_DISCARD is dead for every
  -- recipient: spam and bad-header mail ARE delivered and therefore ARE captured.
  -- Nothing upstream filters on our behalf.
  "max_spam_score" real,
  -- Channel ids as a jsonb array, deliberately NOT a join table with an FK to
  -- notification_channel: the dump's FK_PARENT maps a bare `channelId` column to that
  -- table unconditionally for ANY table, which would make assertDumpSelfContained reject
  -- any dump carrying a real join row on a remap path.
  "channel_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  -- Burst control state. The notification subsystem has no rate limiting or windowed
  -- dedup of its own — that is explicitly the producer's job — so a mailing list hitting
  -- a watched address must not become one alert per message.
  "paused_reason" text,
  "last_matched_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The dispatch path's read on every tick: "enabled rules for this server".
CREATE INDEX IF NOT EXISTS "idx_mail_inbound_rule_server_enabled"
  ON "mail_inbound_rule" ("server_id", "enabled");
--> statement-breakpoint
-- The rules tab lists per org.
CREATE INDEX IF NOT EXISTS "idx_mail_inbound_rule_org"
  ON "mail_inbound_rule" ("organization_id");
