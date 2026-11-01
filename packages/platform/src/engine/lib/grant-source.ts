/**
 * Grant-source indirection for scoped personal access tokens.
 *
 * A scoped PAT is a restricted principal whose grants live on the token
 * (personal_access_token_grant), not on the member. The permission resolver
 * and the GitHub gate read grants through a `GrantSource` so their matching
 * logic is identical whether the rows come from the member (`resource_grant`)
 * or the token (`pat_grant`). Only the row source changes.
 */

import { repos } from "@repo/db";
import type { ResourceGrant, ResourceType } from "@repo/db";

import type { ExecutionContext as RequestContext } from "@repo/platform";

export interface GrantSource {
  findForResource(
    orgId: string,
    userId: string,
    rootType: ResourceType,
    rootId: string,
  ): Promise<ResourceGrant | null>;
  listByMember(orgId: string, userId: string): Promise<ResourceGrant[]>;
}

/** True when the caller is a scoped-token principal. */
export function isScoped(ctx: RequestContext): boolean {
  return !!ctx.tokenScope;
}

/**
 * The grant source for a request: the token's grants for a scoped PAT, else the
 * member's grants. `repos.resourceGrant` already satisfies GrantSource; the
 * token adapter maps the (org,user) params away and keys on the token id.
 */
export function grantSourceFor(ctx: RequestContext): GrantSource {
  const tokenId = ctx.tokenScope?.tokenId;
  if (!tokenId) return repos.resourceGrant;
  return {
    findForResource: (_orgId, _userId, rootType, rootId) =>
      repos.patGrant.findForResource(tokenId, rootType, rootId),
    listByMember: (_orgId, _userId) => repos.patGrant.listByToken(tokenId),
  };
}
