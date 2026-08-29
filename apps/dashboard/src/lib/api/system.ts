import { api, getApiBaseUrl, getActiveOrganizationId } from "./client";
import { endpoints } from "./endpoints";
// Removal types + the timeout rule live with the pure helpers so the modal and this
// client share one definition (and so the rule is testable without React).
import {
  serverRemovalTimeoutMs,
  type ServerDeletionPreview,
  type ServerRemovalResult,
} from "../server-removal";

/**
 * Client budget for an ad-hoc SSH probe.
 *
 * Deliberately far above the 15s default: a probe's whole job is a COLD SSH
 * connect, and the API's own budget for one already exceeds 15s (a 20s ssh2
 * `readyTimeout`, then a 15s `echo`). On the default the browser aborted first
 * every time, so a firewalled or slow host could never deliver the server's
 * classified answer ("Host is not reachable", "Authentication failed") — the
 * operator saw only the abort. The client budget must stay above the server's,
 * or the diagnosis this endpoint exists to produce is unreachable.
 */
const SSH_PROBE_TIMEOUT_MS = 45_000;

/**
 * Raw credentials for an ad-hoc SSH probe.
 *
 * One shape for both probe endpoints — authed and onboarding land on the same
 * `buildEphemeralSshConfig`, so a field one of them accepts is a field both do.
 */
export interface SshProbeInput {
  sshHost: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthMethod: string;
  sshPassword?: string;
  sshKeyPath?: string;
  /** Pasted/uploaded private-key material (paste sub-mode). */
  sshPrivateKey?: string;
  sshKeyPassphrase?: string;
  sshJumpHost?: string;
  sshArgs?: string;
}

/** `ok:false` is a REACHED verdict with a reason; a throw is a failure to ask. */
export interface SshProbeResult {
  ok: boolean;
  message: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isProject: boolean;
}

export interface BrowseResult {
  path: string;
  directories: BrowseEntry[];
}

/**
 * A vhost the edge serves with no Openship record behind it.
 *
 * `static` is the case that matters: it keeps returning 200 with a removed
 * project's built files. A dead `proxy` vhost 502s and announces itself.
 */
export interface UntrackedEdgeSite {
  hostname: string;
  hostnames: string[];
  kind: "proxy" | "static";
  /** Static docroot, or proxy upstream. */
  target: string;
  ssl: boolean;
  source?: string;
}

export interface EdgeOrphanScan {
  /** False = could not compare (no edge / foreign proxy). Not the same as zero orphans. */
  scanned: boolean;
  reason?: string;
  orphans: UntrackedEdgeSite[];
  knownCount: number;
}

export interface InstanceSettings {
  configured: boolean;
  authMode?: "none" | "cloud" | "local";
  tunnelProvider?: "edge" | "cloudflare" | "ngrok" | null;
  defaultBuildMode?: "auto" | "server" | "local";
  /** Auto-update remote edge/mail containers on a control-plane version bump. */
  autoUpdateInfra?: boolean;
  /** Run one detect-only scan on a relevant surface load when the cache is stale. */
  autoScanInfra?: boolean;
  /** Stored instance-wide product mode override. null = unset (env decides). */
  productMode?: "platform" | "mail" | null;
  /** What the instance actually resolves to right now (override ?? env). */
  productModeEffective?: "platform" | "mail";
  /** Stored host-control override — may OpenShip deploy to the machine it runs
   *  on ("This Server")? null = unset (the OPENSHIP_HOST_CONTROL env decides). */
  hostControl?: boolean | null;
  /** What host control actually resolves to right now (override ?? env), already
   *  false off a non-selfhosted target so the UI agrees with the backend. */
  hostControlEffective?: boolean;
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

/** Mirrors the API's ReachabilityCode (apps/api/src/lib/ssh-manager.ts). */
export type ServerReachabilityCode =
  | "ok"
  | "cooldown"
  | "unreachable"
  | "no_address"
  | "host_channel_blocked"
  | "host_control_disabled"
  | "unknown";

/**
 * Which container→host channel state produced a `host_channel_blocked`.
 *
 * Mirrors HostChannelCode in @repo/adapters (src/system/executor.ts) — the
 * dashboard can't import the adapters (ssh/docker, server-only). It refines the
 * reachability code rather than replacing it, because the REMEDY differs: a
 * `not_configured` channel is provisioned with `openship up`, while an
 * `unreachable` one is usually a host firewall dropping bridge→host traffic, and
 * offering the wrong one of those sends an operator to edit a firewall that was
 * never involved (#509).
 */
export type HostChannelCode =
  | "ok"
  | "not_applicable"
  | "disabled"
  | "not_configured"
  | "key_unreadable"
  | "unreachable"
  /** Reached, then the key was refused — #527. Distinct from `unreachable` because the
   *  remedy is re-authorizing a key, not opening a firewall. */
  | "auth_rejected";

/**
 * GET /servers/:id/reachability — liveness plus the reason.
 *
 * `target` is what the API DIALED; for THIS box that's the container→host SSH
 * bridge, never the row's display `sshHost` (#490). It is null when there was no
 * endpoint to dial at all — a channel that was never provisioned — and the banner
 * relies on that: a present `target` is read as evidence something answered, or
 * failed to (#509).
 */
export interface ServerReachability {
  reachable: boolean;
  code: ServerReachabilityCode;
  target: string | null;
  port: number | null;
  hint: string | null;
  rule: string | null;
  channel?: HostChannelCode | null;
  /**
   * The address the channel WILL use once provisioned — intent, never a machine that
   * failed to answer. Optional because nothing produces it today: the API can only
   * report what its own env says, and in this state the env says nothing, so filling
   * this in would mean guessing at what `openship up` would have written. Consumed
   * already (rendered as intent, in its own sentence) so that whichever surface can
   * honestly supply it needs no client change.
   */
  intendedTarget?: string | null;
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
  /** True when a pasted/uploaded private key is stored (encrypted) for this
   *  server. The material itself is never returned — this is the only signal the
   *  edit form gets, so it can offer "a key is stored; paste to replace". */
  hasStoredKeyMaterial?: boolean;
  sshJumpHost: string | null;
  sshArgs: string | null;
  createdAt: string;
  /** ISO-3166-1 alpha-2 country for the host IP, or null (hostname/private/unknown). */
  country?: string | null;
  /** Projects currently deployed to this server (active deployment → this host). */
  projectCount?: number;
  /**
   * The local row's container→host SSH channel (#509) — null for a remote row, and
   * null when the diagnosis couldn't run. An annotation, not a gate: `ok: false`
   * means the host-only operations are unavailable, while ordinary container deploys
   * to this row still work over the Docker socket. `hint` is the same string
   * `GET /servers/:id/reachability` returns for the row.
   */
  hostChannel?: { ok: boolean; channel: HostChannelCode; hint: string | null } | null;
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

/**
 * A managed container's cached drift status on a server (server_container_status).
 * The container sibling of {@link ServerModuleStatus}: `running*` is what the box
 * runs now, `pinned*` is what this control plane's APP_VERSION targets, and
 * `behind` is a plain tag mismatch (an update is available).
 */
export interface ServerContainerStatus {
  id: string;
  serverId: string;
  component: "edge" | "mail";
  /** Image ref the container runs now (null when down). */
  runningLabel: string | null;
  /** Image ref this control plane pins for the component (the target). */
  pinnedLabel: string | null;
  /** Running image TAG, e.g. "0.4.0" — the version on the box. */
  runningVersion: string | null;
  /** Pinned image TAG, e.g. "0.5.0" — the version it should run. */
  pinnedVersion: string | null;
  behind: boolean;
  latestInProgress: boolean;
  /**
   * `containerMissing` splits a DOWN component into stopped-in-place (startable
   * with one click) vs gone (needs the setup path that owns its secrets) — the UI
   * only offers a fix for the former. `flavor: "host"` marks a LEGACY
   * pre-containerization mail engine (systemd Postfix/Dovecot, no image), where
   * version and drift are meaningless and the row labels the topology instead.
   */
  detail: {
    lastError?: string;
    down?: boolean;
    containerMissing?: boolean;
    flavor?: "container" | "host";
  } | null;
  checkedAt: string;
}

/** One org server paired with its cached edge/mail rows — the global infra view. */
export interface ServerContainerGroup {
  server: {
    id: string;
    name: string;
    sshHost: string;
    isLocal: boolean;
    /** Projects with an active deployment on this server — an absent edge is an
     *  issue (not just an offer) only when this is > 0. */
    projectCount: number;
  };
  components: ServerContainerStatus[];
}

/** One (server, component) pair needing hands-on action. */
export interface ContainerIssue {
  server: { id: string; name: string };
  component: "edge" | "mail";
  issue: "down" | "absent";
  /** Gone rather than stopped → the fix is the setup path, not a one-click start. */
  containerMissing: boolean;
  /** Last recorded failure for this component. Absent when it is merely stopped. */
  reason?: string;
}

/**
 * Actionable-issue rollup for the attention dot + home surface. An issue is a
 * managed component needing hands-on action: an edge that's `down` (installed, not
 * running) or `absent` (missing on a server that hosts projects), or a provisioned
 * mail engine that stopped. Behind (update available) is NOT here — that's
 * {@link ServerContainerGroup} / the updates surface. A box with no mail row has no
 * mail, so it never raises the mail alarm.
 */
export interface ContainerIssues {
  /** Issue count, not server count (one box can contribute edge + mail). */
  total: number;
  servers: ContainerIssue[];
  edgeDown: number;
  edgeMissing: number;
  mailDown: number;
}

/** `update` swaps onto the pinned image; `repair` starts a stopped container. */
export type ContainerApplyIntent = "update" | "repair";

/**
 * Outcome of a fleet bulk apply. `started` runs detached (each entry is a live
 * per-server session), `skipped` is what needs the server's own page: 80/443
 * takeover consent, a container that's gone (setup, not a restart), an apply
 * already in flight, or an unreachable box.
 */
export interface BulkApplyResult {
  started: Array<{
    serverId: string;
    serverName: string;
    component: "edge" | "mail";
    intent: ContainerApplyIntent;
  }>;
  skipped: Array<{
    serverId: string;
    serverName: string;
    component: "edge" | "mail";
    reason: "needs_takeover_consent" | "container_missing" | "already_running" | "unreachable";
  }>;
}

/**
 * One managed component the org is applying right now. `queued` means the bulk run
 * accepted it but hasn't reached it yet (it has no session, so no steps); `running`
 * carries the live step model and the session id a log view re-attaches to.
 */
export interface ContainerApplyActive {
  serverId: string;
  serverName: string;
  component: "edge" | "mail";
  state: "queued" | "running";
  /** What the operator asked for. Null for a run whose cached row is gone. */
  intent: ContainerApplyIntent | null;
  sessionId?: string;
  steps?: ContainerApplyStep[];
  startedAt?: string;
}

/** An apply that finished moments ago — the only source of a "done" beat. */
export interface ContainerApplySettled {
  serverId: string;
  serverName: string;
  component: "edge" | "mail";
  ok: boolean;
  error?: string;
  finishedAt: string;
}

/** Live fleet progress: what's in flight, and what just settled. */
export interface ContainerApplyProgress {
  active: ContainerApplyActive[];
  recent: ContainerApplySettled[];
}

/** One step of a container image swap, for the progress bar. */
export interface ContainerApplyStep {
  id: "pull" | "recreate" | "verify";
  label: string;
  status: "pending" | "running" | "done" | "error";
}

/** A parsed SSE frame from the container-apply stream. */
export type ContainerApplyEvent =
  | { event: "steps"; steps: ContainerApplyStep[] }
  | { event: "log"; timestamp: string; message: string; level: "info" | "warn" | "error" }
  | {
      event: "complete";
      status: "completed" | "failed";
      result: { updated: boolean; down: boolean } | null;
      error: string | null;
    }
  | { event: "end"; status: string }
  | { event: "ping" };

/** True when running inside the Electron desktop shell */
function isElectron(): boolean {
  return !!(window as any).desktop?.isDesktop;
}

/**
 * The desktop bridge that opens the native "Select SSH Key" dialog, or undefined
 * outside the desktop shell.
 *
 * `system.browseFile` is the right home for it, but already-installed desktop
 * builds only expose the onboarding channel — which opens the identical dialog —
 * so fall back to it rather than shipping a button that does nothing until the
 * user updates the app.
 */
function sshKeyBridge(): (() => Promise<string | null>) | undefined {
  if (typeof window === "undefined" || !isElectron()) return undefined;
  const d = (window as any).desktop;
  return d?.system?.browseFile ?? d?.onboarding?.browseFile;
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

/** Read-only status of a managed-container image swap (edge/mail), for re-attach. */
export interface ContainerApplySessionInfo {
  active: boolean;
  sessionId?: string;
  status?: "running" | "completed" | "failed";
  serverId?: string;
  component?: "edge" | "mail";
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
  /**
   * Vhosts the local edge serves that Openship no longer tracks.
   *
   * `scanned: false` is NOT "all clear" — it means we couldn't compare (no edge,
   * or a foreign proxy). Render the reason, never an empty success state.
   */
  listUntrackedEdgeSites: () =>
    api.get<{ data: EdgeOrphanScan }>(endpoints.system.edgeUntracked),

  /** Stop serving ONE untracked hostname. Owner-only; refuses anything still tracked. */
  removeUntrackedEdgeSite: (hostname: string) =>
    api.post<{ data: { removed: boolean; hostname: string } }>(
      endpoints.system.edgeUntrackedRemove,
      { hostname },
    ),

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

  /**
   * Native SSH-key file picker (Electron) - returns absolute path or null.
   *
   * Desktop-only on purpose: the API reads the key off ITS OWN filesystem, which
   * on desktop is this machine. On a remote/VPS instance the key lives on the
   * server, where no browser dialog can reach it — so the caller keeps the typed
   * path field and this returns null.
   */
  pickSshKeyFile: async (): Promise<string | null> => {
    const bridge = sshKeyBridge();
    return bridge ? bridge() : null;
  },

  /** Whether the native SSH-key picker is available (desktop shell only). */
  hasNativeFilePicker: (): boolean => !!sshKeyBridge(),

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

  /** Test SSH connection with credentials (without saving). */
  testConnection: (data: SshProbeInput) =>
    api.post<SshProbeResult>(endpoints.system.testConnection, data, {
      timeout: SSH_PROBE_TIMEOUT_MS,
    }),

  /** The same probe, pre-auth, for the onboarding wizard's first server. */
  onboardingTestConnection: (data: SshProbeInput) =>
    api.post<SshProbeResult>(endpoints.system.onboardingTestConnection, data, {
      timeout: SSH_PROBE_TIMEOUT_MS,
    }),

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

  /** Is a container image swap (edge/mail) running for this server? (re-attach) */
  getContainerApplySession: (serverId: string, component: "edge" | "mail") =>
    api.get<ContainerApplySessionInfo>(
      endpoints.system.serverContainerApplySession(serverId, component),
    ),

  // ── Servers CRUD ─────────────────────────────────────────────────────────

  /** List all configured servers */
  listServers: () =>
    api.get<ServerInfo[]>(endpoints.system.servers),

  /** Get a single server by ID */
  getServerById: (id: string) =>
    api.get<ServerInfo>(endpoints.system.server(id)),

  /**
   * Lightweight liveness probe for the list view (TCP reachability).
   *
   * `target` is the address the API actually dials — for THIS box that's the
   * container→host SSH bridge, not the row's display `sshHost`, so never show
   * `sshHost` as the thing that didn't answer (#490).
   */
  probeReachability: (id: string) =>
    api.get<ServerReachability>(endpoints.system.serverReachability(id)),

  /** Create a new server */
  createServerEntry: (data: Record<string, unknown>) =>
    api.post<ServerInfo>(endpoints.system.servers, data),

  /** Update a server */
  updateServerEntry: (id: string, data: Record<string, unknown>) =>
    api.patch<ServerInfo>(endpoints.system.server(id), data),

  /** What "Remove server" is about to take with it — every project/app bound to the
   *  box plus the server-scoped records that cascade. Read-only; safe on modal open. */
  serverDeletionPreview: (id: string) =>
    api.get<{ ok: boolean; preview: ServerDeletionPreview }>(
      endpoints.system.serverDeletionPreview(id),
    ),

  /**
   * Remove a server, resolving the fate of every workload bound to it.
   *
   * `destroyOnSource` is the operator's explicit opt-in to stop and delete the
   * containers on the machine; without it the workloads are removed from Openship
   * only and keep running. Flags travel as query params (same idiom as
   * `projectsApi.delete`), and the timeout scales with the workload count because
   * each teardown is its own SSH round-trip — a short client timeout would abort a
   * request the server then finishes anyway.
   */
  deleteServerEntry: (
    id: string,
    opts: { destroyOnSource?: boolean; workloadCount?: number } = {},
  ) => {
    const qs = opts.destroyOnSource ? "?destroyOnSource=true" : "";
    return api.delete<ServerRemovalResult>(`${endpoints.system.server(id)}${qs}`, {
      timeout: serverRemovalTimeoutMs(opts),
    });
  },

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

  // ── Managed-container updates (edge / mail, per-server) ─────────────────────

  /** Cached edge/mail image drift for a server. */
  listServerContainers: (serverId: string) =>
    api.get<ServerContainerStatus[]>(endpoints.system.serverContainers(serverId)),

  /** Re-probe the server now and refresh the container drift cache. */
  scanServerContainers: (serverId: string) =>
    api.post<{ ok: boolean; containers: unknown[] }>(
      endpoints.system.serverContainersScan(serverId),
      {},
    ),

  /**
   * Swap a server's edge/mail container onto the pinned image, streaming
   * progress via POST + SSE (fetch ReadableStream, same shape as mail setup).
   * Idempotent per (server, component): a second call while a swap is in flight
   * re-attaches to the running session and replays its steps + logs. Resolves
   * when the stream ends; `onEvent` receives each parsed frame.
   */
  streamApplyServerContainer: async (
    serverId: string,
    component: "edge" | "mail",
    onEvent: (event: ContainerApplyEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const url = new URL(endpoints.system.serverContainerApply(serverId, component), getApiBaseUrl());
    // Direct fetch bypasses the api client, so attach the active org header
    // ourselves (a stale cookie in a multi-tab session can resolve the wrong org).
    const orgId = getActiveOrganizationId();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (orgId) headers["X-Organization-Id"] = orgId;

    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers,
      body: "{}",
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Update failed: ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let eventData = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData = line.slice(5).trim();
        } else if (line === "" && eventType) {
          try {
            const parsed = eventData ? JSON.parse(eventData) : {};
            onEvent({ event: eventType, ...parsed } as ContainerApplyEvent);
          } catch {
            // Skip malformed frames.
          }
          eventType = "";
          eventData = "";
        }
      }
    }
  },

  /** Read the instance-wide auto-update-infra toggle (from /system/settings). */
  getInfraAutoUpdate: async (): Promise<boolean> => {
    const s = await api.get<InstanceSettings>(endpoints.system.settings);
    return Boolean(s.autoUpdateInfra);
  },

  /** Set the instance-wide auto-update-infra toggle. */
  setInfraAutoUpdate: (enabled: boolean) =>
    api.patch<{ ok: boolean }>(endpoints.system.settings, { autoUpdateInfra: enabled }),

  /** Read the instance-wide auto-scan-infra toggle (default on when unset). */
  getInfraAutoScan: async (): Promise<boolean> => {
    const s = await api.get<InstanceSettings>(endpoints.system.settings);
    return s.autoScanInfra ?? true;
  },

  /** Set the instance-wide auto-scan-infra toggle. */
  setInfraAutoScan: (enabled: boolean) =>
    api.patch<{ ok: boolean }>(endpoints.system.settings, { autoScanInfra: enabled }),

  /**
   * Read the host-control state (#527): the stored override plus what it
   * effectively resolves to right now. `effective` is what the toggle shows;
   * `stored === null` means "no instance override, the env default governs" and
   * lets the UI note when the env is what's holding it off.
   */
  getHostControl: async (): Promise<{ stored: boolean | null; effective: boolean }> => {
    const s = await api.get<InstanceSettings>(endpoints.system.settings);
    return { stored: s.hostControl ?? null, effective: Boolean(s.hostControlEffective) };
  },

  /**
   * Set the host-control override. Accepts a boolean to pin it, or null to clear
   * the override and follow the env default again. The API hard-gates this to the
   * box-owning org's owner (403 otherwise) — only they may make this box a
   * host-root deploy target.
   */
  setHostControl: (enabled: boolean | null) =>
    api.patch<{ ok: boolean }>(endpoints.system.settings, { hostControl: enabled }),

  /** Org-wide managed-container drift summary for the home nudge. */
  containersBehind: () =>
    api.get<{ servers: number; components: number }>(endpoints.system.containersBehind()),

  /** Org-wide actionable-issue rollup (edge down / absent-with-projects) for the
   *  attention dot + home surface. Cheap (read from cache), safe on every render. */
  containerIssues: () =>
    api.get<ContainerIssues>(endpoints.system.containersIssues()),

  /** Every org server with its cached edge/mail rows — the global infra view. */
  listAllContainers: () =>
    api.get<ServerContainerGroup[]>(endpoints.system.allContainers()),

  /** Detect-only refresh across every org server, then return the grouped view. */
  scanAllContainers: () =>
    api.post<ServerContainerGroup[]>(endpoints.system.allContainersScan(), {}, { timeout: 120_000 }),

  /**
   * Update every behind container and/or restart every stopped one across the org.
   * Targets are derived from the cache SERVER-side; `intents` only picks which
   * classes to act on. Returns as soon as the targets are classified — the applies
   * run as per-server sessions the rows render as "Updating…" and a click
   * re-attaches to for live logs.
   *
   * Same 120 s budget as the scan, NOT the 15 s default: classifying edge REPAIRS
   * pre-probes 80/443 over SSH on each stopped box, which can outlast 15 s on a
   * larger fleet. An abort here wouldn't cancel the applies — it would just report
   * a failure for work that's already running.
   */
  applyAllContainers: (intents?: ContainerApplyIntent[]) =>
    api.post<BulkApplyResult>(endpoints.system.allContainersApply(), intents ? { intents } : {}, {
      timeout: 120_000,
    }),

  /**
   * Live progress for every apply the org has in flight, plus the ones that settled
   * in the last minute or so. Cheap (cached rows + in-memory sessions) — polled only
   * while something is running.
   */
  applyingContainers: () =>
    api.get<ContainerApplyProgress>(endpoints.system.allContainersApplying()),

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
