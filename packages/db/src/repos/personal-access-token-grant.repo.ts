/**
 * Per-token grant repo — the scope rows for a scoped PAT. Mirrors the READ
 * contract of resource-grant.repo (same `ResourceGrant` shape + the
 * specific-over-wildcard `findForResource` preference) so the permission
 * resolver's matching logic is reused unchanged; only the row source differs
 * (keyed by tokenId instead of org+user).
 */

import { and, eq, sql } from "drizzle-orm";
import {
  generateId,
  parseSourceAccessScope,
  serializeSourceAccessScope,
  type SourceAccessScope,
} from "@repo/core";

import type { Database } from "../client";
import { personalAccessTokenGrant } from "../schema/personal-access-token-grant";
import type { Permission, ResourceGrant, ResourceType } from "./resource-grant.repo";

type Row = typeof personalAccessTokenGrant.$inferSelect;

function rowToGrant(row: Row): ResourceGrant {
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
  // The ResourceGrant shape is shared with resource_grant; consumers only read
  // resourceType/resourceId/permissions from a token grant, so org/user are
  // stubbed (the token isn't keyed by them).
  return {
    id: row.id,
    organizationId: "",
    userId: "",
    resourceType: row.resourceType as ResourceType,
    resourceId: row.resourceId,
    permissions,
    scope: parseSourceAccessScope(row.scopeJson),
    grantedByUserId: null,
    createdAt: row.createdAt,
  };
}

export function createPersonalAccessTokenGrantRepo(db: Database) {
  return {
    async listByToken(tokenId: string): Promise<ResourceGrant[]> {
      const rows = await db
        .select()
        .from(personalAccessTokenGrant)
        .where(eq(personalAccessTokenGrant.tokenId, tokenId));
      return rows.map(rowToGrant);
    },

    /** Specific-over-wildcard match, mirroring resource-grant.findForResource. */
    async findForResource(
      tokenId: string,
      resourceType: ResourceType,
      resourceId: string,
    ): Promise<ResourceGrant | null> {
      const rows = await db
        .select()
        .from(personalAccessTokenGrant)
        .where(
          and(
            eq(personalAccessTokenGrant.tokenId, tokenId),
            eq(personalAccessTokenGrant.resourceType, resourceType),
            sql`(${personalAccessTokenGrant.resourceId} = ${resourceId} OR ${personalAccessTokenGrant.resourceId} = '*')`,
          ),
        );
      const specific = rows.find((r) => r.resourceId === resourceId);
      return specific ? rowToGrant(specific) : rows.length > 0 ? rowToGrant(rows[0]!) : null;
    },

    async createMany(
      tokenId: string,
      grants: Array<{
        resourceType: ResourceType;
        resourceId: string;
        permissions: Permission[];
        scope?: SourceAccessScope | null;
      }>,
    ): Promise<void> {
      if (grants.length === 0) return;
      await db.insert(personalAccessTokenGrant).values(
        grants.map((g) => ({
          id: generateId("patgrant"),
          tokenId,
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          permissionsJson: JSON.stringify(g.permissions),
          scopeJson: serializeSourceAccessScope(g.scope),
        })),
      );
    },

    async deleteByToken(tokenId: string): Promise<void> {
      await db
        .delete(personalAccessTokenGrant)
        .where(eq(personalAccessTokenGrant.tokenId, tokenId));
    },
  };
}
