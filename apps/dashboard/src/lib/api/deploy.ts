import { api } from "./client";
import { endpoints } from "./endpoints";
import type { StackId, ComposeAdvanced, RoutingConfig } from "@repo/core";
import type { CloudResourceTier, CloudResourceCustom, PublicEndpoint, PortCheckUI, OutputCheckUI } from "@/context/deployment/types";

export type PrepareProjectSource =
  | { source?: "github"; owner: string; repo: string; branch?: string; force?: string | boolean }
  // GitLab: pass numeric project id as installationId (or projectId).
  | {
      source: "gitlab";
      owner: string;
      repo: string;
      branch?: string;
      projectId?: number;
      installationId?: number;
      force?: string | boolean;
    }
  | { source: "local"; path: string };

export interface PrepareComposeService {
  name: string;
  image?: string;
  build?: string;
  dockerfile?: string;
  ports: string[];
  dependsOn: string[];
  environment: Record<string, string>;
  environmentMeta?: Record<
    string,
    {
      source: "env-file" | "default" | "missing" | "interpolated";
      variable?: string;
      defaultValue?: string;
      resolvedValue: string;
      expression?: string;
    }
  >;
  volumes: string[];
  command?: string;
  restart?: string;
  advanced?: ComposeAdvanced;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
  /** Multi-route: additional public routes (one per port). Reuses the shared
   *  PublicEndpoint shape so the routing card edits them directly; entry[0]
   *  mirrors the scalar exposedPort/domain above. */
  publicEndpoints?: PublicEndpoint[];
}

export interface PrepareAppConfig {
  stack: StackId;
  projectType: "app" | "docker" | "services" | "monorepo";
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  rootDirectory: string;
  productionPaths: string[];
  port: number;
  hasServer: boolean;
  hasBuild: boolean;
}

export type PrepareSingleAppCandidate = PrepareAppConfig;

/** One deployable sub-app discovered inside a monorepo. */
export interface PrepareMonorepoApp {
  id: string;
  name: string;
  rootDirectory: string;
  stack: StackId;
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  productionPaths: string[];
  port: number;
}

/** Shared workspace metadata when the repo root declares pnpm/npm/yarn workspaces. */
export interface PrepareMonorepoWorkspace {
  packageManager: string;
  /**
   * Initial suggested prepare command — runs ONCE at the repo root
   * before per-app builds. Detector seeds with the workspace install;
   * user can chain codegen / schema sync with `&&`.
   */
  prepareCommand: string;
}

export interface PrepareProjectResponse extends PrepareAppConfig {
  repository: {
    name: string;
    full_name: string;
    owner?: { login: string };
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: Array<{ name: string }>;
  };
  singleAppCandidate?: PrepareSingleAppCandidate;
  services?: PrepareComposeService[];
  monorepoApps?: PrepareMonorepoApp[];
  monorepoWorkspace?: PrepareMonorepoWorkspace;
  rootEnv?: Record<string, string>;
  /** Routing config parsed from the repo's vercel.json (persisted on the project). */
  routing?: RoutingConfig;
  // ── Declared overlay (repo-root openship.json) — present only when the repo
  //    ships the file. Seed wizard defaults; absent → detection is unchanged. ──
  /** Declared serve mode ("static" ⇒ no server). Seeds `options.hasServer`. */
  productionMode?: "host" | "static" | "standalone";
  /** Declared runtime isolation. Seeds `runtimeMode` for a brand-new deploy. */
  runtimeMode?: "bare" | "docker";
  /** Declared project domains, normalized to the create shape. Seed endpoints. */
  publicEndpoints?: Array<{
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
    port?: number;
    targetPath?: string;
  }>;
  /** Declared cloud sizing (tier OR explicit cpu/mem/disk). Seeds resource tier. */
  resources?: { tier?: "micro" | "low" | "medium" | "high"; cpuCores?: number; memoryMb?: number; diskMb?: number };
  error?: string;
  current_status?: string;
  exists?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Deploy / Build API                                                */
/* ------------------------------------------------------------------ */

export const deployApi = {
  /** List all deployments for the authenticated user */
  getAll: (opts?: { page?: number; perPage?: number }) =>
    api.get<any>(endpoints.deploy.list, { params: opts }),

  /** Cancel a deployment */
  cancel: (id: string) =>
    api.post<any>(endpoints.deploy.cancel(id)),

  /** Delete a deployment */
  deleteDeployment: (id: string) =>
    api.delete<any>(endpoints.deploy.delete(id)),

  /** Reject a partial deployment and restore previous active deployment if available */
  reject: (id: string) =>
    api.post<any>(endpoints.deploy.reject(id)),

  /** Keep (confirm) a partial deployment that is awaiting a decision — clears
   *  the pending marker so it stops reading as "Action Required". */
  keep: (id: string) =>
    api.post<any>(endpoints.deploy.keep(id)),

  /** Dismiss an advisory port-check for `target` (the exposed port for a
   *  single-app, or the service id for a compose service) so it won't re-nag
   *  after a refresh. */
  skipPortCheck: (id: string, target: number | string) =>
    api.post<any>(endpoints.deploy.skipPortCheck(id), { target }),

  /** Live, on-demand port-reachability audit of a PROJECT's active deployment
   *  (advisory) — powers the Domains tab's "port not reachable" hint. */
  checkPorts: (projectId: string) =>
    api.post<{ data: PortCheckUI[] }>(endpoints.projects.portCheck(projectId)),

  /** Live, on-demand static-output audit of a PROJECT's active deployment
   *  (advisory; static apps) — powers the Domains tab's "no output at path" hint. */
  checkOutput: (projectId: string) =>
    api.post<{ data: OutputCheckUI[] }>(endpoints.projects.outputCheck(projectId)),

  /** Roll back to a previous successful deployment. The orchestrator
   *  validates artifact-retained + not-already-active before swapping. */
  rollback: (id: string) =>
    api.post<any>(endpoints.deploy.rollback(id)),

  /** Pin / unpin a deployment. Pinned deployments are exempt from the
   *  retention prune — their artifact stays rollback-restorable
   *  indefinitely. Hard-capped at 10 per project. */
  pin: (id: string, pinned: boolean) =>
    api.post<any>(`deployments/${id}/pin`, { pinned }),

  /** Trigger a redeploy. Pass `useExistingCommit: true` to rebuild from
   *  the SAME commit SHA the old deployment used (fallback path when the
   *  rollback artifact has been pruned). Omitting it (or passing false)
   *  rebuilds against the latest commit on the branch — the default
   *  "redeploy" semantic. */
  redeploy: (id: string, opts?: { useExistingCommit?: boolean }) =>
    api.post<any>(`deployments/${id}/redeploy`, opts ?? {}),

  /**
   * Project-level deploy trigger. Used by the "Force redeploy (rebuild
   * all services)" button — passing `forceAll: true` overrides the
   * webhook's smart per-service routing and rebuilds every enabled
   * service. The branch / commit are resolved server-side from the
   * project's git settings.
   */
  trigger: (body: {
    projectId: string;
    branch?: string;
    commitSha?: string;
    environment?: string;
    forceAll?: boolean;
    serviceIds?: string[];
    /** Smart per-service routing for a manual multi-service redeploy: rebuild
     *  only the services whose files changed since the active deployment. */
    smartRoute?: boolean;
    /** Refresh: re-apply the current env to the active deployment — no git
     *  pull, no rebuild. Recreates env-changed services from their existing
     *  images. */
    refresh?: boolean;
  }) =>
    // Longer timeout than the 15s default: the trigger does synchronous git/DNS
    // pre-work (and proxies to the SaaS for cloud projects) before returning the
    // new deployment id, and losing that id means losing the redirect.
    api.post<any>("deployments", body, { timeout: 60_000 }),

  /** Resolve project info from GitHub repo or local path - detects stack */
  prepare: (body: PrepareProjectSource) =>
    api.post<PrepareProjectResponse>(endpoints.deploy.prepare, body),

  /** Create deployment + build session for an existing project */
  buildAccess: (payload: {
    projectId: string;
    branch?: string;
    environment?: string;
    envVars?: Record<string, string>;
    publicEndpoints?: Array<{
      port?: string;
      targetPath?: string;
      domain: string;
      customDomain: string;
      domainType: "free" | "custom";
    }>;
    buildStrategy?: "server" | "local";
    deployTarget?: "local" | "server" | "cloud";
    serverId?: string;
    /** Folder-upload deploy: adopt the uploaded source (workspace / staging dir). */
    uploadSessionId?: string;
    runtimeMode?: "bare" | "docker";
    serviceDeploymentMode?: "services" | "single";
    services?: Array<{
      name: string;
      image?: string;
      build?: string;
      dockerfile?: string;
      ports?: string[];
      dependsOn?: string[];
      environment?: Record<string, string>;
      volumes?: string[];
      command?: string;
      restart?: string;
      exposed?: boolean;
      exposedPort?: string;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
    }>;
    cloudResourceTier?: CloudResourceTier;
    cloudResourceCustom?: CloudResourceCustom;
    /** Desktop-only, per-deploy: forward the local `gh` identity for an
     *  on-server clone (relay). The API enforces desktop + server-build gating. */
    forwardGitCredentials?: boolean;
    /** Per-deploy clone location for a server target. "server" clones on the
     *  build host (relay on desktop, token otherwise); default clones on the
     *  API host and transfers. The API gates + falls back as needed. */
    cloneStrategy?: "api-host" | "server";
  }) =>
    api.post<any>(endpoints.deploy.buildAccess, payload),

  /** Poll build status */
  getBuildStatus: (deploymentId: string) =>
    api.get<any>(endpoints.deploy.buildStatus(deploymentId)),

  /** Start a build by deployment ID */
  buildStart: (deployment_id: string) =>
    api.post<any>(endpoints.deploy.buildStart(deployment_id)),

  /** Re-deploy an existing deployment */
  buildRedeploy: (deployment_id: string) =>
    api.post<any>(endpoints.deploy.buildRedeploy(deployment_id)),

  /** Check SSL certificate status for a domain */
  sslStatus: (domain: string) =>
    api.post<any>(endpoints.deploy.sslStatus, { domain }),

  /** Renew SSL certificate */
  sslRenew: (domain: string, includeWww = false) =>
    api.post<any>(endpoints.deploy.sslRenew, { domain, includeWww }),

  /** Respond to a pipeline prompt (e.g. port conflict) */
  buildRespond: (deploymentId: string, action: string) =>
    api.post<any>(endpoints.deploy.buildRespond(deploymentId), { action }),
};
