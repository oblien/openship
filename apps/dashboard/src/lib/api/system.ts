import { api } from "./client";
import { endpoints } from "./endpoints";

export interface BrowseEntry {
  name: string;
  path: string;
  isProject: boolean;
}

export interface BrowseResult {
  path: string;
  directories: BrowseEntry[];
}

export interface InstanceSettings {
  configured: boolean;
  authMode?: "none" | "cloud" | "local";
  tunnelProvider?: "edge" | "cloudflare" | "ngrok" | null;
  defaultBuildMode?: "auto" | "server" | "local";
}

export interface ServerInfo {
  id: string;
  name: string | null;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuthMethod: string | null;
  sshKeyPath: string | null;
  sshJumpHost: string | null;
  sshArgs: string | null;
  createdAt: string;
}

/** True when running inside the Electron desktop shell */
function isElectron(): boolean {
  return !!(window as any).desktop?.isDesktop;
}

export interface ComponentStatus {
  name: string;
  label: string;
  description: string;
  installable: boolean;
  installed: boolean;
  version?: string;
  running?: boolean;
  healthy: boolean;
  message: string;
}

export interface ServerCheckResult {
  components: ComponentStatus[];
  ready: boolean;
  missing: string[];
}

export interface InstallResultResponse {
  component: string;
  success: boolean;
  version?: string;
  error?: string;
  logs?: string[];
}

export interface SetupComponentProgress {
  name: string;
  label: string;
  status: "pending" | "installing" | "installed" | "failed";
  error?: string;
}

export interface SetupSessionInfo {
  active: boolean;
  sessionId?: string;
  serverId?: string;
  status?: "running" | "completed" | "failed";
  components?: SetupComponentProgress[];
  startedAt?: number;
  finishedAt?: number;
}

export interface SetupLogEvent {
  type: "log";
  timestamp: string;
  component: string;
  message: string;
  level: "info" | "warn" | "error";
}

export interface ServerStats {
  cpu: number;
  memTotal: number;
  memUsed: number;
  memAvail: number;
  diskTotal: number;
  diskUsed: number;
  diskAvail: number;
  uptime: string;
  load1: string;
  load5: string;
  load15: string;
}

export interface SetupProgressEvent {
  type: "progress";
  component: string | null;
  status: string;
  error?: string;
  components: SetupComponentProgress[];
}

export interface SetupCompleteEvent {
  type: "complete";
  status: "completed" | "failed";
  components: SetupComponentProgress[];
  durationMs: number;
}

export const systemApi = {
  /** List child directories at a given path (backend browse) */
  browse: (path?: string) =>
    api.get<BrowseResult>(endpoints.system.browse, {
      params: path ? { path } : undefined,
    }),

  /** Native folder picker (Electron) — returns absolute path or null */
  pickFolder: async (): Promise<string | null> => {
    if (!isElectron()) return null;
    return (window as any).desktop.system.browseFolder();
  },

  /** Whether native folder picker is available */
  hasNativePicker: isElectron,

  /** Get instance settings (self-hosted / desktop only) */
  getSettings: () =>
    api.get<InstanceSettings>(endpoints.system.settings),

  /** Partial update instance settings */
  updateSettings: (data: Record<string, unknown>) =>
    api.patch<{ ok: boolean }>(endpoints.system.settings, data),

  /** Delete server configuration */
  deleteServer: () =>
    api.delete<{ ok: boolean }>(endpoints.system.settings),

  /** Test SSH connection with credentials (without saving) */
  testConnection: (data: {
    sshHost: string;
    sshPort?: number;
    sshUser?: string;
    sshAuthMethod: string;
    sshPassword?: string;
    sshKeyPath?: string;
    sshKeyPassphrase?: string;
  }) =>
    api.post<{ ok: boolean; message: string }>(endpoints.system.testConnection, data),

  /** Run system health checks on a specific server */
  checkServer: (serverId: string, components?: string[]) =>
    api.post<ServerCheckResult>(endpoints.system.check, {
      serverId,
      ...(components?.length ? { components } : {}),
    }),

  /** Install a component on a specific server */
  installComponent: (serverId: string, component: string, config?: Record<string, unknown>) =>
    api.post<InstallResultResponse>(endpoints.system.install, {
      serverId,
      component,
      ...(config ? { config } : {}),
    }),

  /** Get the current install session status (or check if one is running) */
  getInstallSession: (sessionId?: string) =>
    api.get<SetupSessionInfo>(endpoints.system.installSession, {
      params: sessionId ? { id: sessionId } : undefined,
    }),

  // ── Servers CRUD ─────────────────────────────────────────────────────────

  /** List all configured servers */
  listServers: () =>
    api.get<ServerInfo[]>(endpoints.system.servers),

  /** Get a single server by ID */
  getServerById: (id: string) =>
    api.get<ServerInfo>(endpoints.system.server(id)),

  /** Create a new server */
  createServerEntry: (data: Record<string, unknown>) =>
    api.post<ServerInfo>(endpoints.system.servers, data),

  /** Update a server */
  updateServerEntry: (id: string, data: Record<string, unknown>) =>
    api.patch<ServerInfo>(endpoints.system.server(id), data),

  /** Delete a server */
  deleteServerEntry: (id: string) =>
    api.delete<{ ok: boolean }>(endpoints.system.server(id)),
};
