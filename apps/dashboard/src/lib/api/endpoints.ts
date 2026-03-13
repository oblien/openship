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
    local: "projects/local",
    scan: "projects/scan",
    import: "projects/import",
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
    logs: (id: string | number) => `projects/${id}/logs`,
    logsStream: (id: string | number) => `projects/${id}/logs/stream`,
    ensure: "projects/ensure",
  },

  /* ---------------------------------------------------------------- */
  /*  Deploy / Build                                                  */
  /* ---------------------------------------------------------------- */
  deploy: {
    list: "deployments",
    delete: (id: string) => `deployments/${id}`,
    cancel: (id: string) => `deployments/${id}/cancel`,
    prepare: "deployments/prepare",
    buildAccess: "deployments/build/access",
    buildStart: (id: string) => `deployments/${id}/build`,
    buildStatus: (id: string) => `deployments/${id}/build`,
    buildRedeploy: (id: string) => `deployments/${id}/redeploy`,
    sslStatus: "deployments/ssl/status",
    sslRenew: "deployments/ssl/renew",
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
    connectPoll: "github/connect/poll",
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
