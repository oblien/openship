import {
  RESOURCE_TYPE_LABELS as CORE_RESOURCE_TYPE_LABELS,
  RESOURCE_TYPE_LABELS_SINGULAR,
  INVITATION_DELIVERY_HEADER,
  INVITATION_DELIVERY_LINK_ONLY,
  type GrantableResourceType,
  type Permission,
  type SourceAccessScope,
} from "@repo/core";
import { api } from "./client";
import { endpoints } from "./endpoints";

/**
 * Resource-grant types + client. Canonical home for the grant shapes shared by
 * the invite flow, the member-grants editor, the ResourcePicker, and (Phase 2)
 * token scoping. Keeps one definition instead of copies drifting across files.
 */

// Both come from @repo/core, which is the one definition the API, the DB layer
// and this app all share.
//
// `ResourceType` here is core's `GrantableResourceType`, not its wider
// `ResourceType`. That is not a narrowing — in the dashboard this name has always
// meant "a type the picker may offer", which is why it listed 8 of the 22 values
// the column can hold. The alias keeps every consumer's import unchanged while
// making the intent explicit at the boundary.
export type ResourceType = GrantableResourceType;
export type { Permission };

export interface PickerGrant {
  resourceType: ResourceType;
  /** "*" for "all of this type" OR a specific id from the catalog. */
  resourceId: string;
  permissions: Permission[];
  /**
   * Source access for a github repo grant — the SURFACE, where `permissions` is
   * the VERB. Absent means metadata only: the grantee may deploy the repo and read
   * its branches/build config, but NOT its file contents. Edited via
   * SourceAccessModal; enforced by the API's source tier.
   *
   * Declared here so it threads through every consumer of this shape — member
   * grants (replaceGrants), invites (inviteWithGrants), and MCP consent
   * (mcpAuthorize) — instead of each growing its own field.
   */
  scope?: SourceAccessScope;
}

/** A grant as stored on the server (a PickerGrant plus its row id + owner). */
export interface ResourceGrant extends PickerGrant {
  id: string;
  userId: string;
}

export interface CatalogEntry {
  id: string;
  label: string;
  meta?: Record<string, unknown>;
}

export const RESOURCE_TYPE_LABELS = CORE_RESOURCE_TYPE_LABELS;

/** Short, singular label for a grant chip / summary line. */
export function resourceTypeLabel(type: string): string {
  return RESOURCE_TYPE_LABELS_SINGULAR[type as ResourceType] ?? type;
}

export const permissionsApi = {
  /** Catalog entries for a type. `owner` narrows github_repository to one org. */
  listResources: (type: ResourceType, owner?: string) =>
    api.get<{ data?: CatalogEntry[] }>(endpoints.permissions.resources, {
      params: { type, ...(owner ? { owner } : {}) },
    }),

  listGrants: (userId: string) =>
    api.get<{ data?: ResourceGrant[] }>(endpoints.permissions.grants, {
      params: { userId },
    }),

  /** Replace a member's entire grant set in one call (diffed server-side). */
  replaceGrants: (userId: string, grants: PickerGrant[]) =>
    api.put<{ data?: ResourceGrant[] }>(endpoints.permissions.grants, { userId, grants }),

  inviteWithGrants: (
    body: { email: string; role: string; grants: PickerGrant[] },
    options?: { linkOnly?: boolean },
  ) =>
    api.post(
      endpoints.permissions.inviteWithGrants,
      body,
      options?.linkOnly
        ? {
            headers: {
              [INVITATION_DELIVERY_HEADER]: INVITATION_DELIVERY_LINK_ONLY,
            },
          }
        : undefined,
    ),
};
