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

/** Instance SMTP config as returned by the API — password is never included. */
export interface InstanceEmailSettings {
  configured: boolean;
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
  /** True when ANY transport (instance SMTP / mail server / env) can deliver. */
  deliverable: boolean;
}

export interface ServerInfo {
  id: string;
  name: string | null;
  /** The auto-registered host row (VPS / server-host mode) — "This Server".
   *  Deploys to it run on the local host, and its SSH fields are placeholders. */
  isLocal?: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuthMethod: string | null;
  sshKeyPath: string | null;
  sshJumpHost: string | null;
  sshArgs: string | null;
  createdAt: string;
  /** ISO-3166-1 alpha-2 country for the host IP, or null (hostname/private/unknown). */
  country?: string | null;
  /** Projects currently deployed to this server (active deployment → this host). */
  projectCount?: number;
}

/** A native module's cached drift status on a server (server_module_status). */
export interface ServerModuleStatus {
  id: string;
  serverId: string;
  moduleName: string;
  installedVersion: string | null;
  migrationVersion: string | null;
  availableVersion: string | null;
  behind: boolean;
  latestInProgress: boolean;
  currentLabel: string | null;
  latestLabel: string | null;
  detail: {
    pendingConsent?: { id: string; version: string; warning?: string }[];
    autoPending?: string[];
    catalogAvailable?: boolean;
    note?: string;
  } | null;
  checkedAt: string;
}

/** Result of applying a module's pending migrations. */
export interface ModuleApplyResult {
  module: string;
  fromVersion: string;
  toVersion: string;
  appliedSteps: string[];
  pendingConsent: { id: string; version: string; warning?: string }[];
  skipped: string[];
  changed: boolean;
  ok: boolean;
  error?: string;
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
  removable?: boolean;
  removeSupported?: boolean;
  removeBlockedReason?: string;
  installed: boolean;
  version?: string;
  /** Newer version available from the package manager (candidate), if any. */
  availableVersion?: string;
  /** True when `availableVersion` is newer than the installed `version`. */
  updateAvailable?: boolean;
  running?: boolean;
  healthy: boolean;
  message: string;
  /** Infrastructure components - shown only when detected on the server */
  optional?: boolean;
}

export interface ServerCheckResult {
  components: ComponentStatus[];
  ready: boolean;
  missing: string[];
}

// ─── Edge (port 80/443) preflight ──────────────────────────────────────────────

export type EdgeProxyKind = "nginx" | "caddy" | "apache" | "traefik" | "haproxy" | "openresty";
export type EdgeClassification = "free" | "ours" | "known" | "unknown";

export interface EdgeOccupant {
  port: number;
  pid?: number;
  command?: string;
  rawCommand?: string;
  systemdUnit?: string;
  systemdDescription?: string;
  isDocker?: boolean;
  containerName?: string;
  proxy?: EdgeProxyKind;
  managedByOpenship: boolean;
}

export interface EdgeStatus {
  classification: EdgeClassification;
  occupants: EdgeOccupant[];
  canProceedClean: boolean;
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
  status: "pending" | "installing" | "installed" | "removing" | "removed" | "failed";
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

/** Mid-install prompt the pipeline is blocked on (e.g. OpenResty edge takeover). */
export interface SetupPromptEvent {
  type: "prompt";
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
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

export interface ServerRateLimitConfig {
  rps: number;
  burst: number;
  whitelist: string[];
}

/** One listening socket found by the port-exposure scan. */
export interface HostListener {
  proto: "tcp" | "udp";
  family: "ipv4" | "ipv6";
  address: string;
  port: number;
  exposed: boolean;
  pid: number | null;
  process: string | null;
  /** Well-known service label ("SSH", "HTTPS", "PostgreSQL") or null. */
  service: string | null;
  /** Expected-open platform port (SSH, edge 80/443). */
  required?: boolean;
  /** Should almost never face the internet (databases, Docker API). */
  sensitive?: boolean;
  /** Confirmed off-box: true = reachable from the internet, false = bound but
   *  firewall-blocked, null/undefined = not probed (loopback, UDP, local target). */
  reachable?: boolean | null;
}

export interface PortScanResult {
  listeners: HostListener[];
  totalCount: number;
  exposedCount: number;
  source: "ss" | "procfs";
  scanned: boolean;
  /** Whether the API confirmed reachability by dialing exposed ports off-box. */
  reachabilityProbed?: boolean;
  /** Exposed TCP ports confirmed reachable from the internet. */
  reachableCount?: number;
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

/** A saved port-forward tunnel + its live status (desktop-only). */
export interface TunnelInfo {
  id: string;
  serverId: string;
  remoteHost: string;
  remotePort: number;
  /** Configured/last-assigned preferred local port (null = let the OS pick). */
  localPort: number | null;
  autoStart: boolean;
  running: boolean;
  activeConnections: number;
  /** Ready-to-open URL, present only while the tunnel is up. */
  url: string | null;
}

export const systemApi = {
  /** List child directories at a given path (backend browse) */
  browse: (path?: string) =>
    api.get<BrowseResult>(endpoints.system.browse, {
      params: path ? { path } : undefined,
    }),

  /** Native folder picker (Electron) - returns absolute path or null */
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

  /** Get instance SMTP config (masked — never returns the password). */
  getEmailSettings: () =>
    api.get<InstanceEmailSettings>(endpoints.system.emailSettings),

  /** Set (or clear) the instance SMTP config. Blank password keeps the stored
   *  one; empty host clears/disables it. */
  updateEmailSettings: (data: {
    host: string;
    port?: number;
    user?: string;
    password?: string;
    from?: string;
  }) =>
    api.put<{ ok: boolean; configured: boolean }>(endpoints.system.emailSettings, data),

  /** Send a test email through the saved instance SMTP. */
  sendTestEmail: (to: string) =>
    api.post<{ ok: boolean; error?: string }>(endpoints.system.emailSettingsTest, { to }),

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
    }, { timeout: 30_000 }), // headroom for a cold SSH connect + parallel probes

  /** Answer a mid-install prompt (e.g. the OpenResty edge-takeover hold) */
  respondInstall: (action: string, sessionId?: string) =>
    api.post<{ ok: boolean }>(endpoints.system.installRespond, {
      action,
      ...(sessionId ? { sessionId } : {}),
    }),

  /** Install a component on a specific server */
  installComponent: (serverId: string, component: string, config?: Record<string, unknown>) =>
    api.post<InstallResultResponse>(endpoints.system.install, {
      serverId,
      component,
      ...(config ? { config } : {}),
    }),

  /** Remove a supported component from a specific server */
  removeComponent: (serverId: string, component: string, config?: Record<string, unknown>) =>
    api.post<InstallResultResponse>(endpoints.system.remove, {
      serverId,
      component,
      ...(config ? { config } : {}),
    }, { timeout: 120_000 }),

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

  /** Lightweight liveness probe for the list view (TCP reachability). */
  probeReachability: (id: string) =>
    api.get<{ reachable: boolean }>(endpoints.system.serverReachability(id)),

  /** Create a new server */
  createServerEntry: (data: Record<string, unknown>) =>
    api.post<ServerInfo>(endpoints.system.servers, data),

  /** Update a server */
  updateServerEntry: (id: string, data: Record<string, unknown>) =>
    api.patch<ServerInfo>(endpoints.system.server(id), data),

  /** Delete a server */
  deleteServerEntry: (id: string) =>
    api.delete<{ ok: boolean }>(endpoints.system.server(id)),

  // ── Native-module updates (per-server) ─────────────────────────────────────

  /** Cached drift for a server's installed native modules. */
  listServerModules: (serverId: string) =>
    api.get<ServerModuleStatus[]>(endpoints.system.serverModules(serverId)),

  /** Re-probe the server now and refresh the module drift cache. */
  scanServerModules: (serverId: string) =>
    api.post<{ ok: boolean; modules: unknown[] }>(endpoints.system.serverModulesScan(serverId), {}),

  /** Apply a module's pending migrations (includes consent-tier — surface the
   *  warning to the user first). */
  applyServerModule: (serverId: string, moduleName: string) =>
    api.post<ModuleApplyResult>(endpoints.system.serverModuleApply(serverId, moduleName), {}, {
      timeout: 120_000,
    }),

  // ── Rate Limiting (per-server) ─────────────────────────────────────────────

  /** Get rate limit config for a server */
  getRateLimit: (serverId: string) =>
    api.get<{ config: ServerRateLimitConfig }>(
      endpoints.system.serverRateLimit(serverId),
    ),

  /** Update rate limit config for a server */
  updateRateLimit: (serverId: string, data: { rps?: number; burst?: number; whitelist?: string[] }) =>
    api.patch<{ success: true; config: ServerRateLimitConfig } | { success: false; error?: string }>(
      endpoints.system.serverRateLimit(serverId),
      data,
    ),

  // ── Port exposure scan (per-server) ────────────────────────────────────────

  /** Enumerate every listening socket on the server and classify exposed vs
   *  loopback. Read-only; runs through the executor middleware server-side.
   *  Generous timeout — a cold SSH probe against a real box needs headroom. */
  scanPorts: (serverId: string) =>
    api.post<PortScanResult>(endpoints.system.serverPortsScan(serverId), {}, { timeout: 30_000 }),

  // ── Port-forward tunnels (desktop-only) ────────────────────────────────────

  /** List a server's saved forwards + their live status */
  listTunnels: (serverId: string) =>
    api.get<TunnelInfo[]>(endpoints.system.tunnels(serverId)),

  /** Create/update a forward config */
  saveTunnel: (
    serverId: string,
    data: { remotePort: number; remoteHost?: string; localPort?: number | null; autoStart?: boolean },
  ) => api.post<TunnelInfo>(endpoints.system.tunnels(serverId), data),

  /** Open a saved forward */
  startTunnel: (serverId: string, tunnelId: string) =>
    api.post<TunnelInfo>(endpoints.system.tunnelStart(serverId, tunnelId), {}),

  /** Close a live forward */
  stopTunnel: (serverId: string, tunnelId: string) =>
    api.post<TunnelInfo>(endpoints.system.tunnelStop(serverId, tunnelId), {}),

  /** Delete a forward config (stops it first if live) */
  deleteTunnel: (serverId: string, tunnelId: string) =>
    api.delete<{ ok: boolean }>(endpoints.system.tunnel(serverId, tunnelId)),
};
