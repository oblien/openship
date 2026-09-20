-- The webmail project serving a mail server, as a stored FK.
--
-- Webmail is now an ordinary catalog app (packages/core/src/apps/catalog/webmail.json)
-- installed through the SAME generic installer as every other app, so its slug is
-- derived from the project NAME the operator typed. The link therefore cannot be a
-- naming convention any more: the old lookup parsed `webmail-<serverId>` back out of
-- the slug, which the generic installer never produces — and which, while it existed,
-- mislinked any project a user happened to name "Webmail Prod" (slug `webmail-prod`,
-- read back as mail server "prod").
--
-- Nullable: most servers have no webmail, and an operator may run one outside
-- openship. ON DELETE SET NULL so deleting the webmail project clears the link and
-- /emails falls back to the install CTA rather than pointing at a row that is gone.
--
-- No backfill. A pre-existing webmail project still carries the retired
-- `mail-webmail` template id and the `webmail-<serverId>` slug; the mail status
-- resolver keeps that legacy slug lookup as a fallback for exactly those rows, and
-- stamps this column the first time it resolves one.
ALTER TABLE "mail_servers" ADD COLUMN IF NOT EXISTS "webmail_project_id" text;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_webmail_project_id_project_id_fk"
    FOREIGN KEY ("webmail_project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
