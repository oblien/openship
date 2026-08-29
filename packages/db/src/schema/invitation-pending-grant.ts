import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { invitation } from "./organization";

/**
 * Resource grants attached to an invitation, materialized when the
 * invitation is accepted.
 *
 * Workflow:
 *   1. Admin opens "Invite member", picks role=restricted, picks resources
 *      from the catalog picker → frontend sends one combined request.
 *   2. POST /api/permissions/invite-with-grants:
 *        a. Calls Better Auth's organization.inviteMember → creates an
 *           `invitation` row (id = inv_…).
 *        b. Stores each (resourceType, resourceId, permissions) tuple in
 *           THIS table keyed by the invitation id.
 *   3. Invitee clicks the accept link → /accept-invite/{id}:
 *        a. Better Auth's accept creates a `member` row.
 *        b. The accept-invite page calls
 *           POST /api/permissions/invitations/{id}/materialize → for each
 *           row in invitation_pending_grant{invitationId=id}, upsert a
 *           resource_grant row, then delete the pending row.
 *
 * If the invitee never accepts (invitation expires / is canceled), the
 * pending grants are orphaned. We could clean them up via a cron, but
 * the FK with ON DELETE CASCADE means they vanish if the invitation row
 * is deleted.
 */
export const invitationPendingGrant = pgTable(
  "invitation_pending_grant",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    /** Specific resource id OR '*' for "every resource of this type in the org". */
    resourceId: text("resource_id").notNull(),
    /** JSON-encoded array of permission strings, same encoding as resource_grant.permissionsJson. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /**
     * Source-access scope, carried through acceptance. Without it a restricted
     * invitee would materialise into a metadata-only grant and silently lose the
     * content access the inviter picked. See resource-grant.ts.
     */
    scopeJson: text("scope_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invitation_pending_grant_invitation_idx").on(t.invitationId),
  ],
);
