-- Per-repo source access scope on every grant-bearing table.
--
-- A grant already carries a VERB in `permissions_json` (read / write / admin).
-- This column adds the SURFACE: may the holder read file CONTENT, and under which
-- paths. The two do not overlap, and the absence of a scope is meaningful:
--
--   read + scope_json NULL                        -> metadata only (branches,
--                                                    detect, deploy). THE DEFAULT.
--   read + {"v":1,"read":{"paths":["src/**"]}}    -> file content under src only
--   write + {"v":1,"write":{"paths":[...]}}       -> content writes under those paths
--
-- So a repo grant no longer implies the right to crawl the repository. NULL is the
-- restrictive state, which is why this is nullable with no default and no backfill:
-- every existing row correctly reads as metadata-only.
--
-- Encoded as JSON text (not jsonb, not text[]) to match `permissions_json` — the
-- column types have to behave identically across PGlite and Postgres without
-- driver-specific casting, and the repos already own (de)serialisation.
--
-- Shape + matching semantics: packages/core/src/source-access.ts. Malformed JSON,
-- an unknown "v", or an unparseable pattern all resolve to NO access rather than
-- unrestricted access.
ALTER TABLE "resource_grant" ADD COLUMN IF NOT EXISTS "scope_json" text;
--> statement-breakpoint
ALTER TABLE "personal_access_token_grant" ADD COLUMN IF NOT EXISTS "scope_json" text;
--> statement-breakpoint
-- Pending invite grants carry the scope through acceptance; without it, a
-- restricted invitee would materialise into a metadata-only grant and silently
-- lose the content access the inviter picked.
ALTER TABLE "invitation_pending_grant" ADD COLUMN IF NOT EXISTS "scope_json" text;
