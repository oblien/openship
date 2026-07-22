import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  GitLab Integration API                                            */
/* ------------------------------------------------------------------ */

export const gitlabApi = {
  /** GitLab home: connection state, namespaces, and projects in one call. */
  getHome: () => api.get<any>(endpoints.gitlab.home),

  /** Check GitLab connection status. */
  getStatus: () => api.get<any>(endpoints.gitlab.status),

  /**
   * Start a GitLab connection.
   *   - { mode: "oauth" } → redirect flow, kicks off Better Auth's GitLab OAuth.
   *   - { mode: "pat", token } → verify + store a personal access token.
   */
  connect: (body: { mode?: "oauth" | "pat"; token?: string }) =>
    api.post<any>(endpoints.gitlab.connect, body),

  /**
   * Disconnect a GitLab source.
   *   - "oauth" → unlink the Better Auth GitLab account
   *   - "pat"   → clear the stored personal access token
   *   - "all"   → both (default)
   */
  disconnect: (source: "oauth" | "pat" | "all" = "all") =>
    api.post<{ success: boolean; connected: boolean }>(endpoints.gitlab.disconnect, { source }),

  /** List GitLab namespaces (the user + their groups) available to the connected account. */
  listNamespaces: () => api.get<any>(endpoints.gitlab.namespaces),

  /** List GitLab projects, optionally scoped to a namespace and/or filtered by search text. */
  listProjects: (opts?: { namespace?: string; search?: string }) =>
    api.get<any>(endpoints.gitlab.projects, { params: opts }),

  /** Get a single GitLab project by its numeric project id. */
  getProject: (projectId: number | string) => api.get<any>(endpoints.gitlab.project(projectId)),

  /** List branches for a GitLab project. */
  getBranches: (projectId: number | string) => api.get<any>(endpoints.gitlab.branches(projectId)),

  /** Register a push webhook for a GitLab project. */
  registerWebhook: (projectId: number | string, body?: { projectId?: string }) =>
    api.post<any>(endpoints.gitlab.webhooks(projectId), body),

  /** Mint a short-lived clone token + ready-to-run clone URL for a GitLab project. */
  getCloneToken: (projectId: number | string, openshipProjectId?: string) =>
    api.get<{ success: boolean; token: string; username: string; cloneUrl: string; baseUrl: string }>(
      endpoints.gitlab.cloneToken(projectId),
      { params: openshipProjectId ? { projectId: openshipProjectId } : undefined },
    ),

  /** Parse a GitLab repo URL (HTTPS or SSH) into { owner, repo, host }. */
  parseUrl: (url: string) =>
    api.get<{ success: boolean; owner: string; repo: string; host: string; provider: "gitlab" }>(
      endpoints.gitlab.parseUrl,
      { params: { url } },
    ),
};
