import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Deploy / Build API                                                */
/* ------------------------------------------------------------------ */

export const deployApi = {
  /** Initialise a new deployment */
  init: (body: { owner: string; repo: string; force?: string | boolean }) =>
    api.post<any>(endpoints.deploy.init, body),

  /** Request build access token / start build */
  buildAccess: (payload: Record<string, any>) =>
    api.post<any>(endpoints.deploy.buildAccess, payload),

  /** Poll build status */
  getBuildStatus: (sessionId: string) =>
    api.get<any>(endpoints.deploy.buildStatus(sessionId)),

  /** Cancel a running build */
  buildCancel: (deployment_session_id: string) =>
    api.post<any>(endpoints.deploy.buildCancel, { deployment_session_id }),

  /** Re-deploy an existing build */
  buildRedeploy: (deployment_session_id: string) =>
    api.post<any>(endpoints.deploy.buildRedeploy, { deployment_session_id }),

  /** Get a short-lived token for SSE log streaming */
  getLogsAccess: (projectId: string | number) =>
    api.post<any>(endpoints.deploy.logsAccess, { projectId }),

  /** Check SSL certificate status for a domain */
  sslStatus: (domain: string) =>
    api.post<any>(endpoints.deploy.sslStatus, { domain }),

  /** Renew SSL certificate */
  sslRenew: (domain: string, includeWww = false) =>
    api.post<any>(endpoints.deploy.sslRenew, { domain, includeWww }),
};
