import { api } from "./client";
import { endpoints } from "./endpoints";

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

  /** Resolve project info from GitHub repo or local path — detects stack */
  prepare: (body:
    | { source?: "github"; owner: string; repo: string; force?: string | boolean }
    | { source: "local"; path: string }
  ) =>
    api.post<any>(endpoints.deploy.prepare, body),

  /** Create deployment + build session for an existing project */
  buildAccess: (payload: {
    projectId: string;
    branch?: string;
    environment?: string;
    envVars?: Record<string, string>;
    customDomain?: string;
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
};
