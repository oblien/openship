/**
 * Single source of truth for every API endpoint path.
 *
 * All route strings live here — never hardcode paths in components,
 * hooks, or context files. Import from `@/lib/api` instead.
 */

export const endpoints = {
  /* ---------------------------------------------------------------- */
  /*  Projects                                                        */
  /* ---------------------------------------------------------------- */
  projects: {
    home: "projects/home",
    deploymentsAll: "projects/deployments/all",
    info: (id: string | number) => `projects/${id}/info`,
    delete: (id: string | number) => `projects/${id}/delete`,
    update: (id: string | number) => `projects/${id}/update`,
    options: (id: string | number) => `projects/${id}/options`,
    toggle: (id: string | number, action: "enable" | "disable") =>
      `projects/${id}/${action}`,
    clearCache: (id: string | number) => `projects/${id}/clear-cache`,
    clearBuild: (id: string | number) => `projects/${id}/clear-build`,
    deploymentSession: (id: string | number) =>
      `projects/${id}/deployment-session`,
    connect: (id: string | number) => `projects/${id}/connect`,
    envSet: (id: string | number) => `projects/${id}/env/set`,
    envGet: (id: string | number) => `projects/${id}/env/get`,
    git: (id: string | number) => `projects/${id}/git`,
    branches: (id: string | number) => `projects/${id}/branches`,
    branch: (id: string | number) => `projects/${id}/branch`,
    gitSwitch: (id: string | number) => `projects/${id}/git/switch`,
    autoDeploy: (id: string | number) => `projects/${id}/auto-deploy`,
    resources: (id: string | number) => `projects/${id}/resources`,
    sleepMode: (id: string | number) => `projects/${id}/sleep-mode`,
    deployments: (id: string | number) => `projects/${id}/deployments`,
  },

  /* ---------------------------------------------------------------- */
  /*  Deploy / Build                                                  */
  /* ---------------------------------------------------------------- */
  deploy: {
    init: "deploy/init",
    buildAccess: "deploy/build/access",
    buildStatus: (id: string) => `deploy/build/${id}`,
    buildCancel: "deploy/build/cancel",
    buildRedeploy: "deploy/build/redeploy",
    logsAccess: "deploy/logs-access",
    sslStatus: "deploy/ssl/status",
    sslRenew: "deploy/ssl/renew",
  },

  /* ---------------------------------------------------------------- */
  /*  GitHub                                                          */
  /* ---------------------------------------------------------------- */
  github: {
    userHome: "github/home",
    orgRepos: (owner: string) => `github/orgs/${owner}/repos`,
    userRepos: "github/repos",
    status: "github/status",
    connect: "github/connect",
    disconnect: "github/disconnect",
  },

  /* ---------------------------------------------------------------- */
  /*  Icons                                                           */
  /* ---------------------------------------------------------------- */
  icons: {
    search: "icons/search-icons",
  },

  /* ---------------------------------------------------------------- */
  /*  AI                                                              */
  /* ---------------------------------------------------------------- */
  ai: {
    sessionList: "/ai/session/list",
  },

  /* ---------------------------------------------------------------- */
  /*  Sandbox                                                         */
  /* ---------------------------------------------------------------- */
  sandbox: {
    resources: (id: string | number) => `sandbox/${id}/resources`,
  },
} as const;
