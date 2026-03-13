import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  GitHub Integration API                                            */
/* ------------------------------------------------------------------ */

export const githubApi = {
  /** Dashboard home — user info, orgs, recent repos */
  getUserHome: () => api.get<any>(endpoints.github.userHome),

  /** Repos for a specific GitHub org */
  getOrgRepos: (owner: string) =>
    api.get<any>(endpoints.github.orgRepos(owner)),

  /** Repos for a specific GitHub user */
  getUserRepos: (owner: string) =>
    api.get<any>(endpoints.github.userRepos, { params: { owner } }),

  /** Check GitHub connection status */
  getStatus: () => api.get<any>(endpoints.github.status),

  /** Start GitHub OAuth connection */
  connect: () => api.post<any>(endpoints.github.connect),

  /** Poll device flow status */
  pollConnect: () => api.get<any>(endpoints.github.connectPoll),

  /** Disconnect GitHub integration */
  disconnect: () => api.post<any>(endpoints.github.disconnect),
};
