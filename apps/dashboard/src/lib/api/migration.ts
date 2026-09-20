import { api } from "./client";
import { endpoints } from "./endpoints";

/**
 * Team-mode migration API client. Talks to the routes mounted under
 * /api/system/migration. Self-hosted only — these endpoints sit behind
 * the localOnly guard on the API side.
 */

export type DomainChoice =
  | { kind: "custom"; hostname: string }
  | { kind: "free"; slug: string };

export interface PreflightResult {
  ready: boolean;
  checks: {
    ssh: { ok: boolean; detail: string };
    releaseDist: { ok: boolean; detail: string };
    domain: { ok: boolean; detail: string };
    deployment?: { ok: boolean; detail: string };
  };
}

export interface StartServerResult {
  ok: true;
  projectId: string;
  groupId: string;
  migrationTargetUrl: string;
}

export interface StartCloudResult {
  ok: true;
  organizationId: string;
  publicUrl: string;
  imported: {
    organizations: number;
    projects: number;
    deployments: number;
    services: number;
  };
}

export interface StartTunnelResult {
  ok: true;
  tunnelId: string;
  slug: string;
  migrationTargetUrl: string;
}

export interface SwitchBackResult {
  ok: true;
  previousMode: "self_hosted_remote" | "cloud_hosted" | "tunneled";
  previousUrl: string;
  syncedFromRemote: boolean;
  rowsRestored: number;
  strippedEncryptedFields: Array<{
    table: string;
    column: string;
    rowsAffected: number;
  }>;
}

export const migrationApi = {
  preflight: (data: { serverId: string; domain: DomainChoice }) =>
    api.post<PreflightResult>(endpoints.system.migration.preflight, data),

  startServer: (data: { serverId: string; domain: DomainChoice }) =>
    api.post<StartServerResult>(endpoints.system.migration.start, data, {
      timeout: 300_000,
    }),

  startCloud: (data: { allowNonEmptyTarget?: boolean } = {}) =>
    api.post<StartCloudResult>(endpoints.system.migration.startCloud, data, {
      timeout: 300_000,
    }),

  startTunnel: (data: { slug: string }) =>
    api.post<StartTunnelResult>(endpoints.system.migration.startTunnel, data, {
      timeout: 60_000,
    }),

  switchBack: (data: { abandonRemote?: boolean } = {}) =>
    api.post<SwitchBackResult>(endpoints.system.migration.switchBack, data, {
      timeout: 300_000,
    }),
};
