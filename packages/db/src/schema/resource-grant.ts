import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * Per-resource permission grants — fine-grained access for members
 * with the `restricted` org role.
 *
 * Default-deny semantics: a member with role=restricted has ZERO access
 * to the org's resources unless an explicit row in this table grants it.
 * Owners/admins/members keep their existing org-wide access (no grants
 * needed for them).
 *
 * resourceType taxonomy:
 *   - project              (covers deployment, domain, service, env-var via inheritance)
 *   - server               (covers terminal access, mail admin, runtime ops on this server)
 *   - mail_server          (covers webmail, branding, mail-state)
 *   - backup_destination   (covers backup_run, backup_restore via inheritance)
 *   - billing              (org-level, resourceId = '*')
 *   - audit                (org-level, resourceId = '*')
 *
 * resourceId:
 *   - specific id (e.g. "proj_abc123") — grants access to that resource only
 *   - "*"                              — grants access to ALL resources of this type in the org
 *
 * permissions: an array of action strings.
 *   - "read"   — list + getById
 *   - "write"  — create/update/delete operations on the resource
 *   - "admin"  — manage settings + transfer + delete the resource itself
 *
 * The permission resolver (apps/api/src/lib/permission.ts) is the single
 * source of truth for evaluating these grants. Every access path in
 * controllers calls `permission.assert(c, ...)` rather than checking
 * roles or rows directly.
 */
export const resourceGrant = pgTable(
  "resource_grant",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    /** Specific resource id OR '*' for "every resource of this type in the org". */
    resourceId: text("resource_id").notNull(),
    /** JSON-encoded array of permission strings. We store as text rather
     *  than postgres `text[]` so the column types match across PGlite +
     *  Postgres without driver-specific casting. The repo (de)serializes. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /**
     * Source-access scope — the SURFACE this grant reaches, where
     * `permissionsJson` is the VERB. JSON text, same encoding rationale as above.
     *
     * NULL means metadata only: for a github repo grant, "read" alone does NOT
     * authorise reading file content. See packages/core/src/source-access.ts for
     * the shape and matching rules. Malformed content resolves to NO access.
     */
    scopeJson: text("scope_json"),
    /** Who created this grant (forensic). Set null on actor deletion so
     *  the grant survives — revoking a grant is a separate action. */
    grantedByUserId: text("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    /** A (member, resource) pair has at most one grant. Updates replace
     *  the permissions array in place. */
    uniqueIndex("resource_grant_unique").on(
      t.organizationId,
      t.userId,
      t.resourceType,
      t.resourceId,
    ),
    /** Per-member lookup (build the side panel listing all grants for X). */
    index("resource_grant_member_idx").on(t.organizationId, t.userId),
    /** Per-resource lookup ("who has access to this project?"). */
    index("resource_grant_resource_idx").on(
      t.organizationId,
      t.resourceType,
      t.resourceId,
    ),
  ],
);
