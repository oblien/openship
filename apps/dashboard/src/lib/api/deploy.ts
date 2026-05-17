import { api } from "./client";
import { endpoints } from "./endpoints";
import type { StackId } from "@repo/core";

export type PrepareProjectSource =
  | { source?: "github"; owner: string; repo: string; branch?: string; force?: string | boolean }
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
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
}

export interface PrepareAppConfig {
  stack: StackId;
  projectType: "app" | "docker" | "services";
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
  rootEnv?: Record<string, string>;
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

  /** Roll back to a previous successful deployment */
  rollback: (id: string) =>
    api.post<any>(endpoints.deploy.rollback(id)),

  /** Resolve project info from GitHub repo or local path — detects stack */
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
