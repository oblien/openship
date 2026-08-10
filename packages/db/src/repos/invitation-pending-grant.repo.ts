/**
 * Pending-grant repo — resource grants attached to an invitation,
 * materialized into resource_grant rows when the invitee accepts.
 *
 * See schema/invitation-pending-grant.ts for the lifecycle. Controllers
 * never read these directly — the only consumers are:
 *   - POST /api/permissions/invite-with-grants  (writes)
 *   - POST /api/permissions/invitations/{id}/materialize  (reads + deletes)
 */

import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  generateId,
  parseSourceAccessScope,
  serializeSourceAccessScope,
  type SourceAccessScope,
} from "@repo/core";
import type { Database } from "../client";
import { invitationPendingGrant } from "../schema/invitation-pending-grant";
import { invitation } from "../schema/organization";
import type { Permission, ResourceType } from "./resource-grant.repo";

export type InvitationPendingGrantRow = typeof invitationPendingGrant.$inferSelect;

export interface InvitationPendingGrant {
  id: string;
  invitationId: string;
  resourceType: ResourceType;
  resourceId: string;
  permissions: Permission[];
  /** Carried through acceptance so materialization preserves the inviter's
   *  chosen source access. `undefined` = metadata only. */
  scope?: SourceAccessScope;
}

function rowToGrant(row: InvitationPendingGrantRow): InvitationPendingGrant {
  let permissions: Permission[] = [];
  try {
    const parsed = JSON.parse(row.permissionsJson);
    if (Array.isArray(parsed)) {
      permissions = parsed.filter(
        (p): p is Permission => p === "read" || p === "write" || p === "admin" || p === "create",
      );
    }
  } catch {
    permissions = [];
  }
  return {
    id: row.id,
    invitationId: row.invitationId,
    resourceType: row.resourceType as ResourceType,
    resourceId: row.resourceId,
    permissions,
    scope: parseSourceAccessScope(row.scopeJson),
  };
}

export function createInvitationPendingGrantRepo(db: Database) {
  return {
    /** List all pending grants for one invitation. */
    async listByInvitation(invitationId: string): Promise<InvitationPendingGrant[]> {
      const rows = await db
        .select()
        .from(invitationPendingGrant)
        .where(eq(invitationPendingGrant.invitationId, invitationId));
      return rows.map(rowToGrant);
    },

    /** Add a pending grant. */
    async create(input: {
      invitationId: string;
      resourceType: ResourceType;
      resourceId: string;
      permissions: Permission[];
      scope?: SourceAccessScope | null;
    }): Promise<InvitationPendingGrant> {
      const id = generateId("pgnt");
      const scopeJson = serializeSourceAccessScope(input.scope);
      await db.insert(invitationPendingGrant).values({
        id,
        invitationId: input.invitationId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        permissionsJson: JSON.stringify(input.permissions),
        scopeJson,
      });
      return {
        id,
        invitationId: input.invitationId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        permissions: input.permissions,
        // Round-trip through the serialiser so the returned value is exactly what
        // was stored (normalised, malformed rules dropped), not the raw input.
        scope: parseSourceAccessScope(scopeJson),
      };
    },

    /**
     * Delete all pending grants for one invitation. Used after
     * materialization (success path) and on invitation cancel.
     * (The schema's ON DELETE CASCADE already covers invitation row
     * deletion, but explicit cleanup is safer when the invitation row
     * is updated rather than deleted.)
     */
    async deleteByInvitation(invitationId: string): Promise<void> {
      await db
        .delete(invitationPendingGrant)
        .where(eq(invitationPendingGrant.invitationId, invitationId));
    },

    /** Delete a single pending grant by id. */
    async delete(id: string): Promise<void> {
      await db.delete(invitationPendingGrant).where(eq(invitationPendingGrant.id, id));
    },

    /**
     * Garbage-collect pending-grant rows whose underlying invitation is
     * no longer materializable: status in (expired, rejected, canceled)
     * OR expiresAt < now. The afterReject/afterCancel hooks delete on
     * the negative paths, but Better Auth flips status="expired" on the
     * timed-expiry path WITHOUT firing a hook — so pending grants would
     * otherwise accumulate forever. Returns the number of rows removed.
     */
    async sweepDeadInvitations(): Promise<number> {
      const dead = await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          or(
            inArray(invitation.status, ["expired", "rejected", "canceled"]),
            lt(invitation.expiresAt, sql`now()`),
          ),
        );
      const ids = dead.map((row) => row.id);
      if (ids.length === 0) return 0;
      const result = await db
        .delete(invitationPendingGrant)
        .where(inArray(invitationPendingGrant.invitationId, ids));
      // Drizzle's delete returns shape varies by driver; pg returns
      // rowCount, pglite wraps it. Both expose a numeric rowCount.
      const rowCount = (result as unknown as { rowCount?: number }).rowCount;
      return rowCount ?? ids.length;
    },
  };
}
