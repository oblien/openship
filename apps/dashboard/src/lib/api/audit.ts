import { api } from "./client";
import { endpoints } from "./endpoints";

/** Where an action came in from. `null` on rows written before the column existed. */
export type AuditSource = "dashboard" | "mcp" | "cli" | "api" | "webhook" | "system";

export interface AuditActor {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface AuditEventRow {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  /** Resolved server-side in one batched lookup per page (never N+1). */
  actor: AuditActor | null;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  /** Human name for the resource, resolved server-side. Null when unnameable. */
  resourceName: string | null;
  source: AuditSource | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuditListResponse {
  data: AuditEventRow[];
  total: number;
  page: number;
  perPage: number;
}

export interface AuditFacets {
  total: number;
  categories: { id: string; label: string; description: string; count: number }[];
  sources: { source: AuditSource | null; count: number }[];
  actors: AuditActor[];
  settings: AuditSettings;
  canManage: boolean;
}

export interface AuditSettings {
  enabled: boolean;
  retentionDays: number;
}

export interface AuditQuery {
  page?: number;
  perPage?: number;
  category?: string;
  eventType?: string;
  actorUserId?: string;
  source?: AuditSource | "";
  resourceType?: string;
  resourceId?: string;
  /** ISO strings — the client owns "last 7 days" so presets follow local midnight. */
  from?: string;
  to?: string;
  q?: string;
}

/** Drops empty values so a cleared filter doesn't send `?actorUserId=`. */
function params(query: AuditQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value as string | number;
  }
  return out;
}

export const auditApi = {
  list: (query: AuditQuery = {}) =>
    api.get<AuditListResponse>(endpoints.audit.list, { params: params(query) }),

  /** Filter options + per-tab counts. One request drives the whole filter bar. */
  facets: (query: AuditQuery = {}) =>
    api.get<AuditFacets>(endpoints.audit.facets, { params: params(query) }),

  getSettings: () => api.get<AuditSettings & { canManage: boolean }>(endpoints.audit.settings),

  updateSettings: (patch: Partial<AuditSettings>) =>
    api.patch<AuditSettings & { canManage: boolean }>(endpoints.audit.settings, patch),
};
