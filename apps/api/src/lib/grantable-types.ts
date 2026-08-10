/**
 * The resource types a grant may name — the single source of truth for the
 * GRANTABLE SURFACE.
 *
 * Deliberately dependency-free (the only import is a type, erased at compile) so
 * that both the permissions API and the satisfiability ratchet test can import it
 * without pulling in the DB, auth, or cloud transport.
 *
 * ── Why this list is load-bearing ────────────────────────────────────────────
 * Adding a type here makes it grantable through POST /api/permissions/grants, the
 * resource catalog, and PAT/MCP mint. A type that is grantable but that no
 * enforcement path can satisfy is a UI LIE: the owner picks it, the mint accepts
 * it, and every call the grant was meant to authorize returns 404. That is exactly
 * what happened to `github`, and what `billing`/`audit` did for longer.
 *
 * `test/lib/permission-grant-satisfiability.test.ts` pins the invariant: every
 * entry here must be provably authorized through one of the two doors —
 * `checkPermission` (the general path) or `canUseGitHubRepo` (the GitHub gate).
 * Add a type without proving it authorizes something and that test fails.
 *
 * NOTE: this is narrower than `GRANTABLE_ROOTS` in permission.ts, which also
 * lists org-singleton feature tags so the resolver ACCEPTS their tags. Those are
 * not all grantable — this list is.
 */

import type { ResourceType } from "@repo/db";

export const GRANTABLE_RESOURCE_TYPES: readonly ResourceType[] = [
  "project",
  "server",
  "mail_server",
  "backup_destination",
  // Org-singletons: granted at resourceId "*", authorized by the org-singleton
  // arm of checkPermission's restricted branch.
  "billing",
  "audit",
  // GitHub access-control grant targets: org/account (login) + single repo.
  // Authorized by canUseGitHubRepo, NOT by checkPermission — see github-access.ts.
  "github_installation",
  "github_repository",
];
