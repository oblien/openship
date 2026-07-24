/**
 * Single source of truth for every API endpoint path.
 *
 * All route strings live here - never hardcode paths in components,
 * hooks, or context files. Import from `@/lib/api` instead.
 */

export const endpoints = {
  /* ---------------------------------------------------------------- */
  /*  Projects                                                        */
  /* ---------------------------------------------------------------- */
  projects: {
    home: "projects/home",
    item: (id: string | number) => `projects/${id}`,
    local: "projects/local",
    scan: "projects/scan",
    import: "projects/import",
    info: (id: string | number) => `projects/${id}/info`,
    environments: (id: string | number) => `projects/${id}/environments`,
    options: (id: string | number) => `projects/${id}/options`,
    portCheck: (id: string | number) => `projects/${id}/port-check`,
    outputCheck: (id: string | number) => `projects/${id}/output-check`,
    toggle: (id: string | number, action: "enable" | "disable") => `projects/${id}/${action}`,
    retryRouting: (id: string | number) => `projects/${id}/routing/retry`,
    clearCache: (id: string | number) => `projects/${id}/clear-cache`,
    clearBuild: (id: string | number) => `projects/${id}/clear-build`,
    routeRules: (id: string | number) => `projects/${id}/route-rules`,
    routeRule: (id: string | number, ruleId: string) => `projects/${id}/route-rules/${ruleId}`,
    deploymentSession: (id: string | number) => `projects/${id}/deployment-session`,
    connect: (id: string | number) => `projects/${id}/connect`,
    connections: (id: string | number) => `projects/${id}/connections`,
    connection: (id: string | number, linkId: string) => `projects/${id}/connections/${linkId}`,
    env: (id: string | number) => `projects/${id}/env`,
    git: (id: string | number) => `projects/${id}/git`,
    gitLink: (id: string | number) => `projects/${id}/git/link`,
    branches: (id: string | number) => `projects/${id}/branches`,
    branch: (id: string | number) => `projects/${id}/branch`,
    autoDeploy: (id: string | number) => `projects/${id}/auto-deploy`,
    webhookDomain: (id: string | number) => `projects/${id}/webhook-domain`,
    resources: (id: string | number) => `projects/${id}/resources`,
    cloneToken: (id: string | number) => `projects/${id}/clone-token`,
    sleepMode: (id: string | number) => `projects/${id}/sleep-mode`,
    deployments: (id: string | number) => `projects/${id}/deployments`,
    logs: (id: string | number) => `projects/${id}/logs`,
    logsStream: (id: string | number) => `projects/${id}/logs/stream`,
    serverLogsRecent: (id: string | number) => `projects/${id}/server-logs/recent`,
    serverLogsStreamToken: (id: string | number) => `projects/${id}/server-logs/stream-token`,
    serverLogsStream: (id: string | number) => `projects/${id}/server-logs/stream`,
    ensure: "projects/ensure",
    folderSession: "projects/folder/session",
    folderScan: (sessionId: string) => `projects/folder/scan/${sessionId}`,
    folderUpload: (sessionId: string) => `projects/folder/upload/${sessionId}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Apps (one-click catalog installs)                               */
  /* ---------------------------------------------------------------- */
  apps: {
    catalog: "apps/catalog",
    catalogEntry: (id: string) => `apps/catalog/${id}`,
    install: "apps",
    settings: (projectId: string | number) => `projects/${projectId}/app-settings`,
    connection: (projectId: string | number) => `projects/${projectId}/app-connection`,
  },

  /* ---------------------------------------------------------------- */
  /*  Services (compose / multi-service projects)                     */
  /* ---------------------------------------------------------------- */
  services: {
    list: (projectId: string | number) => `projects/${projectId}/services`,
    create: (projectId: string | number) => `projects/${projectId}/services`,
    get: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    update: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    delete: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    sync: (projectId: string | number) => `projects/${projectId}/services/sync`,
    containers: (projectId: string | number) => `projects/${projectId}/services/containers`,
    start: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/start`,
    stop: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/stop`,
    restart: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/restart`,
    driftAccept: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/drift/accept`,
    driftKeep: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/drift/keep`,
    logs: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/logs`,
    logsStream: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/logs/stream`,
    envGet: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/env`,
    envSet: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/env`,
  },

  /* ---------------------------------------------------------------- */
  /*  Deploy / Build                                                  */
  /* ---------------------------------------------------------------- */
  deploy: {
    list: "deployments",
    delete: (id: string) => `deployments/${id}`,
    reject: (id: string) => `deployments/${id}/reject`,
    keep: (id: string) => `deployments/${id}/keep`,
    skipPortCheck: (id: string) => `deployments/${id}/skip-port-check`,
    rollback: (id: string) => `deployments/${id}/rollback`,
    cancel: (id: string) => `deployments/${id}/cancel`,
    prepare: "deployments/prepare",
    buildAccess: "deployments/build/access",
    buildStart: (id: string) => `deployments/${id}/build`,
    buildStatus: (id: string) => `deployments/${id}/build`,
    buildRedeploy: (id: string) => `deployments/${id}/redeploy`,
    sslStatus: "deployments/ssl/status",
    sslRenew: "deployments/ssl/renew",
    buildRespond: (id: string) => `deployments/${id}/build/respond`,
  },

  /* ---------------------------------------------------------------- */
  /*  Domains                                                          */
  /* ---------------------------------------------------------------- */
  domains: {
    preview: "domains/preview",
    verify: (id: string) => `domains/${encodeURIComponent(id)}/verify`,
    verifySsl: (id: string) => `domains/${encodeURIComponent(id)}/verify-ssl`,
    certificate: (id: string) => `domains/${encodeURIComponent(id)}/certificate`,
    primary: (id: string) => `domains/${encodeURIComponent(id)}/primary`,
    records: (id: string) => `domains/${encodeURIComponent(id)}/records`,
  },

  /* ---------------------------------------------------------------- */
  /*  Jobs (self-hosted scheduled tasks)                              */
  /* ---------------------------------------------------------------- */
  jobs: {
    list: "jobs",
    triggerEvents: "jobs/trigger-events",
    backupSchedules: "jobs/backup-schedules",
    detail: (key: string) => `jobs/${encodeURIComponent(key)}`,
    update: (key: string) => `jobs/${encodeURIComponent(key)}`,
    runs: (key: string) => `jobs/${encodeURIComponent(key)}/runs`,
    run: (key: string) => `jobs/${encodeURIComponent(key)}/run`,
    runDetail: (runId: string) => `jobs/runs/${encodeURIComponent(runId)}`,
    runStream: (runId: string) => `jobs/runs/${encodeURIComponent(runId)}/stream`,
  },

  /* ---------------------------------------------------------------- */
  /*  Personal access tokens                                          */
  /* ---------------------------------------------------------------- */
  tokens: {
    list: "tokens",
    item: (id: string) => `tokens/${encodeURIComponent(id)}`,
    mcpAuthorize: "tokens/mcp-authorize",
    mcpClients: "tokens/mcp-clients",
    mcpClient: (clientId: string) => `tokens/mcp-clients/${encodeURIComponent(clientId)}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Permissions / resource grants                                   */
  /* ---------------------------------------------------------------- */
  permissions: {
    resources: "permissions/resources",
    grants: "permissions/grants",
    grant: (id: string) => `permissions/grants/${encodeURIComponent(id)}`,
    inviteWithGrants: "permissions/invite-with-grants",
  },

  /* ---------------------------------------------------------------- */
  /*  GitHub                                                          */
  /* ---------------------------------------------------------------- */
  github: {
    userHome: "github/home",
    orgRepos: (owner: string) => `github/orgs/${owner}/repos`,
    userRepos: "github/repos",
    cloneToken: (owner: string, repo: string) =>
      `github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/clone-token`,
    repoBranches: (owner: string, repo: string) =>
      `github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    status: "github/status",
    connect: "github/connect",
    connectRedirect: "github/connect/redirect",
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
  /*  Image catalog (Oblien)                                          */
  /* ---------------------------------------------------------------- */
  images: {
    list: "images",
  },

  /* ---------------------------------------------------------------- */
  /*  AI                                                              */
  /* ---------------------------------------------------------------- */
  ai: {
    sessionList: "/ai/session/list",
  },

  /* ---------------------------------------------------------------- */
  /*  Analytics                                                       */
  /* ---------------------------------------------------------------- */
  analytics: {
    summary: "analytics",
    periods: "analytics/periods",
    overview: "analytics/overview",
    deployments: "analytics/deployments",
    usage: "analytics/usage",
    usageStream: "analytics/usage/stream",
    container: "analytics/container",
    dashboard: "analytics/dashboard",
    server: (serverId: string) => `analytics/server/${serverId}`,
    serverGeo: (serverId: string) => `analytics/server/${serverId}/geo`,
    serverLive: (serverId: string) => `analytics/server/${serverId}/live`,
  },

  /* ---------------------------------------------------------------- */
  /*  System (self-hosted only)                                       */
  /* ---------------------------------------------------------------- */
  system: {
    browse: "system/browse",
    settings: "system/settings",
    emailSettings: "system/settings/email",
    emailSettingsTest: "system/settings/email/test",
    onboarding: "system/onboarding",
    onboardingTestConnection: "system/onboarding/test-connection",
    testConnection: "system/test-connection",
    check: "system/check",
    install: "system/install",
    remove: "system/remove",
    installStream: "system/install/stream",
    installRespond: "system/install/respond",
    installSession: "system/install/session",
    monitorStream: "system/monitor/stream",
    servers: "system/servers",
    server: (id: string) => `system/servers/${id}`,
    serverReachability: (id: string) => `system/servers/${id}/reachability`,
    serverRateLimit: (id: string) => `system/servers/${id}/rate-limit`,
    serverPortsScan: (id: string) => `system/servers/${id}/ports/scan`,
    // Native-module versioning + migration (OpenResty, …)
    serverModules: (id: string) => `system/servers/${id}/modules`,
    serverModulesScan: (id: string) => `system/servers/${id}/modules/scan`,
    serverModuleApply: (id: string, module: string) =>
      `system/servers/${id}/modules/${module}/apply`,
    // Per-server GitHub auth (self-hosted)
    serverGithub: (id: string) => `system/servers/${id}/github`,
    serverGithubConnect: (id: string) => `system/servers/${id}/github/connect`,
    serverGithubConnectPoll: (id: string) => `system/servers/${id}/github/connect/poll`,
    serverGithubToken: (id: string) => `system/servers/${id}/github/token`,
    serverGithubSshKey: (id: string) => `system/servers/${id}/github/ssh-key`,
    serverGithubDeployKeyMode: (id: string) => `system/servers/${id}/github/deploy-key-mode`,
    // Port-forward tunnels (desktop-only)
    tunnels: (serverId: string) => `system/servers/${serverId}/tunnels`,
    tunnelStart: (serverId: string, tunnelId: string) =>
      `system/servers/${serverId}/tunnels/${tunnelId}/start`,
    tunnelStop: (serverId: string, tunnelId: string) =>
      `system/servers/${serverId}/tunnels/${tunnelId}/stop`,
    tunnel: (serverId: string, tunnelId: string) =>
      `system/servers/${serverId}/tunnels/${tunnelId}`,
    migration: {
      preflight: "system/migration/preflight",
      start: "system/migration/start",
      startCloud: "system/migration/start-cloud",
      startTunnel: "system/migration/start-tunnel",
      switchBack: "system/migration/switch-back",
    },
    dataTransfer: {
      export: "system/data-transfer/export",
      import: "system/data-transfer/import",
    },
  },

  /* ---------------------------------------------------------------- */
  /*  Mail server setup (self-hosted only)                            */
  /* ---------------------------------------------------------------- */
  mail: {
    steps: "mail/steps",
    status: "mail/status",
    servers: "mail/servers",
    forgetServer: (serverId: string) =>
      `mail/servers/${encodeURIComponent(serverId)}`,
    scan: "mail/scan",
    adopt: "mail/adopt",
    setup: "mail/setup",
    cancelSetup: "mail/setup/cancel",
    acknowledgeDns: "mail/setup/dns-ack",
    acknowledgePtr: "mail/setup/ptr-ack",
    resetSetup: "mail/setup/reset",
    setPostmasterPassword: "mail/credentials/postmaster",
    health: (serverId: string) => `mail/health/${encodeURIComponent(serverId)}`,
    portsCheck: "mail/ports/check",
    portsResolve: "mail/ports/resolve",
    admin: {
      domains: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains`,
      domain: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}`,
      domainDependents: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dependents`,
      domainDns: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dns`,
      domainDnsAcknowledge: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dns/acknowledge`,
      pendingDomainDns: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains-dns/pending`,
      mailboxes: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/mailboxes`,
      mailbox: (serverId: string, email: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/mailboxes/${encodeURIComponent(email)}`,
      stats: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/stats`,
      dnsScan: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/dns-scan`,
      relay: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/relay`,
      backupPolicy: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/backup-policy`,
      backupRuns: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/backup-runs`,
      testEmail: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/test-email`,
      componentAction: (serverId: string, key: string, action: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/${encodeURIComponent(key)}/${encodeURIComponent(action)}`,
      componentLogs: (serverId: string, key: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/${encodeURIComponent(key)}/logs`,
      componentsRestartAll: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/restart-all`,
    },
    webmail: {
      targets: "mail/webmail/targets",
      deployProject: "mail/webmail/deploy-project",
      deployExternal: "mail/webmail/deploy-external",
    },
  },

  /* ---------------------------------------------------------------- */
  /*  Sandbox                                                         */
  /* ---------------------------------------------------------------- */
  sandbox: {
    resources: (id: string | number) => `sandbox/${id}/resources`,
  },

  /* ---------------------------------------------------------------- */
  /*  Docker migration (inspect + adopt an existing Docker server)    */
  /* ---------------------------------------------------------------- */
  dockerMigration: {
    scan: "migration/scan",
    scanStream: "migration/scan/stream",
    adopt: "migration/adopt",
    reimport: "migration/reimport",
    repoCompose: "migration/repo-compose",
    preview: "migration/preview",
    migrate: "migration/migrate",
    migration: (id: string) => `migration/migrations/${id}`,
    cutover: (id: string) => `migration/migrations/${id}/cutover`,
  },

  /* ---------------------------------------------------------------- */
  /*  Settings (user platform preferences)                            */
  /* ---------------------------------------------------------------- */
  settings: {
    get: "settings",
    upsert: "settings",
    buildMode: "settings/build-mode",
    routeStrategy: "settings/route-strategy",
    deployDefaults: "settings/deploy-defaults",
    cloneCredentials: "settings/clone-credentials",
    cloneStrategyPreference: "settings/clone-strategy-preference",
  },

  /* ---------------------------------------------------------------- */
  /*  Notifications (channels, subscriptions, defaults, deliveries)   */
  /* ---------------------------------------------------------------- */
  notifications: {
    categories: "notifications/categories",
    channels: "notifications/channels",
    channel: (id: string) => `notifications/channels/${id}`,
    channelTest: (id: string) => `notifications/channels/${id}/test`,
    subscriptions: "notifications/subscriptions",
    subscription: (id: string) => `notifications/subscriptions/${id}`,
    defaults: "notifications/defaults",
    deliveries: "notifications/deliveries",
    unseenCount: "notifications/deliveries/unseen-count",
    markSeen: (id: string) => `notifications/deliveries/${id}/seen`,
  },

  /* ---------------------------------------------------------------- */
  /*  Updates (unified update scan + apply)                           */
  /* ---------------------------------------------------------------- */
  updates: {
    list: "updates",
    behind: "updates?behind=1",
    scan: "updates/scan",
    apply: (projectId: string) => `updates/${projectId}/apply`,
  },

  /* ---------------------------------------------------------------- */
  /*  Cloud (Openship Cloud connection - local/self-hosted only)      */
  /* ---------------------------------------------------------------- */
  cloud: {
    disconnect: "cloud/disconnect",
    status: "cloud/status",
    connectFinalize: "cloud/connect-finalize",
    connectAuthorize: "cloud/connect-authorize",
  },

  /* ---------------------------------------------------------------- */
  /*  Interactive terminal (xterm.js ↔ WS ↔ ssh2 PTY)                */
  /* ---------------------------------------------------------------- */
  terminal: {
    ticket: "terminal/ticket",
    // The WebSocket path is constructed from getApiBaseUrl() with
    // protocol swap; see lib/api/terminal.ts buildTerminalWsUrl.
    wsPath: (serverId: string) => `terminal/ws/${serverId}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Service terminal (xterm.js ↔ WS ↔ Docker exec OR Oblien shell) */
  /* ---------------------------------------------------------------- */
  serviceTerminal: {
    ticket: "services/terminal/ticket",
    wsPath: (serviceId: string) => `services/terminal/ws/${serviceId}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Backup destinations (per-user)                                  */
  /* ---------------------------------------------------------------- */
  backupDestinations: {
    list: "backup-destinations",
    create: "backup-destinations",
    get: (id: string) => `backup-destinations/${id}`,
    update: (id: string) => `backup-destinations/${id}`,
    delete: (id: string) => `backup-destinations/${id}`,
    preflight: (id: string) => `backup-destinations/${id}/preflight`,
    preflightDraft: "backup-destinations/preflight",
    usage: (id: string) => `backup-destinations/${id}/usage`,
  },

  /* ---------------------------------------------------------------- */
  /*  Billing (Stripe-backed cloud billing — SaaS + local-proxy)      */
  /* ---------------------------------------------------------------- */
  billing: {
    plans: "billing/plans",
    state: "billing/state",
    usage: "billing/usage",
    topupPacks: "billing/topup-packs",
    subscription: "billing/subscription",
    topup: "billing/topup",
    portal: "billing/portal",
  },

  /* ---------------------------------------------------------------- */
  /*  Backups (policies + runs)                                       */
  /* ---------------------------------------------------------------- */
  backups: {
    listPolicies: (projectId: string | number) =>
      `projects/${projectId}/backup-policies`,
    createPolicy: (projectId: string | number) =>
      `projects/${projectId}/backup-policies`,
    updatePolicy: (policyId: string) => `backup-policies/${policyId}`,
    deletePolicy: (policyId: string) => `backup-policies/${policyId}`,
    runNow: (policyId: string) => `backup-policies/${policyId}/run`,
    listRuns: (projectId: string | number) =>
      `projects/${projectId}/backup-runs`,
    getRun: (runId: string) => `backup-runs/${runId}`,
    protectRun: (runId: string) => `backup-runs/${runId}/protect`,
    prepareRestore: (runId: string) => `backup-runs/${runId}/restore/prepare`,
    applyRestore: (restoreId: string) =>
      `backup-restores/${restoreId}/apply`,
    cancelRestore: (restoreId: string) =>
      `backup-restores/${restoreId}/cancel`,
    getRestore: (restoreId: string) => `backup-restores/${restoreId}`,
  },
} as const;
