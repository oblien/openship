/**
 * Resource grant repo — fine-grained access overrides for restricted members.
 *
 * The permission resolver at apps/api/src/lib/permission.ts is the only
 * code that should consult this table for access decisions. Controllers
 * call `permission.assert(c, ...)` and never read grants directly.
 */

import { and, eq, inArray, not, or, sql } from "drizzle-orm";
import {
  generateId,
  type GitProviderDefinition,
  parseSourceAccessScope,
  serializeSourceAccessScope,
  type GrantPermission,
  type Permission,
  type ResourceType,
  type SourceAccessScope,
} from "@repo/core";
import type { Database } from "../client";
import { resourceGrant } from "../schema/resource-grant";

type GrantProvider = Pick<GitProviderDefinition, "grantTypes">;

function grantsInNamespaces(provider: GrantProvider, namespaces: readonly string[]) {
  const owners = namespaces.map(namespace => namespace.toLowerCase());
  const { grantTypes } = provider;
  return or(
    and(eq(resourceGrant.resourceType, grantTypes.namespace), inArray(sql`lower(${resourceGrant.resourceId})`, owners)),
    and(eq(resourceGrant.resourceType, grantTypes.repository),
      inArray(sql`lower(regexp_replace(${resourceGrant.resourceId}, '[^/]+$', ''))`, owners.map(owner => owner + "/"))),
  )!;
}

/** Used both on standalone disconnect and inside the installation-removal transaction. */
export async function deleteNamespaceGrants(
  db: Pick<Database, "delete">, organizationId: string, provider: GitProviderDefinition, namespace: string,
) {
  const rows = await db.delete(resourceGrant).where(and(
    eq(resourceGrant.organizationId, organizationId),
    grantsInNamespaces(provider, [namespace]),
  )).returning();
  return rows.length;
}

export type ResourceGrantRow = typeof resourceGrant.$inferSelect;
// Both live in @repo/core — the dashboard needs them and has no @repo/db
// dependency. Re-exported here so `import { ResourceType } from "@repo/db"`
// keeps resolving for everything on the server side.
export type { Permission, ResourceType } from "@repo/core";

export interface ResourceGrant {
  id: string;
  organizationId: string;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  /** Coarse levels; scoped-token grants may also carry capabilities (`domains:delete`). */
  permissions: GrantPermission[];
  /**
   * Source-access scope — the SURFACE, where `permissions` is the VERB.
   * `undefined` means metadata only: for a github repo grant, "read" alone does
   * NOT authorise reading file content. Malformed stored scopes parse to
   * `undefined`, so corruption fails closed. See @repo/core source-access.
   */
  scope?: SourceAccessScope;
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
    scope: parseSourceAccessScope(row.scopeJson),
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt,
  };
}

export function createResourceGrantRepo(db: Pick<Database, "select" | "insert" | "delete">) {
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
      scope?: SourceAccessScope | null;
      grantedByUserId: string | null;
    }): Promise<ResourceGrant> {
      const id = generateId("grant");
      const permissionsJson = JSON.stringify(input.permissions);
      // Normalised on the way in, so a rule the picker accepted but the matcher
      // would reject can never be stored as if it were enforceable.
      const scopeJson = serializeSourceAccessScope(input.scope);

      await db
        .insert(resourceGrant)
        .values({
          id,
          organizationId: input.organizationId,
          userId: input.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          permissionsJson,
          scopeJson,
          grantedByUserId: input.grantedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            resourceGrant.organizationId,
            resourceGrant.userId,
            resourceGrant.resourceType,
            resourceGrant.resourceId,
          ],
          // scopeJson is REPLACED, not merged: an upsert that omits the scope is
          // "this grant has no content access", which must be able to revoke a
          // previously-granted path rather than silently keep it.
          set: { permissionsJson, scopeJson, grantedByUserId: input.grantedByUserId },
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

    /** Revoke one namespace and its repository grants within the workspace. */
    async deleteForGitNamespace(organizationId: string, provider: GitProviderDefinition, namespace: string) {
      return deleteNamespaceGrants(db, organizationId, provider, namespace);
    },

    /** Broad grants are revoked even when specific namespaces still have a local connection. */
    async deleteForGitProvider(organizationId: string, provider: GrantProvider, retainedNamespaces: readonly string[]): Promise<number> {
      const rows = await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            inArray(resourceGrant.resourceType, Object.values(provider.grantTypes)),
            retainedNamespaces.length ? not(grantsInNamespaces(provider, retainedNamespaces)) : undefined,
          ),
        )
        .returning();
      return rows.length;
    },
  };
}
