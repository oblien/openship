import { api } from "./client";
import type { PrepareComposeService, PrepareProjectResponse } from "./deploy";
import type { RoutingConfig, RouteRuleSpec, ProxySettings, OpenshipReadiness } from "@repo/core";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Projects API                                                      */
/* ------------------------------------------------------------------ */

/**
 * One thing waiting on a human. Mirrors `PendingAction` in the API's
 * pending-actions.service — the item carries its own resolutions, so the UI
 * renders buttons from data instead of hard-coding which call fixes what.
 */
export interface PendingActionResolution {
  label: string;
  destructive?: boolean;
  method: "POST" | "DELETE";
  /** Concrete, params already substituted (e.g. /api/deployments/dep_1/redeploy). */
  path: string;
  body?: Record<string, unknown>;
}

export interface PendingAction {
  id: string;
  kind:
    | "deploy_blocked"
    | "prompt"
    | "partial_decision"
    | "routing_unsynced"
    | "domain_unverified"
    | "ssl_error"
    | "port_advisory";
  /** `advisory` items are hints, never escalated to blockers. */
  severity: "action_required" | "advisory";
  title: string;
  message: string;
  details?: Record<string, unknown>;
  /** Only on `prompt` — when the held deploy gives up and aborts. */
  expiresAt?: string;
  resolveWith: PendingActionResolution[];
}

/** Rollback retention as the API reports it. `source` says where `window` came
 *  from: an explicit operator override, the disk-sized auto value measured at the
 *  last deploy, or the instance default when nothing has been measured yet. */
export interface RollbackCapacityUI {
  window: number;
  source: "explicit" | "auto" | "instance-default";
  explicit: number | null;
  snapshotSizeBytes: number | null;
  measuredAt: string | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  maxWindow: number;
  diskBudgetFraction: number;
  strategy: string;
}

/** Build + runtime options accepted by POST /:id/options (updateOptions). All
 *  optional — only the fields sent are written. Mirrors the backend allowlist. */
export interface ProjectOptionsBody {
  framework?: string;
  packageManager?: string;
  buildImage?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  productionPaths?: string;
  /** Persistent mounts. `null` clears the override and restores the framework's
   *  defaults; `[]` turns persistence off. */
  volumes?: string[] | null;
  rootDirectory?: string;
  /** Compose file location (file or directory); "" / null clears the pin. */
  composePath?: string | null;
  productionPort?: number;
  productionMode?: string;
  hasServer?: boolean;
  hasBuild?: boolean;
  runtimeMode?: "bare" | "docker";
}

/** A bucket bound to a project, as returned by the API (never any credentials —
 *  those live in the project's encrypted env store). */
export interface ObjectStorageBinding {
  provider: string;
  endpoint?: string | null;
  region?: string | null;
  bucket: string;
  forcePathStyle?: boolean | null;
  sourceProjectId?: string | null;
  envKeys: string[];
  boundAt: string;
}

export interface ObjectStorageProviderSpec {
  id: string;
  label: string;
  endpointPlaceholder: string;
  defaultRegion: string;
  forcePathStyle: boolean;
}

export interface ObjectStorageView {
  binding: ObjectStorageBinding | null;
  /** Local persistent mounts — declared (null = inheriting) and resolved. */
  volumes: string[] | null;
  resolvedVolumes: string[];
  envPreset: string;
  envKeys: string[];
  candidates: Array<{
    projectId: string;
    name: string;
    appTemplateId: string | null;
    defaultBucket: string;
  }>;
  providers: Record<string, ObjectStorageProviderSpec>;
}

/** Bind body: either `sourceProjectId` (an installed storage app) or an explicit
 *  provider + credentials. `bucket` is required either way. */
export interface BindObjectStorageBody {
  bucket: string;
  sourceProjectId?: string;
  mode?: "internal" | "public";
  provider?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface ScanProjectResponse {
  success: boolean;
  name: string;
  path: string;
  stack: PrepareProjectResponse["stack"];
  projectType: PrepareProjectResponse["projectType"];
  category: PrepareProjectResponse["category"];
  packageManager: PrepareProjectResponse["packageManager"];
  installCommand: PrepareProjectResponse["installCommand"];
  buildCommand: PrepareProjectResponse["buildCommand"];
  startCommand: PrepareProjectResponse["startCommand"];
  buildImage: PrepareProjectResponse["buildImage"];
  outputDirectory: PrepareProjectResponse["outputDirectory"];
  rootDirectory: PrepareProjectResponse["rootDirectory"];
  productionPaths: PrepareProjectResponse["productionPaths"];
  port: PrepareProjectResponse["port"];
  services?: PrepareComposeService[];
}

/** A route_rule row as returned by the API. */
export interface RouteRuleRow {
  id: string;
  projectId: string;
  domainId: string | null;
  pathPrefix: string | null;
  spec: RouteRuleSpec;
  enabled: boolean;
}

/**
 * One proxy directive's saved-vs-served state, from GET projects/:id/edge-config.
 *
 * `liveRaw` exists separately from `live` because a vhost can legally hold a value
 * our validators reject (`20M`, `1d`): the UI must show what the box serves even
 * when it isn't adoptable, rather than reporting "not set" for a value that is set.
 */
export interface EdgeDirectiveState {
  key: string;
  directive: string;
  group: string;
  expected?: string | number | boolean;
  live?: string | number | boolean;
  liveRaw?: string;
  drift: boolean;
}

export interface EdgeConfigHostState {
  hostname: string;
  found: boolean;
  tls: boolean;
  directives: EdgeDirectiveState[];
  adoptable: ProxySettings;
  driftCount: number;
}

/** `reachable: false` = we couldn't read the box, NOT "no drift". */
export interface EdgeConfigReport {
  reachable: boolean;
  proxyKind?: string;
  ours?: boolean;
  nginxVersion?: string;
  saved: ProxySettings;
  hosts: EdgeConfigHostState[];
  error?: string;
}

/** A service_incident row as returned by the API (Health tab). */
export interface ServiceIncidentRow {
  id: string;
  projectId: string | null;
  serviceId: string | null;
  serviceKey: string;
  serviceName: string;
  serverId: string | null;
  containerId: string | null;
  kind: "down" | "crash_loop" | "unhealthy" | "server_unreachable";
  status: "open" | "resolved";
  reason: string | null;
  exitCode: number | null;
  restartCount: number;
  oomKilled: boolean;
  logExcerpt: string | null;
  openedAt: string;
  resolvedAt: string | null;
  lastSeenAt: string;
}

/** Body for creating / updating a route rule. */
export interface RouteRuleInput {
  domainId?: string | null;
  pathPrefix?: string | null;
  spec?: RouteRuleSpec;
  enabled?: boolean;
}

export const projectsApi = {
  /** Dashboard overview - projects list + stats numbers */
  getHome: () =>
    api.get<{ success: boolean; projects: any[]; numbers: Record<string, number> }>(
      endpoints.projects.home,
    ),

  /** Create or update a project (mandatory before build access) */
  ensure: (body: {
    projectId?: string;
    name: string;
    /** Rollback retention picked in the wizard before the project existed.
     *  `null` window = size it from the deploy host's free disk. */
    rollbackWindow?: number | null;
    defaultRollbackStrategy?: "git" | "snapshot";
    slug?: string;
    gitOwner?: string;
    /** Source discriminator; "upload" for browser folder-upload projects. */
    gitProvider?: string;
    gitRepo?: string;
    gitBranch?: string;
    framework?: string;
    localPath?: string;
    packageManager?: string;
    installCommand?: string;
    buildCommand?: string;
    outputDirectory?: string;
    productionPaths?: string;
    rootDirectory?: string;
    /** Compose file location, for a compose file outside the detected root. */
    composePath?: string;
    startCommand?: string;
    buildImage?: string;
    port?: number;
    publicEndpoints?: Array<{
      port?: number;
      targetPath?: string;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
    }>;
    hasServer?: boolean;
    hasBuild?: boolean;
    /** Project flavor - "monorepo" persists the sub-app + workspace fields below. */
    projectType?: "app" | "docker" | "services" | "monorepo";
    monorepoApps?: Array<{
      name: string;
      rootDirectory: string;
      framework?: string;
      packageManager?: string;
      buildImage?: string;
      installCommand?: string;
      buildCommand?: string;
      startCommand?: string;
      outputDirectory?: string;
      port?: number;
      enabled?: boolean;
      exposed?: boolean;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
      environment?: Record<string, string>;
    }>;
    monorepoWorkspace?: {
      packageManager: string;
      /** Shell command run ONCE at the repo root before per-app builds. */
      prepareCommand?: string;
    };
    /** Routing config parsed from the repo's vercel.json (opaque passthrough). */
    routingConfig?: RoutingConfig | null;
    /**
     * Deploy-time readiness gate. Omitted/null = OFF (the default) — the deploy
     * does no post-start waiting. Opaque passthrough to the project column.
     */
    readiness?: OpenshipReadiness | null;
  }) => api.post<any>(endpoints.projects.ensure, body),

  /** List local projects only */
  getLocal: () => api.get<{ success: boolean; projects: any[] }>(endpoints.projects.local),

  /** Scan a local directory for framework detection */
  scan: (path: string) =>
    api.post<ScanProjectResponse>(endpoints.projects.scan, { path }),

  /** Import a local folder as a project */
  importLocal: (data: {
    name: string;
    localPath: string;
    framework?: string;
    packageManager?: string;
    buildCommand?: string;
    installCommand?: string;
    outputDirectory?: string;
    rootDirectory?: string;
    startCommand?: string;
    productionPaths?: string;
    buildImage?: string;
    port?: number;
    hasServer?: boolean;
    hasBuild?: boolean;
  }) => api.post<{ data: any }>(endpoints.projects.import, data),

  /** Delete a local project */
  deleteLocal: (id: string) => api.delete<{ message: string }>(`projects/${id}`),

  /** Single project info */
  getInfo: (id: string | number) => api.get<any>(endpoints.projects.info(id)),

  /** List sibling environments for the same app/repo */
  getEnvironments: (id: string | number) =>
    api.get<{ success: boolean; data: any[] }>(endpoints.projects.environments(id)),

  /** Create an isolated project environment under the same app/repo */
  createEnvironment: (
    id: string | number,
    body: {
      environmentName: string;
      environmentSlug?: string;
      environmentType?: "production" | "preview" | "development";
      gitBranch?: string;
      sourceMode?: "branch" | "manual";
    },
  ) =>
    api.post<{ success: boolean; data?: any; error?: string }>(
      endpoints.projects.environments(id),
      body,
    ),

  /** Delete a project app or a single environment.
   *  `wipeVolumes=true` ALSO removes Docker named volumes attached to the
   *  project's containers - destroys persistent data (DBs, caches, etc.).
   *  Default is false: data survives so the user can recover.
   *  `force=true` cancels in-flight deployments / backups / restores
   *  before tearing down; default refuses with 409 when active work
   *  exists so the user can wait or cancel.
   *  `forceOrphan=true` drops the row even when a resource on a REACHABLE
   *  server keeps failing to destroy (records it for GC). Resources on an
   *  UNREACHABLE server are always orphaned regardless — enforced delete. */
  delete: (
    id: string | number,
    body: {
      deleteApp?: boolean;
      wipeVolumes?: boolean;
      force?: boolean;
      forceOrphan?: boolean;
      /** Record-only: drop the Openship row, keep the server workload (self-hosted). */
      recordOnly?: boolean;
    } = {},
  ) => {
    const { force, forceOrphan, recordOnly, ...rest } = body;
    const query = new URLSearchParams();
    if (force) query.set("force", "true");
    if (forceOrphan) query.set("forceOrphan", "true");
    if (recordOnly) query.set("recordOnly", "true");
    const qs = query.toString();
    const path = qs ? `${endpoints.projects.item(id)}?${qs}` : endpoints.projects.item(id);
    // Teardown destroys containers/images/volumes over SSH (round-trips + per-
    // resource server-side timeouts) — far longer than the 15s default. A short
    // client timeout aborts the fetch mid-teardown (server still finishes, so
    // the project vanishes) and surfaces a spurious AbortError.
    return api.delete<any>(path, { body: rest, timeout: 120_000 });
  },

  /** Read-only snapshot of what `delete(id)` will remove - services and their
   *  named volumes, project networks. Cheap, safe to call on modal open. */
  deletionPreview: (id: string | number) =>
    api.get<{
      success: boolean;
      preview: {
        projectId: string;
        projectName: string;
        selfHosted: boolean;
        services: Array<{
          id: string;
          name: string;
          image: string | null;
          volumes: string[];
          hasContainer: boolean;
        }>;
        deploymentVolumes: string[];
        networks: string[];
        totalVolumes: number;
      };
    }>(`${endpoints.projects.item(id)}/deletion-preview`),

  /** Update name or description — pass any subset of TUpdateProjectBody fields. */
  update: (id: string | number, fields: Record<string, unknown>) =>
    api.patch<any>(endpoints.projects.item(id), fields),

  /**
   * Read-only edge health for the project's server: is OpenResty already the
   * edge on 80/443 (`ready`/`classification === "ours"`), or does it need setup?
   * `reachable:false` = the box didn't answer a fast connect probe (offline).
   */
  getEdgeStatus: (id: string | number) =>
    api.get<{
      ready: boolean;
      reachable?: boolean | null;
      classification?: "free" | "ours" | "known" | "unknown";
      canProceedClean?: boolean;
      managed?: "cloud";
      reason?: string;
      occupants?: Array<{ port: number; proxy: string | null; label: string | null }>;
    }>(endpoints.projects.edgeStatus(id)),

  /**
   * Get the per-project clone-token state. Returns only `{ hasToken, setAt }`
   * - never the token itself.
   */
  getCloneToken: (id: string | number) =>
    api.get<{ hasToken: boolean; setAt: string | null }>(endpoints.projects.cloneToken(id)),

  /**
   * Set/replace/clear the per-project clone token override. Highest priority
   * in `resolveCloneToken`'s chain - used when the user wants a Fine-Grained
   * PAT scoped to just this repo.
   *   - token: null/empty → clear
   *   - token: string     → encrypt + store
   */
  updateCloneToken: (id: string | number, body: { token: string | null }) =>
    api.patch<{ hasToken: boolean; setAt: string | null }>(
      endpoints.projects.cloneToken(id),
      body,
    ),


  /**
   * Update build + runtime options (any subset). Also the atomic config-save
   * the deploy wizard's mode=config uses — backend updateOptions writes only the
   * fields present, in one project row update; it never touches env/git/domains.
   */
  setOptions: (id: string | number, options: ProjectOptionsBody) =>
    api.post<any>(endpoints.projects.options(id), options),

  /** Object storage: the bucket bound to this project's filesystem config, plus
   *  the installed apps and providers it could be bound to. */
  getObjectStorage: (id: string | number) =>
    api.get<{ data: ObjectStorageView }>(endpoints.projects.storage(id)),

  /** Bind a bucket — an installed MinIO app (`sourceProjectId`) or an external
   *  provider. Verified server-side before any env is written. */
  bindObjectStorage: (id: string | number, body: BindObjectStorageBody) =>
    api.post<{ data: { binding: ObjectStorageBinding; requiresRedeploy: true } }>(
      endpoints.projects.storage(id),
      body,
    ),

  /** Remove the binding and the env vars it injected. */
  unbindObjectStorage: (id: string | number) =>
    api.delete<{ data: { removed: boolean } }>(endpoints.projects.storage(id)),

  /** Source-drift status for the "project outdated" banner. `mode` discriminates:
   *  "commit" (git HEAD vs deployed sha) or "release" (newest advertised version
   *  vs the deployed release version). */
  getCommitStatus: (id: string | number) =>
    api.get<{
      data: {
        supported: boolean;
        mode?: "commit" | "release";
        behind?: boolean;
        /** True when the latest commit/version is already building/deploying. */
        latestInProgress?: boolean;
        /* commit mode */
        branch?: string;
        latestSha?: string | null;
        latestMessage?: string | null;
        deployedSha?: string | null;
        /* release mode */
        latestVersion?: string | null;
        currentVersion?: string | null;
        pinned?: boolean;
      };
    }>(`projects/${id}/commit-status`),

  /** Enable or disable a project */
  toggle: (id: string | number, enable: boolean) =>
    api.post<any>(endpoints.projects.toggle(id, enable ? "enable" : "disable")),

  /** Retry the free .opsh.io edge-route sync (no rebuild). ok:false + warning
   *  when it still can't sync; clears the routing warning on success. */
  retryRouting: (id: string | number) =>
    api.post<{ ok: boolean; warning?: string; error?: string }>(endpoints.projects.retryRouting(id)),

  /**
   * Everything waiting on a human for this project — a blocked deploy, a deploy
   * held on a decision, a keep/reject, unsynced routing, unverified domains,
   * broken certs, plus port advisories. Each item carries `resolveWith`: the
   * concrete calls that resolve it.
   *
   * On-demand (not on the project read), same as getCommitStatus / checkPorts.
   */
  getPendingActions: (id: string | number) =>
    api.get<{ data: { actions: PendingAction[] } }>(endpoints.projects.pendingActions(id)),

  /** Clear CDN / proxy cache */
  clearCache: (id: string | number) => api.post<any>(endpoints.projects.clearCache(id)),

  /** Clear build artifacts */
  clearBuild: (id: string | number) => api.post<any>(endpoints.projects.clearBuild(id)),

  /** Container incidents recorded by the health watch. `watching: false` means
   *  the watch job is off — an empty list then proves nothing. */
  listIncidents: (id: string | number) =>
    api.get<{
      open: ServiceIncidentRow[];
      resolved: ServiceIncidentRow[];
      historyDays: number;
      serverUnreachable: ServiceIncidentRow | null;
      watching: boolean;
    }>(endpoints.projects.incidents(id)),

  /**
   * What the edge is ACTUALLY serving for this project's hostnames, next to what
   * the project saved. Read-only; `reachable: false` when the box can't be read
   * (which is not the same as "no drift"). Self-hosted only.
   */
  getEdgeConfig: (id: string | number) =>
    api.get<EdgeConfigReport>(endpoints.projects.edgeConfig(id)),

  /* ── Route rules (self-hosted edge: rate-limit / ban / allow-deny) ── */
  listRouteRules: (id: string | number) =>
    api.get<{ rules: RouteRuleRow[] }>(endpoints.projects.routeRules(id)),
  createRouteRule: (id: string | number, body: RouteRuleInput) =>
    api.post<{ rule: RouteRuleRow }>(endpoints.projects.routeRules(id), body),
  updateRouteRule: (id: string | number, ruleId: string, body: RouteRuleInput) =>
    api.patch<{ rule: RouteRuleRow }>(endpoints.projects.routeRule(id, ruleId), body),
  deleteRouteRule: (id: string | number, ruleId: string) =>
    api.delete<{ success: boolean }>(endpoints.projects.routeRule(id, ruleId)),

  /** Create a new deployment session */
  createDeploymentSession: (id: string | number) =>
    api.post<any>(endpoints.projects.deploymentSession(id)),

  /** Connect a custom domain. `externalIngress` = TLS/ingress handled upstream
   *  (Cloudflare Tunnel / LB): verify via TXT only, no certbot, plain-HTTP route. */
  connectDomain: (
    id: string | number,
    body: { domain: string; includeWww: boolean; externalIngress?: boolean },
  ) => api.post<any>(endpoints.projects.connect(id), body),

  /**
   * MERGE env vars (partial): upsert + delete only the named keys, leaving every
   * other var (incl. untouched masked secrets) intact. The only project env
   * write — the destructive full-replace PUT was removed.
   */
  mergeEnv: (
    id: string | number,
    body: {
      environment: string;
      upserts: Array<{ key: string; value: string; isSecret?: boolean }>;
      deletes: string[];
    },
  ) => api.patch<{ upserted: number; deleted: number }>(endpoints.projects.env(id), body),

  /** Get environment variables (secret values returned masked) */
  getEnv: (id: string | number) =>
    api.get<{
      data: Array<{
        id: string;
        key: string;
        value: string;
        environment: string;
        isSecret: boolean;
      }>;
    }>(endpoints.projects.env(id)),

  /** Get git settings */
  getGit: (id: string | number) => api.get<any>(endpoints.projects.git(id)),

  /** Link a GitHub repo to an existing project + register webhook */
  linkRepo: (
    id: string | number,
    body: { owner: string; repo: string; branch?: string; installationId?: number },
  ) => api.post<any>(endpoints.projects.gitLink(id), body),

  /** List branches */
  getBranches: (id: string | number) => api.get<any>(endpoints.projects.branches(id)),

  /** Set active branch */
  setBranch: (id: string | number, branch: string) =>
    api.post<any>(endpoints.projects.branch(id), { branch }),

  /** Toggle auto-deploy setting */
  setAutoDeploy: (id: string | number, enabled: boolean) =>
    api.post<any>(endpoints.projects.autoDeploy(id), { enabled }),

  /** Set or clear the webhook domain */
  setWebhookDomain: (id: string | number, domain: string | null) =>
    api.post<any>(endpoints.projects.webhookDomain(id), { domain }),

  /** Read resources + the target machine's probed capacity (the ceiling for a
   *  custom value) + whether this target requires an explicit limit (cloud). */
  getResources: (id: string | number) => api.get<any>(endpoints.projects.resources(id)),

  /** Rollback retention: the window in force (explicit or disk-sized), the
   *  measured per-release size, and the deploy host's free disk. Everything is
   *  read from values measured at the last deploy plus a cached probe, so this
   *  is cheap enough to call whenever the retention control is shown. */
  getRollbackCapacity: (id: string | number) =>
    api.get<{ data: RollbackCapacityUI }>(endpoints.projects.rollbackCapacity(id)),

  /** Set resources (POST - tier-based) */
  setResources: (id: string | number, resources: Record<string, any>) =>
    api.post<any>(endpoints.projects.resources(id), resources),

  /** Update resources (PATCH - raw values). Backend registers PATCH/POST for
   *  /:id/resources (both bound to ctrl.updateResources); there is no PUT. */
  updateResources: (id: string | number, resources: Record<string, any>) =>
    api.patch<any>(endpoints.projects.resources(id), resources),

  /** Set sleep-mode */
  setSleepMode: (id: string | number, sleep_mode: string) =>
    api.post<any>(endpoints.projects.sleepMode(id), { sleep_mode }),

  /** List deployments for a project */
  getDeployments: (id: string | number) => api.get<any>(endpoints.projects.deployments(id)),
};
