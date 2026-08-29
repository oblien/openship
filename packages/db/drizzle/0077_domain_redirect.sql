-- Per-domain canonical redirect: this hostname answers with a redirect to another
-- of the project's hostnames instead of serving the app.
--
-- Lives on `domain` rather than in a routing blob because the domain table IS the
-- store for a project's public endpoints (deriveProjectRouteState builds
-- publicEndpoints FROM these rows), and a redirect is a property of one hostname.
--
-- `redirect_to` NULL = serve the app (every existing row, unchanged).
-- `redirect_status` NULL = 301. Kept nullable rather than DEFAULT 301 so "no
-- redirect" is one state, not a status attached to a row that doesn't redirect.
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "redirect_to" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "redirect_status" integer;
