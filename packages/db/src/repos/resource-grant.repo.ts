/**
 * Resource grant repo — fine-grained access overrides for restricted members.
 *
 * The permission resolver at apps/api/src/lib/permission.ts is the only
 * code that should consult this table for access decisions. Controllers
 * call `permission.assert(c, ...)` and never read grants directly.
 */

import { and, eq, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { resourceGrant } from "../schema/resource-grant";

export type ResourceGrantRow = typeof resourceGrant.$inferSelect;
// "create" is a collection-only capability: it authorizes creating NEW rows of
// a resource type (currently only project via a `{project,"*",[create]}` grant)
// WITHOUT granting read/write/admin on existing rows. It never satisfies a
// per-resource read/write/admin check — see permission.ts.
export type Permission = "read" | "write" | "admin" | "create";
export type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit"
  | "analytics"
  | "github"
  // GitHub access-control layer (default-deny, owner-granted). "github"
  // (resourceId "*") = all GitHub; "github_installation" (resourceId =
  // installation id) = every repo under one installation/org;
  // "github_repository" (resourceId = "owner/repo") = a single repo.
  | "github_installation"
  | "github_repository"
  | "gitlab"
  | "permissions"
  | "domain"
  | "settings"
  | "job"
  | "terminal"
  | "cloud"
  | "notifications"
  | "service"
  | "deployment"
  | "backup_policy"
  | "backup_run"
  | "backup_restore";

export interface ResourceGrant {
  id: string;
  organizationId: string;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  permissions: Permission[];
  grantedByUserId: string | null;
  createdAt: Date;
}

function rowToGrant(row: ResourceGrantRow): ResourceGrant {
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
    organizationId: row.organizationId,
    userId: row.userId,
    resourceType: row.resourceType as ResourceType,
    resourceId: row.resourceId,
    permissions,
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt,
  };
}

export function createResourceGrantRepo(db: Database) {
  return {
    /** All grants for a single (org, user) pair — powers the member detail panel. */
    async listByMember(organizationId: string, userId: string): Promise<ResourceGrant[]> {
      const rows = await db
        .select()
        .from(resourceGrant)
        .where(
          and(eq(resourceGrant.organizationId, organizationId), eq(resourceGrant.userId, userId)),
        );
      return rows.map(rowToGrant);
    },

    /**
     * Find the grant covering a specific resource. Used by the permission
     * resolver — checks (orgId, userId, resourceType, resourceId) AND
     * the wildcard row (resourceType, '*'). Returns whichever grants the
     * requested action, or null.
     */
    async findForResource(
      organizationId: string,
      userId: string,
      resourceType: ResourceType,
      resourceId: string,
    ): Promise<ResourceGrant | null> {
      const rows = await db
        .select()
        .from(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.userId, userId),
            eq(resourceGrant.resourceType, resourceType),
            sql`(${resourceGrant.resourceId} = ${resourceId} OR ${resourceGrant.resourceId} = '*')`,
          ),
        );
      // If both a specific grant and a wildcard exist, prefer the specific.
      const specific = rows.find((r) => r.resourceId === resourceId);
      return specific
        ? rowToGrant(specific)
        : rows.length > 0
          ? rowToGrant(rows[0])
          : null;
    },

    /**
     * Upsert a grant — replaces the permissions array if a row already
     * exists for the same (org, user, resourceType, resourceId). Atomic
     * via the unique index defined in the schema.
     */
    async upsert(input: {
      organizationId: string;
      userId: string;
      resourceType: ResourceType;
      resourceId: string;
      permissions: Permission[];
      grantedByUserId: string | null;
    }): Promise<ResourceGrant> {
      const id = generateId("grant");
      const permissionsJson = JSON.stringify(input.permissions);

      await db
        .insert(resourceGrant)
        .values({
          id,
          organizationId: input.organizationId,
          userId: input.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          permissionsJson,
          grantedByUserId: input.grantedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            resourceGrant.organizationId,
            resourceGrant.userId,
            resourceGrant.resourceType,
            resourceGrant.resourceId,
          ],
          set: { permissionsJson, grantedByUserId: input.grantedByUserId },
        });

      // Return the canonical row (id may differ if conflict updated existing).
      const found = await this.findForResource(
        input.organizationId,
        input.userId,
        input.resourceType,
        input.resourceId,
      );
      return found!;
    },

    /** Lookup by primary key. Org-scoped — wrong-org callers get null. */
    async findById(id: string, organizationId: string): Promise<ResourceGrant | null> {
      const [row] = await db
        .select()
        .from(resourceGrant)
        .where(
          and(eq(resourceGrant.id, id), eq(resourceGrant.organizationId, organizationId)),
        )
        .limit(1);
      return row ? rowToGrant(row) : null;
    },

    async delete(id: string, organizationId: string): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(eq(resourceGrant.id, id), eq(resourceGrant.organizationId, organizationId)),
        );
    },

    /** Bulk-delete grants for a specific resource (called on resource deletion). */
    async deleteForResource(
      organizationId: string,
      resourceType: ResourceType,
      resourceId: string,
    ): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.resourceType, resourceType),
            eq(resourceGrant.resourceId, resourceId),
          ),
        );
    },

    /**
     * Bulk-delete all grants for a (org, user) pair. Called from the
     * Better Auth `afterRemoveMember` hook so a user's grants disappear
     * the moment they lose membership. Without this, orphan rows linger
     * (the permission resolver short-circuits on missing membership so
     * they're security-inert, but they're still data debt).
     */
    async deleteByMember(organizationId: string, userId: string): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.userId, userId),
          ),
        );
    },

    /**
     * Bulk-delete every grant rows attached to an organization. Called
     * from `afterDeleteOrganization` so the cascade reaches grants
     * before the org row's FK CASCADE would (the FK already cascades —
     * this is here so the auth hook gets a definitive count back for
     * the audit row and runs even when the parent CASCADE timing
     * surprises us).
     */
    async deleteByOrganization(organizationId: string): Promise<number> {
      const rows = await db
        .delete(resourceGrant)
        .where(eq(resourceGrant.organizationId, organizationId))
        .returning();
      return rows.length;
    },

    /**
     * Reconcile GitHub grants when an installation / org account is removed
     * (uninstall, suspend, or transferred away). Deletes the account-level
     * grant (github_installation, resourceId = owner login) and every
     * single-repo grant under that owner (github_repository, "owner/..."),
     * matched case-insensitively. Returns rows removed.
     *
     * Self-healing hygiene: access correctness already holds without this
     * (list filtering runs against the live installation set; a gone
     * installation can't mint a token) — pruning just stops dangling rows
     * from accumulating.
     */
    async deleteGitHubGrantsForOwner(
      organizationId: string,
      owner: string,
    ): Promise<number> {
      const ownerLc = owner.toLowerCase();
      const rows = await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            sql`(
              (${resourceGrant.resourceType} = 'github_installation' AND lower(${resourceGrant.resourceId}) = ${ownerLc})
              OR (${resourceGrant.resourceType} = 'github_repository' AND lower(${resourceGrant.resourceId}) LIKE ${`${ownerLc}/%`})
            )`,
          ),
        )
        .returning();
      return rows.length;
    },

    /**
     * Delete ALL GitHub access grants (github / github_installation /
     * github_repository) for an org. Called when the org disconnects
     * Openship Cloud — the org loses its GitHub App identity entirely, so
     * every member-level GitHub grant is moot. Returns rows removed.
     */
    async deleteAllGitHubGrants(organizationId: string): Promise<number> {
      const rows = await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            sql`${resourceGrant.resourceType} IN ('github', 'github_installation', 'github_repository')`,
          ),
        )
        .returning();
      return rows.length;
    },
  };
}
