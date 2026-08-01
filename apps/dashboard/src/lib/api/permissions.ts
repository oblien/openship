import type { SourceAccessScope } from "@repo/core";
import { api } from "./client";
import { endpoints } from "./endpoints";

/**
 * Resource-grant types + client. Canonical home for the grant shapes shared by
 * the invite flow, the member-grants editor, the ResourcePicker, and (Phase 2)
 * token scoping. Keeps one definition instead of copies drifting across files.
 */

// "create" is a collection-only capability used by the "projects it creates"
// token scope: a {project,"*",[create]} grant. Not offered in the generic
// resource picker — set only by that preset.
export type Permission = "read" | "write" | "admin" | "create";

export type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit"
  | "github_installation"
  | "github_repository";

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

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  project: "Projects",
  server: "Servers",
  mail_server: "Mail servers",
  backup_destination: "Backup destinations",
  billing: "Billing",
  audit: "Audit log",
  github_installation: "GitHub orgs",
  github_repository: "GitHub repos",
};

/** Short, singular label for a grant chip / summary line. */
export function resourceTypeLabel(type: string): string {
  if (type === "github_installation") return "GitHub org";
  if (type === "github_repository") return "GitHub repo";
  return RESOURCE_TYPE_LABELS[type as ResourceType] ?? type;
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

  inviteWithGrants: (body: { email: string; role: string; grants: PickerGrant[] }) =>
    api.post(endpoints.permissions.inviteWithGrants, body),
};
