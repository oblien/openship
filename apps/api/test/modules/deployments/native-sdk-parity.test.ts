import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import type { VerifiedIdentity } from "@repo/platform";
import { ENV_MASK, type AppTemplate } from "@repo/core";
import type { BackupDestination as StoredBackupDestination } from "@repo/db";
import type { ProjectInfo } from "@repo/platform/engine/modules/deployments/prepare.service";
import { alice, storedDeployment } from "../../../../../packages/platform/test/fixtures";
import { deploymentFixture, projectFixture, serviceFixture, domainFixture, dnsCredentialFixture, credentialFixture, serverFixture, serverContainerFixture, backupDestinationFixture } from "../../../../../packages/contracts/test/fixtures";
import { backupPolicyFixture, backupRunFixture, backupRestoreFixture } from "../../../../../packages/contracts/test/fixtures";

/**
 * Real route, schema, controller, permission engine, SDK and API composition.
 * Only infrastructure and the already-tested deployment engine are replaced.
 * The native call must reach the same engine with the same policy/presentation.
 */
const h = vi.hoisted(() => ({
  members: new Map<string, { id: string; role: string }>(),
  projects: new Map<string, { organizationId: string; [key: string]: unknown }>(),
  appDraft: vi.fn(),
  customApps: new Map<string, { organizationId: string; appId: string; template: AppTemplate; updatedAt: Date; createdByUserId: string }>(),
  appEnv: new Map<string, { key: string; value: string; isSecret: boolean }[]>(),
  appEnvMerge: vi.fn(), hostCapacity: vi.fn(),
  destinations: new Map<string, StoredBackupDestination>(),
  backupPolicies: new Map<string, ReturnType<typeof backupPolicyFixture>>(),
  backupRuns: new Map<string, ReturnType<typeof backupRunFixture>>(),
  backupHistoryRead: vi.fn(), backupStats: vi.fn(),
  backupRestores: new Map<string, ReturnType<typeof backupRestoreFixture>>(),
  backupPolicyCreate: vi.fn(), backupPolicyUpdate: vi.fn(), backupPolicyDelete: vi.fn(), backupRetentionLock: vi.fn(),
  backupEnqueue: vi.fn(), backupPrepare: vi.fn(), backupApply: vi.fn(), backupCancel: vi.fn(), backupSyncSchedule: vi.fn(), backupRemoveSchedule: vi.fn(),
  destinationCreate: vi.fn(), destinationUpdate: vi.fn(), destinationDelete: vi.fn(), destinationVerify: vi.fn(), destinationProbe: vi.fn(),
  deployments: new Map<string, ReturnType<typeof storedDeployment>>(),
  deploymentContainerInfo: vi.fn(), deploymentContainerUsage: vi.fn(), deploymentPendingActions: vi.fn(),
  grants: new Map<string, { permissions: string[] }>(),
  trigger: vi.fn(),
  audit: vi.fn(),
  cloudOwner: vi.fn(),
  cloudFetch: vi.fn(),
  projectOptions: vi.fn(),
  projectEnvMerge: vi.fn(),
  projectBranch: vi.fn(),
  projectTeardown: vi.fn(),
  projectLinkRepo: vi.fn(),
  projectReleaseSource: vi.fn(),
  projectCreate: vi.fn(),
  localInfo: vi.fn(),
  localScan: vi.fn(),
  sourceContent: vi.fn(),
  services: new Map<string, { projectId: string; [key: string]: unknown }>(),
  domains: new Map<string, { projectId: string; [key: string]: unknown }>(),
  manageSsl: vi.fn(),
  servers: new Map<string, { organizationId: string; [key: string]: unknown }>(),
  serverCreate: vi.fn(), serverUpdate: vi.fn(), serverRemove: vi.fn(), serverWorkloads: vi.fn(),
  serverExec: vi.fn(), serverWithExecutor: vi.fn(), serverModuleScan: vi.fn(), serverModuleApply: vi.fn(),
  serverRateRead: vi.fn(), serverRateApply: vi.fn(),
  componentCheck: vi.fn(), installDocker: vi.fn(), installEdge: vi.fn(), removeEdge: vi.fn(),
  deliverEdge: vi.fn(), refreshServerContainer: vi.fn(),
  monitorExec: vi.fn(), serverRetain: vi.fn(), serverRelease: vi.fn(),
  containerRows: new Map<string, ReturnType<typeof serverContainerFixture>>(),
  containerUpsert: vi.fn(), containerProgress: vi.fn(), reconcileEdge: vi.fn(),
  mailRecord: vi.fn(),
  domainCreate: vi.fn(), domainList: vi.fn(), domainGet: vi.fn(), domainVerify: vi.fn(),
  domainRecords: vi.fn(), domainUpload: vi.fn(), domainPending: vi.fn(),
  dnsGet: vi.fn(), dnsList: vi.fn(), dnsAdd: vi.fn(), dnsRemove: vi.fn(), dnsResolve: vi.fn(),
  credentialGet: vi.fn(), credentialList: vi.fn(), credentialCreate: vi.fn(), credentialUpdate: vi.fn(), credentialRemove: vi.fn(), credentialVerify: vi.fn(),
  transferCloud: vi.fn(), transferLocal: vi.fn(),
  notify: vi.fn(),
  ruleGet: vi.fn(), ruleCreate: vi.fn(), ruleUpdate: vi.fn(), ruleRemove: vi.fn(), rulePush: vi.fn(),
  serviceCreate: vi.fn(),
  serviceGet: vi.fn(),
  serviceUpdate: vi.fn(),
  serviceReveal: vi.fn(),
  serviceRestart: vi.fn(),
  serviceExec: vi.fn(),
  identity: null as VerifiedIdentity | null,
  instanceRoles: new Map<string, string>(),
  settings: undefined as Record<string, unknown> | undefined,
  settingsUpsert: vi.fn(), settingsDelete: vi.fn(),
  mailTest: vi.fn(), mailAvailable: vi.fn(), invalidateMailCache: vi.fn(),
  orphanScan: vi.fn(), orphanRemove: vi.fn(),
  tunnels: new Map<string, { id: string; serverId: string; remoteHost: string; remotePort: number; localPort: number | null; autoStart: boolean }>(),
  tunnelUpsert: vi.fn(), tunnelRemove: vi.fn(), tunnelForward: vi.fn(), tunnelClose: vi.fn(),
  env: {
    CLOUD_MODE: false, DEPLOY_MODE: "docker", BETTER_AUTH_SECRET: "server-parity-test-encryption-secret-32-bytes",
    OPENSHIP_PRODUCT: "platform", OPENSHIP_AUTH_MODE: undefined as string | undefined, OPENSHIP_ALLOW_ZERO_AUTH: false,
  },
}));

vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  schema: {},
  getDriver: () => "postgres",
  repos: {
    serverCluster: { membership: async () => null },
    user: { findFoundingAdmin: async () => ({ id: "founder" }) },
    instanceSettings: { get: async () => h.settings, upsert: h.settingsUpsert, delete: h.settingsDelete },
    serverTunnel: {
      get: async (id: string) => h.tunnels.get(id),
      getByTarget: async (serverId: string, remotePort: number, remoteHost: string) => [...h.tunnels.values()].find(row => row.serverId === serverId && row.remotePort === remotePort && row.remoteHost === remoteHost),
      listByServer: async (id: string) => [...h.tunnels.values()].filter(row => row.serverId === id),
      upsert: h.tunnelUpsert, remove: h.tunnelRemove,
    },
    member: { find: async (org: string, user: string) => h.members.get(`${org}:${user}`) },
    project: { findById: async (id: string) => h.projects.get(id),
      findDraftByAppTemplate: h.appDraft,
      listEnvVars: async (id: string, environment: string, service?: string) => service
        ? h.appEnv.get(`${id}:${environment}:${service}`) ?? []
        : [...h.appEnv.entries()].filter(([key]) => key.startsWith(`${id}:${environment}:`))
          .flatMap(([key, rows]) => rows.map(row => ({ ...row, serviceId: key.slice(`${id}:${environment}:`.length) }))),
      mergeEnvVars: h.appEnvMerge,
      countActiveByServer: async () => ({ "server-a": 2 }), listActiveByServer: h.serverWorkloads },
    customAppTemplate: {
      listByOrg: async (org: string) => [...h.customApps.values()].filter(row => row.organizationId === org),
      findByAppId: async (org: string, id: string) => h.customApps.get(`${org}:${id}`),
      upsert: async (row: { organizationId: string; appId: string; template: AppTemplate; createdByUserId: string }) => {
        h.customApps.set(`${row.organizationId}:${row.appId}`, { ...row, updatedAt: new Date("2026-09-12T00:00:00Z") });
      },
      deleteByAppId: async (org: string, id: string) => { h.customApps.delete(`${org}:${id}`); },
    },
    backupDestination: {
      findById: async (id: string) => h.destinations.get(id),
      listByOrganization: async (org: string) => [...h.destinations.values()].filter(row => row.organizationId === org),
      findByNameInOrganization: async (org: string, name: string) => [...h.destinations.values()].find(row => row.organizationId === org && row.name === name),
      create: h.destinationCreate, update: h.destinationUpdate, softDelete: h.destinationDelete, setLastVerified: h.destinationVerify,
    },
    backupRun: {
      statsByDestination: h.backupStats, listWithSources: h.backupHistoryRead, findById: async (id: string) => h.backupRuns.get(id),
      listByOrganization: async (org: string, opts: { projectId?: string; serviceId?: string; limit?: number }) => [...h.backupRuns.values()].filter(row => row.organizationId === org && (!opts.projectId || row.projectId === opts.projectId) && (!opts.serviceId || row.serviceId === opts.serviceId)).slice(0, opts.limit),
      setRetentionLock: h.backupRetentionLock,
    },
    backupPolicy: {
      listByDestination: async () => [], findById: async (id: string) => h.backupPolicies.get(id),
      listByProject: async (id: string) => [...h.backupPolicies.values()].filter(row => row.projectId === id),
      create: h.backupPolicyCreate, update: h.backupPolicyUpdate, softDelete: h.backupPolicyDelete,
    },
    backupRestore: { findById: async (id: string) => h.backupRestores.get(id) },
    deployment: { findById: async (id: string) => h.deployments.get(id) },
    service: { findById: async (id: string) => h.services.get(id), listByProject: async (id: string) => [...h.services.values()].filter(row => row.projectId === id) },
    domain: { findById: async (id: string) => h.domains.get(id), findByHostname: async (hostname: string) => [...h.domains.values()].find(row => row.hostname === hostname),
      listByProject: async (id: string) => [...h.domains.values()].filter(row => row.projectId === id) },
    server: {
      list: async () => [...h.servers.values()],
      get: async (id: string) => h.servers.get(id),
      getInOrganization: async (id: string, org: string) => h.servers.get(id)?.organizationId === org ? h.servers.get(id) : undefined,
      listByOrganization: async (org: string) => [...h.servers.values()].filter(row => row.organizationId === org),
      create: h.serverCreate, update: h.serverUpdate, delete: h.serverRemove,
    },
    mailServer: { get: h.mailRecord },
    serverContainerStatus: {
      listByServer: async (id: string) => [...h.containerRows.values()].filter(row => row.serverId === id),
      listByOrg: async (id: string) => [...h.containerRows.values()].filter(row => row.organizationId === id),
      listBehindByOrg: async (id: string) => [...h.containerRows.values()].filter(row => row.organizationId === id && row.behind),
      setInProgress: h.containerProgress, upsert: h.containerUpsert, remove: vi.fn(async () => {}),
    },
    routeRule: { get: h.ruleGet, create: h.ruleCreate, update: h.ruleUpdate, removeForProject: h.ruleRemove },
    resourceGrant: {
      deleteForResource: vi.fn(async () => {}),
      findForResource: async (org: string, user: string, type: string, id: string) =>
        h.grants.get(`${org}:${user}:${type}:${id}`) ??
        h.grants.get(`${org}:${user}:${type}:*`) ??
        null,
    },
    patGrant: {
      findForResource: async (token: string, type: string, id: string) =>
        h.grants.get(`${token}:${type}:${id}`) ?? null,
    },
    auditEvent: { create: h.audit },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: h.env,
  trustedOrigins: [],
  runtimeTargetId: "local",
  cloudRuntimeTarget: { dashboard: "https://openship.test", api: "https://api.openship.test" },
}));
vi.mock("@repo/platform/engine/lib/instance-authorization", async () => {
  const { createInstanceAuthorization } = await import("@repo/platform");
  return { instanceAuthorization: createInstanceAuthorization({ findUserRole: async userId => h.instanceRoles.get(userId) }) };
});
vi.mock("@repo/platform/engine/lib/mail", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/mail")>(),
  sendInstanceTestEmail: h.mailTest, canSendMail: h.mailAvailable, invalidateInstanceTransportCache: h.invalidateMailCache,
}));
vi.mock("@repo/platform/engine/lib/public-url", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/public-url")>(),
  getInstanceReachability: async () => ({ configured: false, url: null, source: null, selfAppInstalled: false, selfAppProjectId: null, selfAppHasDomain: false, selfAppHasVerifiedDomain: false }),
}));
vi.mock("@repo/platform/engine/lib/edge-orphans.service", () => ({ scanEdgeOrphans: h.orphanScan, removeEdgeOrphan: h.orphanRemove }));
vi.mock("@repo/platform/engine/lib/connectivity", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/connectivity")>(),
  runConnectivityCheck: h.destinationProbe,
}));
vi.mock("@repo/platform/engine/lib/ssh-tunnel", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/ssh-tunnel")>(), tunnelForward: h.tunnelForward,
}));
// HTTP authentication is supplied below; loading unrelated Git/auth routes
// must not initialize a second auth provider in this operation parity test.
vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: {},
  isSaasDeployment: false,
  COOKIE_PREFIX: "openship",
}));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({
  resolveOrgCloudUserId: h.cloudOwner,
  cloudFetchAsOrgOwner: h.cloudFetch,
}));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => (_c: unknown, next: () => unknown) => next(),
}));
vi.mock("../../../src/middleware/auth", () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    const { buildRequestContext } = await import("../../../src/lib/request-context");
    const identity = h.identity!;
    const fixed = c.req.header("X-Openship-Scope") === "fixed";
    const org = fixed ? c.req.header("X-Organization-Id") : "org-a";
    c.set("activeOrganizationId", org);
    c.set("clientIp", "127.0.0.1");
    c.set(
      "ctx",
      buildRequestContext({
        ...identity,
        user: identity.user,
        organizationId: org,
        role: "owner",
        membershipId: "initial-membership",
        sessionId: identity.sessionId,
        sessionKind: "bearer",
        scopeMode: fixed ? "fixed" : "resource",
        clientIp: "127.0.0.1",
        userAgent: c.req.header("User-Agent") ?? null,
        traceId: "http-trace",
        hono: c,
      }),
    );
    await next();
  },
}));

vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.trigger,
  subscribeToBuildSession: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/deployments/deployment.service", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/deployments/deployment.service")>(),
  getContainerInfo: h.deploymentContainerInfo, getContainerUsage: h.deploymentContainerUsage,
}));
vi.mock("@repo/platform/engine/modules/projects/pending-actions.service", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/projects/pending-actions.service")>(),
  getDeploymentPendingActions: h.deploymentPendingActions,
}));
vi.mock("@repo/platform/engine/modules/projects/project.service", () => ({
  updateOptions: h.projectOptions,
  mergeEnvVars: h.projectEnvMerge,
  setBranch: h.projectBranch,
  linkProjectRepo: h.projectLinkRepo,
  setProjectReleaseImageSource: h.projectReleaseSource,
  createProject: h.projectCreate,
}));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/projects/project-crud.service")>(),
  createProject: h.projectCreate,
}));
vi.mock("@repo/platform/engine/modules/services/service.service", () => ({
  createService: h.serviceCreate, getService: h.serviceGet, updateService: h.serviceUpdate,
  revealServiceEnv: h.serviceReveal, restartServiceContainer: h.serviceRestart, execInServiceContainer: h.serviceExec,
}));
vi.mock("@repo/platform/engine/modules/domains/domain.service", () => ({
  addDomain: h.domainCreate, listDomains: h.domainList, getDomain: h.domainGet,
  verifyDomain: h.domainVerify, getDomainRecords: h.domainRecords, uploadDomainCert: h.domainUpload,
  verifyPendingDomains: h.domainPending,
}));
vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({
  getCredential: h.dnsGet, listCredentials: h.dnsList, addCredential: h.dnsAdd,
  removeCredential: h.dnsRemove, resolveDnsManager: h.dnsResolve,
}));
vi.mock("@repo/platform/engine/modules/credentials/credential.service", () => ({
  getCredential: h.credentialGet, listCredentials: h.credentialList, createCredential: h.credentialCreate,
  updateCredential: h.credentialUpdate, deleteCredential: h.credentialRemove, verifyCredential: h.credentialVerify,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({ notification: { emit: h.notify } }));
vi.mock("@repo/platform/engine/modules/route-rules/route-rule.service", () => ({ pushProjectRulesResolved: h.rulePush }));
vi.mock("@repo/platform/engine/modules/projects/project-teardown", () => ({
  teardownProject: h.projectTeardown,
}));
vi.mock("@repo/platform/engine/modules/deployments/reconcile.service", () => ({
  triggerReconcile: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/deployments/build-status.service", () => ({}));
vi.mock("@repo/platform/engine/lib/domain-ssl", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/domain-ssl")>(),
  manageDomainSsl: h.manageSsl,
}));
vi.mock("@repo/platform/engine/modules/deployments/prepare.service", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/deployments/prepare.service")>(),
  resolveProjectInfo: h.localInfo,
  projectInfoToScanResponse: h.localScan,
}));
vi.mock("@repo/platform/engine/modules/projects/transfer.service", () => ({
  promoteProjectToCloud: h.transferCloud,
  transferProjectToSelfHosted: h.transferLocal,
  TransferConflictError: class extends Error {},
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", () => ({
  collectDeploymentManifest: vi.fn(),
  executeCleanup: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  assertGitHubRepoAccess: vi.fn(),
  checkSourceTier: h.sourceContent,
}));
vi.mock("@repo/platform/engine/modules/deployments/rollback/index", () => ({
  rollback: vi.fn(),
  setPin: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntime: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/startup/self-server", () => ({ ensureLocalServer: vi.fn(async () => null), localServerHostChannel: vi.fn(async () => null) }));
vi.mock("@repo/platform/engine/lib/geo-ip", () => ({ primeGeo: vi.fn(async () => {}), countryForIp: () => null }));
vi.mock("@repo/platform/engine/lib/host-capacity", () => ({ invalidateHostCapacity: vi.fn(async () => {}), getTrustedHostCapacity: h.hostCapacity }));
vi.mock("@repo/platform/engine/lib/openresty-paths", () => ({
  invalidateOpenRestyPaths: vi.fn(async () => {}),
  withOpenRestyRouting: async (_id: string, work: (routing: unknown) => unknown) => work({ getRateLimitConfig: h.serverRateRead, applyRateLimit: h.serverRateApply }),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: h.serverWithExecutor, invalidate: vi.fn(),
    acquire: async () => ({ exec: h.monitorExec }), retain: h.serverRetain, release: h.serverRelease,
  },
}));
vi.mock("@repo/platform/engine/lib/agent-exec", () => ({ execOnHost: h.serverExec }));
vi.mock("@repo/platform/engine/modules/system/server-modules.service", () => ({ scanServer: h.serverModuleScan, applyServerModule: h.serverModuleApply }));
vi.mock("@repo/adapters", async importOriginal => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return {
    ...actual,
    getPlatform: () => ({ target: "selfhosted" }),
    checkComponents: h.componentCheck,
    dockerAvailable: async () => true,
    detectEdgeContainer: async () => ({ name: "openship-edge", image: "edge:old", running: true, exists: true }),
    probeEdge: async () => ({ canProceedClean: true }),
    getRemovalSupport: async () => ({ supported: true }),
    COMPONENT_INSTALLERS: { ...actual.COMPONENT_INSTALLERS, docker: h.installDocker, edge: h.installEdge },
    COMPONENT_UNINSTALLERS: { ...actual.COMPONENT_UNINSTALLERS, edge: h.removeEdge },
    ensureEdge: async (_executor: unknown, work: (prompt: unknown) => unknown, options: { promptUser: unknown }) => ({ migrated: false, value: await work(options.promptUser) }),
    recoverInterruptedTakeover: async () => {},
  };
});
vi.mock("@repo/platform/engine/lib/deliver-managed-image", () => ({ deliverManagedImage: h.deliverEdge }));
vi.mock("@repo/platform/engine/modules/system/server-containers.service", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/system/server-containers.service")>(),
  refreshServerContainer: h.refreshServerContainer,
}));
vi.mock("@repo/platform/engine/lib/edge-reconcile", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/lib/edge-reconcile")>(), reconcileServerEdge: h.reconcileEdge,
}));

import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { dnsRoutes } from "../../../src/modules/dns/dns.routes";
import { credentialRoutes } from "../../../src/modules/credentials/credential.routes";
import { appRoutes } from "../../../src/modules/apps/app.routes";
import { appSettingsRoutes } from "../../../src/modules/apps/app-settings.routes";
import { appConnectionRoutes } from "../../../src/modules/apps/app-connection.routes";
import { backupDestinationRoutes } from "../../../src/modules/backup-destinations/destination.routes";
import { backupRoutes } from "../../../src/modules/backups/backup.routes";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { systemManagementRoutes } from "../../../src/modules/system/system-management.routes";
import { getInternalSetup, onboardingSetup } from "../../../src/modules/system/setup.controller";
import { stopAllTunnels } from "@repo/platform/engine/lib/ssh-tunnel-manager";
import { clearAuthModeCache } from "@repo/platform/engine/lib/auth-mode";
import { clearProductModeCache } from "@repo/platform/engine/lib/product-mode";
import { clearHostControlCache } from "@repo/platform/engine/lib/host-control";
import { clearBoxOwningOrgCache } from "@repo/platform/engine/lib/box-org";
import { configureNativeSourceRoots } from "@repo/platform/engine/native/source-policy";
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import { decryptSecretField, encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { ServiceConfigStaleError } from "@repo/platform/engine/modules/deployments/env-drift";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const secret = "secret-that-must-not-leave-the-presenter";
const app = new Hono();
app.onError(handleApiError);
app.route("/api/health", healthRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/projects/:id/services", serviceRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/dns", dnsRoutes);
app.route("/api/credentials", credentialRoutes);
app.route("/api/apps", appRoutes);
app.route("/api/backup-destinations", backupDestinationRoutes);
app.route("/api/projects/:id/app-settings", appSettingsRoutes);
app.route("/api/projects/:id/app-connection", appConnectionRoutes);
app.route("/api/system", serverManagementRoutes);
app.route("/api/system", systemManagementRoutes);
app.route("/api", backupRoutes);

const http = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const native = (organizationId = "org-a") =>
  createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => h.identity },
  }).scope({
    identity: "verified-assertion",
    organizationId,
  });

describe("deployment preparation HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  let info: ProjectInfo;

  beforeEach(() => {
    info = {
      repository: { name: "app", full_name: "acme/app", owner: { login: "acme" }, private: true, default_branch: "main" },
      stack: "node", projectType: "services", category: "backend", packageManager: "npm",
      buildCommand: "npm run build", installCommand: "npm ci", startCommand: "node server.js",
      buildImage: "node:22", outputDirectory: "dist", rootDirectory: "./", productionPaths: ["dist"], port: 3000,
      composePath: "deploy/compose.yaml",
      rootEnv: { ROOT_TOKEN: secret, EMPTY: "" },
      openshipEnv: { DECLARED_TOKEN: { value: secret, secret: true } },
      services: [{
        name: "web", image: "node:22", ports: ["3000:3000"], dependsOn: [], volumes: [],
        environment: { API_TOKEN: secret, EMPTY: "" },
        environmentTemplates: { API_TOKEN: secret },
      }],
      missingRequiredEnv: [{ variable: "REQUIRED_TOKEN", message: "Set REQUIRED_TOKEN" }],
      configDiagnostics: { errors: ["Unknown workload"], warnings: [] },
    };
    h.localInfo.mockResolvedValue(info);
    h.sourceContent.mockResolvedValue({ ok: true, readPaths: ["**"] });
  });

  it.each(["owner", "admin", "member"])("retains scanner inputs and public output for a %s", async role => {
    h.members.set("org-a:alice", { id: "member-a", role });
    const original = structuredClone(info);
    const input = { owner: "acme", repo: "app", branch: "preview", composePath: "  deploy/compose.yaml  ", env: { API_TOKEN: secret } };
    const local = await native();
    const result = await local.deployments.prepare(input);
    expect(await remote().deployments.prepare(input)).toEqual(result);
    expect(result).toMatchObject({
      repository: info.repository, stack: "node", projectType: "services", buildCommand: "npm run build",
      composePath: "deploy/compose.yaml", productionPaths: ["dist"],
      rootEnv: { ROOT_TOKEN: ENV_MASK, EMPTY: "" }, openshipEnvKeys: ["DECLARED_TOKEN"],
      services: [{ name: "web", environment: { API_TOKEN: ENV_MASK, EMPTY: "" } }],
      missingRequiredEnv: info.missingRequiredEnv, configDiagnostics: info.configDiagnostics,
    });
    expect(result).not.toHaveProperty("openshipEnv");
    expect(result.services?.[0]).not.toHaveProperty("environmentTemplates");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(info).toEqual(original);
    expect(h.localInfo).toHaveBeenCalledTimes(2);
    for (const [source] of h.localInfo.mock.calls) {
      expect(source).toEqual({
        source: "github", provider: "github", owner: "acme", repo: "app", branch: "preview",
        composePath: "deploy/compose.yaml", env: { API_TOKEN: secret }, ctx: expect.any(Object),
      });
      expect(source.ctx).toMatchObject({ userId: "alice", organizationId: "org-a", membershipId: "member-a", role });
      expect(source.ctx).not.toHaveProperty("hono");
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) {
      expect(event).toMatchObject({ organizationId: "org-a", actorUserId: "alice", eventType: "deployment:write", resourceType: "deployment", resourceId: "*" });
    }
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(secret);
  });

  // Current grant creation rejects project-wide write, but the authorization
  // layer also handles persisted grants. Both entry points must agree on them.
  it.each(["restricted member", "scoped token"])("preserves the API's collection rule for a %s with a stored project-wide write grant", async principal => {
    if (principal === "restricted member") {
      h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
      h.grants.set("org-a:alice:project:*", { permissions: ["write"] });
    } else {
      h.identity = { ...alice, tokenScope: { tokenId: "prepare-token" }, credential: { organizationId: "org-a", readOnly: false } };
      h.grants.set("prepare-token:project:*", { permissions: ["write"] });
    }
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ owner: "acme", repo: "app" })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("retains empty-option defaults before calling the scanner", async () => {
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await deployments.prepare({ owner: "acme", repo: "app", composePath: "  ", env: {} });
    }
    expect(h.localInfo).toHaveBeenCalledTimes(2);
    for (const [source] of h.localInfo.mock.calls) {
      expect(source).toEqual({ source: "github", provider: "github", owner: "acme", repo: "app", branch: undefined, composePath: undefined, env: undefined, ctx: expect.any(Object) });
    }
  });

  it("rejects read-only credentials before scanning or recording success", async () => {
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ owner: "acme", repo: "app" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("retains the cloud refusal for local filesystem preparation", async () => {
    h.env.CLOUD_MODE = true;
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ source: "local", path: "/unread" })).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("returns editable source values in one authorized HTTP or native preparation", async () => {
    info.services!.push({
      name: "db", image: "postgres:16", ports: [], dependsOn: [], volumes: [],
      environment: { DB_PASSWORD: "sibling-secret" },
      buildArgs: { TOKEN: "build-argument-secret", INHERITED: null, EMPTY: "" },
    });
    const local = await native();
    const input = { owner: "acme", repo: "app", branch: "preview", composePath: " deploy/compose.yaml ", env: { OVERRIDE: "typed-value" }, includeEnv: true };
    for (const deployments of [remote().deployments, local.deployments]) {
      expect(await deployments.prepare(input)).toMatchObject({ services: [
        { name: "web", environment: { API_TOKEN: secret } },
        { name: "db", environment: { DB_PASSWORD: "sibling-secret" }, buildArgs: { TOKEN: "build-argument-secret", INHERITED: null, EMPTY: "" } },
      ] });
    }
    expect(h.localInfo).toHaveBeenCalledTimes(2);
    for (const [source] of h.localInfo.mock.calls) {
      expect(source).toMatchObject({ source: "github", owner: "acme", repo: "app", branch: "preview", composePath: "deploy/compose.yaml", env: { OVERRIDE: "typed-value" } });
      expect(source.ctx).toMatchObject({ userId: "alice", organizationId: "org-a" });
    }
    expect(h.sourceContent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ owner: "acme", repo: "app" }), "content-whole", "");
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) {
      expect(event.after).toEqual({ includeEnv: true });
    }
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("typed-value");
    expect(info.services?.[0]?.environment.API_TOKEN).toBe(secret);

    const response = await app.request("/api/deployments/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const deployments of [remote().deployments, local.deployments]) {
      expect(await deployments.prepare({ ...input, includeEnv: false })).toMatchObject({ services: [
        { name: "web", environment: { API_TOKEN: ENV_MASK } },
        { name: "db", environment: { DB_PASSWORD: ENV_MASK }, buildArgs: { TOKEN: ENV_MASK, INHERITED: null, EMPTY: "" } },
      ] });
    }
  });

  it("leaves non-GitHub source authorization to its provider strategy", async () => {
    const local = await native();
    const input = {
      provider: "gitlab" as const,
      owner: "acme",
      repo: "app",
      includeEnv: true,
    };

    for (const deployments of [remote().deployments, local.deployments]) {
      await deployments.prepare(input);
    }

    expect(h.sourceContent).not.toHaveBeenCalled();
    expect(h.localInfo).toHaveBeenCalledTimes(2);
    for (const [source] of h.localInfo.mock.calls) {
      expect(source).toMatchObject({
        source: "github",
        provider: "gitlab",
        owner: "acme",
        repo: "app",
      });
    }
  });

  it("does not turn deploy-only source access into permission to reveal file values", async () => {
    h.sourceContent.mockResolvedValue({ ok: false, readPaths: [] });
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ owner: "acme", repo: "app", includeEnv: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    // The original metadata scan remains available without content access.
    for (const deployments of [remote().deployments, local.deployments]) {
      expect(JSON.stringify(await deployments.prepare({ owner: "acme", repo: "app" }))).not.toContain(secret);
    }
  });

  it("rejects read-only credentials before an editable source scan", async () => {
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ owner: "acme", repo: "app", includeEnv: true })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.sourceContent).not.toHaveBeenCalled();
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("rejects invalid disclosure options before scanning", async () => {
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      for (const includeEnv of [null, "true", 1, {}, []]) {
        await expect(deployments.prepare({ owner: "acme", repo: "app", includeEnv: includeEnv as boolean })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("rejects editable local scans in cloud mode", async () => {
    h.env.CLOUD_MODE = true;
    const local = await native();
    for (const deployments of [remote().deployments, local.deployments]) {
      await expect(deployments.prepare({ source: "local", path: "/unread", includeEnv: true })).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(h.localInfo).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("HTTP/native service parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  it("uses the same strict write, audit, and output for a parent-scoped creator", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    h.serviceCreate.mockResolvedValue(serviceFixture());
    const local = await native();
    const input = { name: "web", environment: { TOKEN: "never-audit-this-value" }, commandArgv: ["sh", "-c", "echo ready"] };
    expect(await remote().services.create("project-a", input)).toEqual(await local.services.create("project-a", input));
    expect(h.serviceCreate).toHaveBeenCalledTimes(2);
    expect(h.serviceCreate.mock.calls[0]![0]).not.toHaveProperty("hono");
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("never-audit-this-value");
    await expect(remote().services.update("project-a", "service-a", { kind: "monorepo" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(local.services.update("project-a", "service-a", { kind: "monorepo" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.serviceUpdate).not.toHaveBeenCalled();
  });
  it("rejects a forged parent and cross-tenant service in both facades", async () => {
    const local = await native();
    for (const services of [remote().services, local.services]) {
      await expect(services.get("project-sibling", "service-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(services.get("project-b", "service-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.serviceGet).not.toHaveBeenCalled();
  });
  it("reveals only requested keys and records only their names", async () => {
    h.serviceReveal.mockResolvedValue({ TOKEN: "one-secret", PASSWORD: "different-secret" });
    const local = await native();
    for (const services of [remote().services, local.services]) {
      expect(await services.revealEnv("project-a", "service-a", { keys: ["TOKEN", "toString"] })).toEqual({ TOKEN: "one-secret" });
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0]![0].after).toMatchObject({ revealedEnvKeys: ["TOKEN"] });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("one-secret");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("different-secret");
  });
  it("preserves stale-env refusal fields and accepts a bodyless force query", async () => {
    h.serviceRestart.mockRejectedValue(new ServiceConfigStaleError("Pending env changes", ["TOKEN"], "web"));
    const local = await native();
    for (const services of [remote().services, local.services]) {
      await expect(services.restart("project-a", "service-a")).rejects.toMatchObject({ statusCode: 409, code: "SERVICE_CONFIG_STALE", details: { staleEnvKeys: ["TOKEN"], serviceName: "web" } });
    }
    h.serviceRestart.mockResolvedValue({ containerId: "container" });
    const response = await app.request("/api/projects/project-a/services/service-a/restart?force=1", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(200);
    expect(h.serviceRestart.mock.calls.at(-1)![3]).toEqual({ force: true });
  });
  it("audits bounded exec metadata without disclosing command output", async () => {
    h.serviceExec.mockResolvedValue({ exitCode: 0, output: "secret-command-output", timedOut: false, truncated: false, durationMs: 10 });
    const local = await native();
    expect(await local.services.exec("project-a", "service-a", { command: "  pwd  " })).toEqual(await remote().services.exec("project-a", "service-a", { command: "  pwd  " }));
    expect(h.serviceExec.mock.calls[0]![3]).toEqual({ command: "pwd" });
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ eventType: "service.exec", after: { command: "pwd", exitCode: 0, outputBytes: 21 } });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-command-output");
  });
});

describe("app HTTP/native parity through retained catalog, installer, and settings services", () => {
  const remote = (organizationId = "org-a") => new OpenshipClient({ baseUrl: "http://openship.test", organizationId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  const definition: AppTemplate = {
    id: "parity-app", name: "Parity App", description: "Shared installer fixture", kind: "template", logo: "box", category: "other",
    verified: true, available: true, minResources: { memoryMb: 512 },
    services: [{ name: "app", image: "nginx:1.27", exposedPort: 80 }],
    settings: [{ id: "main", label: "Settings", fields: [
      { service: "app", key: "TOKEN", label: "Token", type: "password", secret: true },
      { service: "app", key: "LABEL", label: "Label", type: "text" },
    ] }],
    connection: { outputs: [{ id: "token", label: "Token", source: "env:app:TOKEN", secret: true }] },
  };
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => Response.json({ apps: [] }));
    h.customApps.set(`org-a:${definition.id}`, { organizationId: "org-a", appId: definition.id, template: definition, createdByUserId: "alice", updatedAt: new Date("2026-09-12T00:00:00Z") });
    h.projectCreate.mockResolvedValue(projectFixture("installed-app"));
    h.serviceCreate.mockResolvedValue(serviceFixture());
  });
  afterEach(() => { vi.unstubAllGlobals(); h.projectCreate.mockReset(); h.serviceCreate.mockReset(); });

  it("uses authoritative upload validation, unverified provenance, and organization-scoped storage", async () => {
    const local = await native();
    for (const apps of [local.apps, remote().apps]) {
      expect(await apps.saveCustom(definition)).toEqual({ appId: definition.id });
      expect((await apps.getCatalogEntry(definition.id)).template).toMatchObject({ verified: false, custom: true });
      expect(await apps.listCustom()).toEqual([{ appId: definition.id, name: definition.name, updatedAt: "2026-09-12T00:00:00.000Z" }]);
      await expect(apps.saveCustom({ ...definition, connection: { outputs: [{ id: "bad", label: "Bad", source: "env:missing:TOKEN" }] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(h.customApps.get(`org-a:${definition.id}`)?.template.verified).toBe(false);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const apps of [(await native("org-b")).apps, remote("org-b").apps]) {
      expect(await apps.listCustom()).toEqual([]);
      await expect(apps.getCatalogEntry(definition.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await local.apps.removeCustom(definition.id);
    expect(await remote().apps.listCustom()).toEqual([]);
  });

  it("allows create-capable catalog browsing while hiding a draft without a current project grant", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:project:*", { permissions: ["create"] });
    h.appDraft.mockResolvedValue({ id: "project-a", slug: "parity-app", name: definition.name });
    const local = await native();
    for (const apps of [local.apps, remote().apps]) {
      expect((await apps.listCatalog()).some(row => row.id === definition.id)).toBe(true);
      expect((await apps.getCatalogEntry(definition.id)).draft).toBeNull();
    }
    h.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    expect((await local.apps.getCatalogEntry(definition.id)).draft?.projectId).toBe("project-a");
    expect((await remote().apps.getCatalogEntry(definition.id)).draft?.projectId).toBe("project-a");
  });

  it("passes create-only token authority into the existing project-creation transaction", async () => {
    h.identity = { ...alice, tokenScope: { tokenId: "app-token" }, credential: { organizationId: "org-a", readOnly: false } };
    h.grants.set("app-token:project:*", { permissions: ["create"] });
    const local = await native();
    const result = await local.apps.install({ templateId: definition.id });
    expect(await remote().apps.install({ templateId: definition.id })).toEqual(result);
    expect(result).toMatchObject({ kind: "template", projectId: "installed-app" });
    expect(h.projectCreate).toHaveBeenCalledTimes(2);
    for (const args of h.projectCreate.mock.calls) {
      expect(args).toEqual([expect.objectContaining({ appTemplateId: definition.id, projectType: "services" }), "org-a", { tokenId: "app-token" }]);
    }
    expect(h.serviceCreate.mock.calls.every(([ctx]) => ctx.role === "restricted" && !ctx.hono)).toBe(true);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const apps of [local.apps, remote().apps]) await expect(apps.saveCustom(definition)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses draft adoption before the retained installer mutates any project or service", async () => {
    h.identity = { ...alice, tokenScope: { tokenId: "app-token" }, credential: { organizationId: "org-a", readOnly: false } };
    h.grants.set("app-token:project:*", { permissions: ["create"] });
    h.appDraft.mockResolvedValue({ id: "project-a", slug: "parity-app", name: definition.name });
    for (const apps of [(await native()).apps, remote().apps]) {
      await expect(apps.install({ templateId: definition.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.projectCreate).not.toHaveBeenCalled();
    expect(h.serviceCreate).not.toHaveBeenCalled();
    expect(h.serviceUpdate).not.toHaveBeenCalled();
    expect(h.appEnvMerge).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("retains settings masking, blank-secret preservation, and one audit per write or credential reveal", async () => {
    h.projects.set("project-a", { ...projectFixture(), appTemplateId: definition.id });
    h.services.set("service-a", { ...serviceFixture(), name: "app" });
    const key = "project-a:production:service-a";
    h.appEnv.set(key, [{ key: "TOKEN", value: encrypt("original-app-secret"), isSecret: true }]);
    const local = await native();
    for (const projects of [local.projects, remote().projects]) {
      expect((await projects.getAppSettings("project-a")).values.find(row => row.key === "TOKEN")).toMatchObject({ secret: true, set: true, value: "" });
      expect(await projects.updateAppSettings("project-a", { changes: [{ service: "app", key: "TOKEN", value: "replacement-app-secret" }] })).toEqual({ count: 1, requiresRedeploy: false });
      expect(await projects.updateAppSettings("project-a", { changes: [{ service: "app", key: "TOKEN", value: "" }] })).toEqual({ count: 0, requiresRedeploy: false });
      expect((await projects.getAppConnection("project-a")).outputs[0]?.value).toBe("replacement-app-secret");
      expect(JSON.stringify(await projects.getAppSettings("project-a"))).not.toContain("replacement-app-secret");
    }
    expect(decrypt(h.appEnv.get(key)![0]!.value)).toBe("replacement-app-secret");
    expect(h.appEnvMerge).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("replacement-app-secret");
    expect(h.audit.mock.calls[0]![0].after).toMatchObject({ fields: [{ service: "app", key: "TOKEN" }] });
    expect(h.audit.mock.calls.filter(([row]) => row.after?.operation === "getAppConnection").map(([row]) => row.after.revealedOutputs)).toEqual([["token"], ["token"]]);
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    for (const projects of [local.projects, remote().projects]) {
      await expect(projects.getAppConnection("project-a")).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      expect((await projects.getAppSettings("project-a")).values[0]?.value).toBe("");
    }
  });

  it("checks server access before capacity probes and respects native host policy", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:project:*", { permissions: ["create"] });
    const local = await native();
    for (const apps of [local.apps, remote().apps]) {
      await expect(apps.hostFit(definition.id, { serverId: "server-b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(apps.hostFit(definition.id, { serverId: "server-a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.hostCapacity).not.toHaveBeenCalled();
    h.grants.set("org-a:alice:server:server-a", { permissions: ["read"] });
    expect(await local.apps.hostFit(definition.id, { serverId: "server-a" })).toEqual(await remote().apps.hostFit(definition.id, { serverId: "server-a" }));
    expect(h.hostCapacity).toHaveBeenCalledTimes(2);
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    expect(await local.apps.hostFit(definition.id)).toMatchObject({ capacity: { source: "unknown" }, fit: { ok: true } });
    expect(h.hostCapacity).toHaveBeenCalledTimes(2);
  });

  it("preserves installer refusals as structured 400 responses in both interfaces", async () => {
    for (const apps of [(await native()).apps, remote().apps]) {
      await expect(apps.install({ templateId: "unknown-template" })).rejects.toMatchObject({ statusCode: 400, code: "APP_INSTALL_FAILED", message: "unknown-app-template" });
    }
    expect(h.projectCreate).not.toHaveBeenCalled();
  });
});

describe("backup destination HTTP/native parity through retained storage services", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  function destination(id: string, organizationId: string): StoredBackupDestination {
    return { ...backupDestinationFixture(id), organizationId, accessKeyIdEnc: encryptSecretField("storage-access-key"), secretAccessKeyEnc: encryptSecretField("storage-private-secret"),
      sftpPasswordEnc: null, sftpPrivateKeyEnc: null, sftpKeyPassphraseEnc: null, lastVerifiedAt: null, deletedAt: null,
      createdAt: new Date("2026-09-12T00:00:00Z"), updatedAt: new Date("2026-09-12T00:00:00Z") };
  }
  beforeEach(() => {
    h.destinations.set("destination-a", destination("destination-a", "org-a"));
    h.destinations.set("destination-b", destination("destination-b", "org-b"));
    h.destinationCreate.mockImplementation(async input => {
      const row = { ...destination(input.id, input.organizationId), ...input };
      h.destinations.set(row.id, row);
      return row;
    });
    h.destinationUpdate.mockImplementation(async (id, input) => {
      const row = { ...h.destinations.get(id)!, ...input };
      h.destinations.set(id, row);
      return row;
    });
    h.destinationDelete.mockImplementation(async id => { h.destinations.delete(id); return { ok: true }; });
    h.destinationVerify.mockImplementation(async (id, ok, reason) => {
      const row = h.destinations.get(id)!;
      row.lastVerifiedAt = ok ? new Date("2026-09-12T01:00:00Z") : null;
      row.lastVerifyError = reason ?? null;
    });
    h.destinationProbe.mockResolvedValue({ ok: true, code: "ok", message: "Reachable" });
  });

  it("shares secret-free presentation and fixed tenant authority, including direct-ID grants", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:destination-a", { permissions: ["read"] });
    const local = await native();
    const expected = await local.backupDestinations.get("destination-a");
    expect(await remote().backupDestinations.get("destination-a")).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain("storage-private-secret");
    expect(expected).not.toHaveProperty("secretAccessKeyEnc");
    for (const destinations of [local.backupDestinations, remote().backupDestinations]) {
      expect(await destinations.usage("destination-a")).toEqual({ destination: expected, policies: [] });
      await expect(destinations.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(destinations.get("destination-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("shares paginated service/volume history without exposing restore commands through either interface", async () => {
    const history = ["recent", "previous", "older"].map((id) => ({
      ...backupRunFixture(id), startedAt: new Date("2026-09-25T11:00:00Z"), finishedAt: new Date("2026-09-25T11:01:00Z"),
      projectName: "Project A", serviceName: "database", mailServerName: null, destinationName: "Storage A",
      artifacts: [{ key: "archive", payloadKind: "volume", metadata: { volumeTarget: "/data", restoreCommand: "restore --password=private-restore-secret", storage: { format: "chunks-v1" } } }],
    }));
    h.backupHistoryRead.mockResolvedValue(history);
    const local = await native();
    const expected = await local.backupDestinations.runs("destination-a", { limit: 2, before: "cursor" });
    expect(expected.nextCursor).toBe("previous");
    expect(expected.runs).toHaveLength(2);
    expect(expected.runs[0]).toMatchObject({ id: "recent", serviceName: "database", payloads: [{ kind: "volume", volumeTarget: "/data", incremental: true }] });
    expect(JSON.stringify(expected)).not.toContain("private-restore-secret");
    expect(expected.runs[0]).not.toHaveProperty("artifacts");
    expect(await remote().backupDestinations.runs("destination-a", { limit: 2, before: "cursor" })).toEqual(expected);
    expect(h.backupHistoryRead).toHaveBeenLastCalledWith("org-a", { destinationId: "destination-a", before: "cursor", limit: 3 });
    expect(await remote().backupDestinations.history({ limit: 2 })).toEqual(await local.backupDestinations.history({ limit: 2 }));
    expect(h.backupHistoryRead).toHaveBeenLastCalledWith("org-a", { destinationId: undefined, before: undefined, limit: 3 });
    for (const api of [local.backupDestinations, remote().backupDestinations]) {
      await expect(api.runs("destination-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(api.history({ limit: 0 })).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("keeps direct destination grants scoped and preserves storage failures as server errors", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:destination-a", { permissions: ["read"] });
    const local = await native();
    for (const api of [local.backupDestinations, remote().backupDestinations]) {
      expect(await api.runs("destination-a")).toEqual({ runs: [], nextCursor: null });
      await expect(api.history()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(api.runs("destination-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    h.backupStats.mockRejectedValue(new Error("Database temporarily unavailable"));
    for (const api of [local.backupDestinations, remote().backupDestinations])
      await expect(api.usage("destination-a")).rejects.toMatchObject({ statusCode: 500, code: "BACKUP_DESTINATION_FAILED" });
  });

  it("presents outcome counts consistently in list and destination detail", async () => {
    h.backupStats.mockResolvedValue([{ destinationId: "destination-a", storedBytes: 1200, runCount: 8, savedCount: 2, activeCount: 1, failedCount: 4, cancelledCount: 1, lastRunAt: new Date("2026-09-25T11:00:00Z") }]);
    for (const api of [(await native()).backupDestinations, remote().backupDestinations]) {
      const [listed] = await api.list();
      expect(listed!.stats).toMatchObject({ runCount: 8, savedCount: 2, activeCount: 1, failedCount: 4, cancelledCount: 1 });
      expect((await api.usage("destination-a")).destination.stats).toEqual(listed!.stats);
    }
  });

  it("reuses credential encryption and records only create metadata", async () => {
    const local = await native();
    const input = { name: "New storage", kind: "s3_compatible" as const, bucket: "backups", accessKeyId: "fresh-access-key", secretAccessKey: "fresh-storage-secret" };
    const created = await local.backupDestinations.create(input);
    expect(await remote().backupDestinations.get(created.id)).toEqual(created);
    expect(decryptSecretField(h.destinations.get(created.id)!.secretAccessKeyEnc)).toBe("fresh-storage-secret");
    expect(created.hasSecretAccessKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain("fresh-storage-secret");
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ eventType: "backup_destination:write", resourceId: created.id, after: { operation: "create", name: input.name, kind: input.kind } });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("fresh-storage-secret");
    const fromHttp = await remote().backupDestinations.create({ ...input, name: "HTTP storage" });
    expect(await local.backupDestinations.get(fromHttp.id)).toEqual(fromHttp);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("preserves omitted credentials, clears explicit nulls, and audits field names once", async () => {
    const local = await native();
    const original = h.destinations.get("destination-a")!.secretAccessKeyEnc;
    expect(await local.backupDestinations.update("destination-a", { name: "Renamed" })).toMatchObject({ hasSecretAccessKey: true });
    expect(h.destinations.get("destination-a")!.secretAccessKeyEnc).toBe(original);
    expect(await remote().backupDestinations.update("destination-a", { secretAccessKey: "replacement-storage-secret" })).toMatchObject({ hasAccessKeyId: true, hasSecretAccessKey: true });
    expect(decryptSecretField(h.destinations.get("destination-a")!.secretAccessKeyEnc)).toBe("replacement-storage-secret");
    expect(await local.backupDestinations.update("destination-a", { secretAccessKey: null })).toMatchObject({ hasSecretAccessKey: false, hasAccessKeyId: true });
    expect(h.audit).toHaveBeenCalledTimes(3);
    expect(h.audit.mock.calls[1]![0].after).toEqual({ operation: "update", fields: ["secretAccessKey"] });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("replacement-storage-secret");
  });

  it("authorizes draft credential reuse before probing and leaves saved values unchanged", async () => {
    const local = await native();
    const stored = { ...h.destinations.get("destination-a")! };
    const input = { id: "destination-a", kind: "s3_compatible" as const, secretAccessKey: "" };
    for (const destinations of [local.backupDestinations, remote().backupDestinations]) {
      expect(await destinations.preflightDraft(input)).toEqual({ ok: true, code: "ok" });
      await expect(destinations.preflightDraft({ ...input, id: "destination-b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.destinationProbe).toHaveBeenCalledTimes(2);
    expect(h.destinationProbe.mock.calls[0]![1]).toMatchObject({ bucket: stored.bucket, secretAccessKeyEnc: stored.secretAccessKeyEnc });
    expect(h.destinations.get("destination-a")).toEqual(stored);
    expect(h.destinationUpdate).not.toHaveBeenCalled();
    expect(h.destinationVerify).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("requires server authority before using a destination's saved server credentials", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:*", { permissions: ["write"] });
    Object.assign(h.destinations.get("destination-a")!, { kind: "openship_server", serverId: "server-a" });
    const local = await native();
    for (const destinations of [local.backupDestinations, remote().backupDestinations]) {
      await expect(destinations.preflight("destination-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(destinations.create({ name: "Server storage", kind: "openship_server", serverId: "server-a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.destinationProbe).not.toHaveBeenCalled();
    expect(h.destinationCreate).not.toHaveBeenCalled();
    h.grants.set("org-a:alice:server:server-a", { permissions: ["write"] });
    expect(await local.backupDestinations.preflight("destination-a")).toEqual(await remote().backupDestinations.preflight("destination-a"));
    expect(h.destinationProbe).toHaveBeenCalledTimes(2);
    expect(h.destinationProbe.mock.calls[0]![1]).toMatchObject({ serverId: "server-a", sftpPrivateKeyEnc: "enc1:stored-secret" });
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("refuses host key files in native preflight before reaching a provider", async () => {
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    Object.assign(h.destinations.get("destination-a")!, { kind: "openship_server", serverId: "server-a" });
    Object.assign(h.servers.get("server-a")!, { sshPrivateKey: null, sshKeyPath: "/tmp/host-private-key" });
    const output = await (await native()).backupDestinations.preflight("destination-a");
    expect(output).toMatchObject({ ok: false });
    expect(output.reason).toContain("Host execution is disabled");
    expect(h.destinationProbe).not.toHaveBeenCalled();
  });

  it("retains readonly denial and active-policy deletion refusal", async () => {
    const local = await native();
    h.destinationDelete.mockResolvedValue({ ok: false, reason: "Destination has active policies" });
    for (const destinations of [local.backupDestinations, remote().backupDestinations]) {
      await expect(destinations.remove("destination-a")).rejects.toMatchObject({ statusCode: 400, code: "BACKUP_DESTINATION_FAILED", message: "Destination has active policies" });
    }
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    for (const destinations of [local.backupDestinations, remote().backupDestinations]) {
      await expect(destinations.preflight("destination-a")).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(destinations.update("destination-a", { name: "Forbidden" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.destinationProbe).not.toHaveBeenCalled();
    expect(h.destinationUpdate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.members.clear();
  h.projects.clear();
  h.customApps.clear();
  h.appEnv.clear();
  h.destinations.clear();
  h.backupPolicies.clear(); h.backupRuns.clear(); h.backupRestores.clear();
  h.backupHistoryRead.mockResolvedValue([]); h.backupStats.mockResolvedValue([]);
  h.appDraft.mockResolvedValue(null);
  h.appEnvMerge.mockImplementation(async (id, environment, upserts, deletes, service) => {
    const key = `${id}:${environment}:${service}`;
    const rows = new Map((h.appEnv.get(key) ?? []).map(row => [row.key, row]));
    for (const name of deletes) rows.delete(name);
    for (const row of upserts) rows.set(row.key, row);
    h.appEnv.set(key, [...rows.values()]);
  });
  h.hostCapacity.mockResolvedValue({ cpuCores: 4, memoryMb: 4096, source: "docker" });
  h.deployments.clear();
  h.grants.clear();
  h.services.clear();
  h.domains.clear();
  h.servers.clear();
  h.containerRows.clear();
  h.instanceRoles.clear();
  h.tunnels.clear();
  h.tunnelUpsert.mockImplementation(async data => {
    const previous = [...h.tunnels.values()].find(row => row.serverId === data.serverId && row.remotePort === data.remotePort && row.remoteHost === data.remoteHost);
    const row = { ...previous, ...data, id: previous?.id ?? `tunnel-${data.serverId}-${data.remotePort}` };
    h.tunnels.set(row.id, row);
    return row;
  });
  h.tunnelRemove.mockImplementation(async id => { h.tunnels.delete(id); });
  h.tunnelClose.mockResolvedValue(undefined);
  h.tunnelForward.mockResolvedValue({ localPort: 49100, remoteHost: "127.0.0.1", remotePort: 5432, activeConnections: 0, close: h.tunnelClose });
  h.settings = undefined;
  h.settingsUpsert.mockImplementation(async patch => (h.settings = { ...h.settings, ...patch }));
  h.settingsDelete.mockImplementation(async () => { h.settings = undefined; });
  h.mailAvailable.mockResolvedValue(false);
  h.mailTest.mockResolvedValue(undefined);
  h.orphanScan.mockResolvedValue({ scanned: true, orphans: [], knownCount: 2 });
  h.orphanRemove.mockResolvedValue({ removed: true });
  clearAuthModeCache();
  clearProductModeCache();
  clearHostControlCache();
  clearBoxOwningOrgCache();
  configureNativeSourceRoots([]);
  h.env.CLOUD_MODE = false;
  h.env.DEPLOY_MODE = "docker";
  h.env.OPENSHIP_AUTH_MODE = undefined;
  h.env.OPENSHIP_ALLOW_ZERO_AUTH = false;
  h.identity = alice;
  h.members.set("org-a:alice", { id: "member-a", role: "owner" });
  h.members.set("org-b:alice", { id: "member-b", role: "member" });
  h.projects.set("project-a", { organizationId: "org-a" });
  h.projects.set("project-b", { organizationId: "org-b" });
  h.projects.set("project-sibling", { organizationId: "org-a" });
  h.deployments.set("dep-project-a", storedDeployment("project-a", "org-a"));
  h.deployments.set("dep-project-b", storedDeployment("project-b", "org-b"));
  h.services.set("service-a", { projectId: "project-a" });
  h.services.set("service-b", { projectId: "project-b" });
  h.domains.set("domain-a", { projectId: "project-a" });
  h.domains.set("domain-b", { projectId: "project-b" });
  h.servers.set("server-a", { ...serverFixture(), organizationId: "org-a", sshPrivateKey: "enc1:stored-secret" });
  h.servers.set("server-b", { ...serverFixture("server-b"), organizationId: "org-b" });
  h.serverWithExecutor.mockImplementation(async (_id, work) => work({}));
  h.serverExec.mockResolvedValue({ output: "private-output", exitCode: 0, timedOut: false, truncated: false, durationMs: 1 });
  h.serverWorkloads.mockResolvedValue([]);
  h.serverRateRead.mockResolvedValue({ rps: 10, burst: 20, whitelist: [] });
  h.serverCreate.mockImplementation(async data => ({ ...serverFixture("server-new"), ...data, organizationId: "org-a" }));
  h.serverUpdate.mockImplementation(async (id, patch) => ({ ...h.servers.get(id), ...patch }));
  h.componentCheck.mockImplementation(async (_executor, names: string[]) => names.map(name => ({
    name, label: name, description: `${name} component`, installable: true, installed: true, healthy: true, message: "ready",
  })));
  h.installDocker.mockResolvedValue({ component: "docker", success: true });
  h.installEdge.mockResolvedValue({ component: "edge", success: true });
  h.removeEdge.mockResolvedValue({ component: "edge", success: true });
  h.monitorExec.mockResolvedValue(JSON.stringify({ cpu: 10, memUsed: 1024 }));
  h.containerRows.set("server-a:edge", serverContainerFixture());
  h.containerRows.set("server-b:edge", serverContainerFixture("server-b", "org-b"));
  h.mailRecord.mockResolvedValue(undefined);
  h.containerUpsert.mockImplementation(async row => {
    const key = `${row.serverId}:${row.component}`;
    h.containerRows.set(key, { ...serverContainerFixture(row.serverId, row.organizationId), ...h.containerRows.get(key), ...row });
  });
  h.containerProgress.mockImplementation(async (id, component, value) => {
    const row = h.containerRows.get(`${id}:${component}`);
    if (row) row.latestInProgress = value;
  });
  h.reconcileEdge.mockResolvedValue({ updated: true, edgeDown: false });
  h.cloudOwner.mockResolvedValue(null);
  h.cloudFetch.mockResolvedValue(null);
  h.audit.mockResolvedValue({ id: "audit" });
  h.rulePush.mockResolvedValue(undefined);
  h.trigger.mockImplementation(async (ctx, input) => ({
    deployment: {
      ...storedDeployment(input.projectId, ctx.organizationId),
      meta: {
        composeServices: [{ name: "web", environment: { API_TOKEN: secret } }],
      },
    },
  }));
});

describe("deployment inspection HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  const usage = { cpuPercent: 12, memoryMb: 64, diskMb: 128, networkRxBytes: 123, networkTxBytes: 456 };
  const cases = [
    { method: "containerInfo", engine: h.deploymentContainerInfo, result: { containerId: "primary-service", status: "running", hostPortByContainerPort: { "8080": 49100 }, usage } },
    { method: "containerUsage", engine: h.deploymentContainerUsage, result: usage },
    { method: "pendingActions", engine: h.deploymentPendingActions, result: [] },
  ] as const;

  it.each(cases)("shares $method output and preserves the engine's tenant argument", async ({ method, engine, result }) => {
    engine.mockResolvedValue(result);
    const local = await native();
    const expected = method === "pendingActions" ? { actions: result } : result;
    expect(await local.deployments[method]("dep-project-a")).toEqual(expected);
    expect(await remote().deployments[method]("dep-project-a")).toEqual(expected);
    expect(engine.mock.calls).toEqual([["dep-project-a", "org-a"], ["dep-project-a", "org-a"]]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(cases)("checks current parent access before $method reaches the runtime", async ({ method, engine }) => {
    const local = await native();
    await expect(local.deployments[method]("dep-project-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(remote().deployments[method]("dep-project-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    await expect(local.deployments[method]("dep-project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(remote().deployments[method]("dep-project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(engine).not.toHaveBeenCalled();
  });
});

describe("hostname SSL HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  beforeEach(() => {
    h.domains.set("domain-a", { ...domainFixture(), id: "domain-a", projectId: "project-a", hostname: "app.example.com", sslStatus: "active", sslIssuer: "Let's Encrypt", sslExpiresAt: "2026-12-01T00:00:00.000Z", verified: true });
    h.domains.set("domain-www", { ...h.domains.get("domain-a")!, id: "domain-www", projectId: "project-a", hostname: "www.app.example.com" });
    h.manageSsl.mockResolvedValue({ expiresAt: "2026-12-01T00:00:00.000Z", issuer: "Let's Encrypt" });
    h.domainGet.mockImplementation(async (_ctx, id) => h.domains.get(id));
  });

  it("returns persisted status without probing or renewing a certificate", async () => {
    const result = await (await native()).deployments.sslStatus({ domain: "app.example.com" });
    expect(result).toMatchObject({ success: true, domain: "app.example.com", sslStatus: "active", verified: true });
    expect(await remote().deployments.sslStatus({ domain: "app.example.com" })).toEqual(result);
    expect(h.manageSsl).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("keeps primary and www renewal outcomes independent, with one audit per operation", async () => {
    h.manageSsl.mockImplementation(async hostname => {
      if (hostname.startsWith("www.")) throw new Error("www DNS is not pointed here");
      return { expiresAt: "2026-12-01T00:00:00.000Z", issuer: "Let's Encrypt" };
    });
    const input = { domain: "app.example.com", includeWww: true };
    const result = await (await native()).deployments.renewSsl(input);
    expect(await remote().deployments.renewSsl(input)).toEqual(result);
    expect(result).toMatchObject({ success: true, status: "active", results: [
      { domain: "app.example.com", success: true }, { domain: "www.app.example.com", success: false, status: "error", message: "www DNS is not pointed here" },
    ] });
    expect(h.manageSsl.mock.calls.map(call => call[0])).toEqual(["app.example.com", "www.app.example.com", "app.example.com", "www.app.example.com"]);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("reports provisioning when a provider issues no certificate", async () => {
    h.manageSsl.mockResolvedValue({});
    for (const deployments of [(await native()).deployments, remote().deployments]) {
      expect(await deployments.renewSsl({ domain: "app.example.com" })).toMatchObject({ success: false, status: "provisioning" });
    }
  });

  it("rejects read-only credentials before renewal and rechecks each hostname's organization", async () => {
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    for (const deployments of [(await native()).deployments, remote().deployments]) {
      await expect(deployments.renewSsl({ domain: "app.example.com" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.manageSsl).not.toHaveBeenCalled();
    h.identity = alice;
    h.domains.get("domain-www")!.projectId = "project-b";
    const result = await (await native()).deployments.renewSsl({ domain: "app.example.com", includeWww: true });
    expect(result.results[1]).toMatchObject({ success: false, status: "error" });
    expect(h.manageSsl.mock.calls.map(call => call[0])).toEqual(["app.example.com"]);
  });

  it("preserves certificate errors and refuses native host execution before ACME", async () => {
    h.manageSsl.mockRejectedValue(new Error("ACME challenge failed"));
    for (const deployments of [(await native()).deployments, remote().deployments]) {
      await expect(deployments.renewSsl({ domain: "app.example.com" })).rejects.toMatchObject({ code: "SSL_OPERATION_FAILED", message: "ACME challenge failed" });
    }
    h.manageSsl.mockClear();
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    await expect((await native()).deployments.renewSsl({ domain: "app.example.com" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
    expect(h.manageSsl).not.toHaveBeenCalled();
  });
});

describe("deployment HTTP/native parity", () => {
  it("uses the same operation, masks secrets, preserves inputs, and emits one audit event per call", async () => {
    const input = {
      projectId: "project-a",
      serverId: "server-a",
      forceAll: true,
      serviceIds: ["service-a"],
      smartRoute: false,
      refresh: false,
    };
    const scoped = await native();
    const result = await scoped.deployments.create(input);
    const response = await http(input);
    expect(response.status).toBe(202);
    expect((await response.json()).data).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(h.trigger).toHaveBeenCalledTimes(2);
    for (const [ctx, command] of h.trigger.mock.calls) {
      expect(ctx).toMatchObject({ userId: "alice", organizationId: "org-a", role: "owner" });
      expect(ctx).not.toHaveProperty("hono");
      expect(command).toMatchObject(input);
    }
    expect(h.audit).toHaveBeenCalledTimes(2); // route middleware must not duplicate the operation event
    for (const [event] of h.audit.mock.calls)
      expect(event).toMatchObject({
        actorUserId: "alice",
        organizationId: "org-a",
        eventType: "deployment:write",
        resourceId: "dep-project-a",
      });
    const raw = (await h.trigger.mock.results[0]!.value).deployment;
    expect(raw.meta.composeServices[0].environment.API_TOKEN).toBe(secret);
  });

  it("denies both entry points after a grant is revoked even if the SDK already holds a scope", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    const scoped = await native();
    await scoped.deployments.create({ projectId: "project-a" });
    expect((await http({ projectId: "project-a" })).status).toBe(202);
    h.grants.clear();
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await http({ projectId: "project-a" })).status).toBe(404);
    expect(h.trigger).toHaveBeenCalledTimes(2);
  });

  it("forces an owner's scoped token to use token grants on both transports", async () => {
    h.identity = {
      ...alice,
      tokenScope: { tokenId: "token-a" },
      credential: { organizationId: "org-a", readOnly: false },
    };
    const scoped = await native();
    await expect(scoped.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await http({ projectId: "project-a" })).status).toBe(404);
    h.grants.set("token-a:project:project-a", { permissions: ["write"] });
    await scoped.deployments.create({ projectId: "project-a" });
    expect((await http({ projectId: "project-a" })).status).toBe(202);
    expect(h.trigger.mock.calls.every(([ctx]) => ctx.role === "restricted")).toBe(true);
  });

  it("keeps native and remote SDK scopes fixed while preserving legacy HTTP resource-derived scope", async () => {
    const scoped = await native();
    await expect(scoped.deployments.create({ projectId: "project-b" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const client = new OpenshipClient({
      baseUrl: "http://openship.test",
      organizationId: "org-a",
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
    await expect(client.deployments.create({ projectId: "project-b" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    const response = await http({ projectId: "project-b" });
    expect(response.status).toBe(202);
    expect(h.trigger).toHaveBeenCalledOnce();
    expect(h.trigger.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-b",
      role: "member",
      membershipId: "member-b",
    });
  });

  it.each([
    {},
    { projectId: "project-a", serviceIds: [1] },
    { projectId: "project-a", forceAll: "yes" },
  ])("rejects the same invalid command before orchestration: %j", async (input) => {
    const scoped = await native();
    await expect(scoped.deployments.create(input as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await http(input)).status).toBe(400);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("does not expose internal rollback/migration flags through HTTP or native commands", async () => {
    const input = {
      projectId: "project-a",
      reuseSnapshot: { meta: "unsafe" },
      handoverImages: [],
      rollbackStrategy: "git",
      forcePullImages: true,
      trigger: "rollback",
    };
    await (await native()).deployments.create(input);
    expect((await http(input)).status).toBe(202);
    for (const [, command] of h.trigger.mock.calls) {
      expect(command).toEqual({ projectId: "project-a", trigger: undefined });
    }
  });

  it("reuses legacy cloud routing with sanitized inputs and one local audit event", async () => {
    h.cloudOwner.mockResolvedValue("cloud-owner");
    const data = {
      deployment_id: "cloud-deployment",
      project_id: "cloud-project",
      deployment: { ...deploymentFixture("cloud-project", "cloud-org"), id: "cloud-deployment" },
    };
    h.cloudFetch.mockImplementation(async () => Response.json({ data }, { status: 202 }));
    const response = await http({
      projectId: "cloud-project",
      trigger: "webhook",
      reuseSnapshot: {},
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data });
    expect(h.cloudFetch).toHaveBeenCalledWith(
      "org-a",
      "/api/deployments",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(h.cloudFetch.mock.calls[0]![2].body)).toEqual({
      projectId: "cloud-project",
      trigger: "webhook",
    });
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledOnce();
  });

  it("validates cloud results without retrying or falling back after a malformed success", async () => {
    h.cloudOwner.mockResolvedValue("cloud-owner");
    h.cloudFetch.mockImplementation(async () =>
      Response.json(
        {
          data: {
            deployment_id: "cloud-deployment",
            project_id: "cloud-project",
            deployment: { id: "cloud-deployment" },
          },
        },
        { status: 202 },
      ),
    );
    const response = await http({ projectId: "cloud-project" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "INVALID_CLOUD_RESPONSE" });
    expect(h.cloudFetch).toHaveBeenCalledOnce();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses ambiguous cloud-owner forwarding for a fixed tenant before making an upstream mutation", async () => {
    h.cloudOwner.mockResolvedValue("cloud-owner");
    await expect(
      (await native()).deployments.create({ projectId: "cloud-project" }),
    ).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(h.cloudFetch).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("supports fixed native calls on the canonical cloud installation itself", async () => {
    h.env.CLOUD_MODE = true;
    const result = await (await native()).deployments.create({ projectId: "project-a" });
    expect(result.project_id).toBe("project-a");
    expect(h.trigger).toHaveBeenCalledOnce();
    expect(h.cloudFetch).not.toHaveBeenCalled();
  });

  it("preserves an upstream error without falling back to local orchestration or auditing success", async () => {
    h.cloudOwner.mockResolvedValue("cloud-owner");
    h.cloudFetch.mockImplementation(async () =>
      Response.json({ error: "Upgrade required", code: "PLAN_LIMIT" }, { status: 403 }),
    );
    const response = await http({ projectId: "cloud-project" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Upgrade required", code: "PLAN_LIMIT" });
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("project controls HTTP/native parity", () => {
  it("imports the scanner's Compose metadata through the shared create path and audits once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-import-parity-"));
    try {
      const services = [{ name: "api", image: "node:22", environment: { TOKEN: secret } }];
      const info = { name: "Imported", stack: "node", projectType: "services", packageManager: "npm", installCommand: "npm ci", buildCommand: "npm run build", startCommand: "node server.js", buildImage: "node:22", outputDirectory: "dist", rootDirectory: "./", productionPaths: ["dist"], services };
      h.localInfo.mockResolvedValue(info);
      h.projectCreate.mockImplementation(async input => ({ ...projectFixture("imported", input.name), localPath: input.localPath, gitProvider: "local" }));
      const command = { name: "Imported", localPath: directory };
      const result = await (await native()).projects.importLocal(command);
      const response = await app.request("/api/projects/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command, services: [{ name: "untrusted-override" }] }) });
      expect(response.status).toBe(201);
      expect((await response.json()).data).toEqual(result);
      expect(h.projectCreate).toHaveBeenCalledTimes(2);
      for (const [input, organizationId] of h.projectCreate.mock.calls) {
        expect(organizationId).toBe("org-a");
        expect(input).toMatchObject({ gitProvider: "local", framework: "node", installCommand: "npm ci", productionPaths: "dist", services, hasBuild: true, hasServer: true });
      }
      expect(h.audit).toHaveBeenCalledTimes(2);
      for (const [event] of h.audit.mock.calls) {
        expect(event).toMatchObject({ resourceId: "imported", eventType: "project.created", after: { source: "local", serviceCount: 1 } });
        expect(JSON.stringify(event)).not.toContain(secret);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  const teardown = {
    ok: false,
    rowDeleted: false,
    steps: [],
    unrecoverable: [],
    orphaned: [],
    unlinked: [],
    canForceOrphan: false,
  };
  const remote = () =>
    new OpenshipClient({
      baseUrl: "http://openship.test",
      organizationId: "org-a",
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });

  it.each([
    { ...teardown, rejection: "claim_lock_held", code: "PROJECT_DELETION_IN_PROGRESS" },
    {
      ...teardown,
      canForceOrphan: true,
      unrecoverable: [{ step: "containers", status: "failed", error: "Destroy failed" }],
      code: "PROJECT_TEARDOWN_FAILED",
    },
    {
      ...teardown,
      rejection: "active_work",
      active: {
        summary: "Deployment is running",
        hasActiveDeployment: true,
        hasActiveBackup: false,
        hasActiveBackupRestore: false,
        hasActiveMigration: false,
        activeDeploymentIds: ["dep-a"],
        activeBackupRunIds: [],
        activeBackupRestoreIds: [],
        activeMigrationIds: [],
      },
      code: "PROJECT_HAS_ACTIVE_WORK",
    },
  ])(
    "preserves deletion rejection details and one audit through both facades: $code",
    async ({ code, ...result }) => {
      h.projectTeardown.mockResolvedValue(result);
      const nativeError = await (await native()).projects
        .remove("project-a")
        .catch((error) => error);
      const remoteError = await remote()
        .projects.remove("project-a")
        .catch((error) => error);
      expect(nativeError).toMatchObject({ code, statusCode: 409 });
      expect(remoteError).toMatchObject({ code, statusCode: 409, details: nativeError.details });
      expect(h.projectTeardown).toHaveBeenCalledTimes(2);
      expect(h.audit).toHaveBeenCalledTimes(2);
    },
  );

  it("retains partial deletion cleanup as a result and normalizes force-orphan for the engine", async () => {
    const failure = { step: "webmail", status: "failed", error: "Cannot clean directory" };
    h.projectTeardown.mockResolvedValue({
      ...teardown,
      rowDeleted: true,
      steps: [failure],
      unrecoverable: [failure],
    });
    const result = await (await native()).projects.remove("project-a", { forceOrphan: true });
    const response = await app.request("/api/projects/project-a?forceOrphan=true", {
      method: "DELETE",
    });
    expect(response.status).toBe(207);
    expect(await response.json()).toEqual(result);
    expect(result).toMatchObject({ ok: false, unrecoverable: [failure] });
    for (const [ctx, id, options] of h.projectTeardown.mock.calls) {
      expect(ctx).toMatchObject({ userId: "alice", organizationId: "org-a" });
      expect(ctx).not.toHaveProperty("hono");
      expect(id).toBe("project-a");
      expect(options).toEqual({
        force: true,
        forceOrphan: true,
        wipeVolumes: false,
        recordOnly: false,
      });
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) expect(event.eventType).toBe("project.deleted");
  });

  it("preserves actionable Git installation errors without writing a success audit", async () => {
    h.projectLinkRepo.mockResolvedValue({
      ok: false,
      code: "app_not_installed",
      installUrl: "https://github.com/apps/openship/installations/new",
      owner: "acme",
    });
    const command = { owner: "acme", repo: "example", branch: "main" };
    const nativeError = await (await native()).projects
      .linkRepo("project-a", command)
      .catch((error) => error);
    const remoteError = await remote()
      .projects.linkRepo("project-a", command)
      .catch((error) => error);
    expect(nativeError).toMatchObject({
      statusCode: 400,
      details: { owner: "acme", install_url: "https://github.com/apps/openship/installations/new" },
    });
    expect(remoteError).toMatchObject({ details: nativeError.details });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("shares release source masking and records a single transition audit for each facade", async () => {
    const raw = {
      ...projectFixture(),
      cloneTokenEncrypted: secret,
      webhookSecret: secret,
      gitProvider: "release",
    };
    h.projectReleaseSource.mockResolvedValue(raw);
    const command = {
      artifactKind: "image" as const,
      mode: "github" as const,
      repo: "acme/example",
      imageTemplate: "ghcr.io/acme/example:{tag}",
    };
    const result = await (await native()).projects.setReleaseImageSource("project-a", command);
    expect(await remote().projects.setReleaseImageSource("project-a", command)).toEqual(result);
    expect(result).not.toHaveProperty("cloneTokenEncrypted");
    expect(result).not.toHaveProperty("webhookSecret");
    expect(raw.cloneTokenEncrypted).toBe(secret);
    expect(h.projectReleaseSource).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) {
      expect(event).toMatchObject({
        eventType: "project.updated",
        after: { action: "release-image-source.set" },
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    }
  });

  it("shares options presentation and records exactly one audit per call", async () => {
    const raw = {
      ...projectFixture(),
      cloneTokenEncrypted: secret,
      webhookSecret: secret,
      buildCommand: "npm run build",
    };
    h.projectOptions.mockResolvedValue(raw);
    const scoped = await native();
    const input = { buildCommand: "npm run build" };
    const result = await scoped.projects.setOptions("project-a", input);
    const response = await app.request("/api/projects/project-a/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(result);
    expect(result).not.toHaveProperty("cloneTokenEncrypted");
    expect(result).not.toHaveProperty("webhookSecret");
    expect(raw.cloneTokenEncrypted).toBe(secret);
    expect(h.projectOptions).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) {
      expect(event).toMatchObject({
        organizationId: "org-a",
        actorUserId: "alice",
        eventType: "project.updated",
        after: { action: "options.set", keys: ["buildCommand"] },
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    }
  });

  it("retains variable merge semantics and keeps all values out of audit history", async () => {
    h.projectEnvMerge.mockResolvedValue({ upserted: 1, deleted: 1 });
    const input = {
      environment: "production" as const,
      upserts: [{ key: "TOKEN", value: secret, isSecret: true }],
      deletes: ["OLD_TOKEN"],
    };
    const scoped = await native();
    const result = await scoped.projects.mergeEnvVars("project-a", input);
    const response = await app.request("/api/projects/project-a/env", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(h.projectEnvMerge).toHaveBeenCalledTimes(2);
    for (const call of h.projectEnvMerge.mock.calls)
      expect(call).toEqual(["project-a", "org-a", input]);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [event] of h.audit.mock.calls) {
      expect(event.after).toEqual({
        action: "envVars.merge",
        environment: "production",
        upsertedNames: ["TOKEN"],
        deletedNames: ["OLD_TOKEN"],
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    }
  });

  it("keeps fixed scopes inside their tenant and rechecks revoked membership", async () => {
    const scoped = await native();
    h.projectBranch.mockResolvedValue({ success: true, branch: "main" });
    await expect(scoped.projects.setBranch("project-b", { branch: "main" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Openship-Scope": "fixed",
      "X-Organization-Id": "org-a",
    };
    expect(
      (
        await app.request("/api/projects/project-b/branch", {
          method: "POST",
          headers,
          body: JSON.stringify({ branch: "main" }),
        })
      ).status,
    ).toBe(404);
    h.members.delete("org-a:alice");
    await expect(scoped.projects.setBranch("project-a", { branch: "main" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (
        await app.request("/api/projects/project-a/branch", {
          method: "POST",
          headers,
          body: JSON.stringify({ branch: "main" }),
        })
      ).status,
    ).toBe(404);
    expect(h.projectBranch).not.toHaveBeenCalled();
  });
});

describe("domain and DNS HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  it("lists and creates domains with a project grant and preserves sibling results", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    const result = { domain: domainFixture(), records: { mode: "external", records: [] }, www: { id: "www", hostname: "www.example.com" } };
    h.domainCreate.mockResolvedValue(result);
    h.domainList.mockResolvedValue([result.domain]);
    const local = await native();
    const input = { hostname: "app.example.com", includeWww: true, externalIngress: true };
    expect(await remote().domains.create("project-a", input)).toEqual(await local.domains.create("project-a", input));
    expect(await remote().domains.list("project-a")).toEqual(await local.domains.list("project-a"));
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.domainCreate.mock.calls[0]![0]).not.toHaveProperty("hono");
    expect(h.domainCreate.mock.calls[0]![1]).toEqual({ ...input, projectId: "project-a" });
    expect((await app.request("/api/domains")).status).toBe(400);
  });
  it("returns the same failed-verification result and audit while retaining HTTP 422", async () => {
    const result = { verified: false, cnameVerified: false, txtVerified: true, message: "DNS is still propagating" };
    h.domainVerify.mockResolvedValue(result);
    const local = await native();
    expect(await remote().domains.verify("domain-a", { force: true })).toEqual(await local.domains.verify("domain-a", { force: true }));
    expect(h.domainVerify).toHaveBeenCalledTimes(2);
    expect(h.domainVerify.mock.calls[0]![2]).toMatchObject({ force: true });
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect((await app.request("/api/domains/domain-a/verify", { method: "POST" })).status).toBe(422);
  });
  it("flushes terminal stream events through both facades without interactive notifications", async () => {
    h.domainVerify.mockImplementation(async (_ctx, _id, options) => {
      options.onLog("Certificate issued");
      return { verified: true, cnameVerified: true, txtVerified: true, message: "Verified" };
    });
    const local = await native();
    for (const domains of [remote().domains, local.domains]) {
      const events = [];
      for await (const event of domains.verifyStream("domain-a")) events.push(event);
      expect(events.map(event => event.event)).toEqual(["session", "log", "log", "complete"]);
      expect(JSON.parse(events.at(-1)!.data)).toEqual({ type: "complete", status: "completed" });
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("refuses foreign domains and explicit foreign DNS targets in both facades", async () => {
    const local = await native();
    for (const domains of [remote().domains, local.domains]) {
      await expect(domains.get("domain-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(domains.records("domain-a", { serverId: "server-b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.domainGet).not.toHaveBeenCalled();
    expect(h.domainRecords).not.toHaveBeenCalled();
  });
  it("passes only the caller's scope and resource authorization into batch verification", async () => {
    h.domainPending.mockResolvedValue({ verified: 0, stillPending: 0, failed: 0, total: 0, details: [] });
    const local = await native();
    expect(await local.domains.verifyPending({ limit: 10 })).toEqual(await remote().domains.verifyPending({ limit: 10 }));
    for (const [input, contextFor] of h.domainPending.mock.calls) {
      expect(input).toEqual({ limit: 10, organizationId: "org-a" });
      expect(await contextFor("domain-a", "verify")).toMatchObject({ organizationId: "org-a", userId: "alice" });
      expect(await contextFor("domain-b", "provision")).toBeNull();
    }
  });
  it("keeps certificate contents out of audit and preserves the cloud upload refusal", async () => {
    h.domainUpload.mockResolvedValue({ domain: "app.example.com", sslStatus: "active", issuer: "manual" });
    const local = await native();
    const input = { certPem: "private-certificate-content", keyPem: "private-key-content" };
    expect(await local.domains.uploadCert("domain-a", input)).toEqual(await remote().domains.uploadCert("domain-a", input));
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("private-key-content");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("private-certificate-content");
    h.env.CLOUD_MODE = true;
    await expect(local.domains.uploadCert("domain-a", input)).rejects.toMatchObject({ statusCode: 404 });
    await expect(remote().domains.uploadCert("domain-a", input)).rejects.toMatchObject({ status: 404 });
    expect(h.domainUpload).toHaveBeenCalledTimes(2);
  });
  it("enforces administrator membership on both credential writes and never audits tokens", async () => {
    h.dnsAdd.mockResolvedValue(dnsCredentialFixture());
    const input = { provider: "cloudflare" as const, name: "Production", apiToken: "never-audit-dns-token" };
    const local = await native();
    h.members.set("org-a:alice", { id: "member-a", role: "member" });
    for (const dns of [remote().dns, local.dns]) {
      await expect(dns.addCredential(input)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await expect(dns.removeCredential("dns-a")).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    }
    expect(h.dnsAdd).not.toHaveBeenCalled();
    expect(h.dnsRemove).not.toHaveBeenCalled();
    h.members.set("org-a:alice", { id: "member-a", role: "admin" });
    expect(await local.dns.addCredential(input)).toEqual(await remote().dns.addCredential(input));
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(input.apiToken);
  });
});

describe("project routing HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  const rule = { id: "rule-a", organizationId: "org-a", projectId: "project-a", domainId: "domain-a", pathPrefix: "/api", spec: { access: { methods: ["GET"] } }, enabled: true, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" };
  it("retains the sanitizer, project/domain checks, edge push, and one audit per facade", async () => {
    h.ruleCreate.mockResolvedValue(rule);
    const input = { domainId: "domain-a", pathPrefix: " api ", spec: { access: { methods: ["get", "GET", "made-up"] } } };
    const local = await native();
    expect(await remote().projects.createRouteRule("project-a", input)).toEqual(await local.projects.createRouteRule("project-a", input));
    for (const [data] of h.ruleCreate.mock.calls) expect(data).toMatchObject({ organizationId: "org-a", projectId: "project-a", domainId: "domain-a", pathPrefix: "/api", spec: { access: { methods: ["GET"] } } });
    expect(h.rulePush).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const projects of [remote().projects, local.projects]) {
      await expect(projects.createRouteRule("project-a", { domainId: "domain-b" })).rejects.toMatchObject({ code: "INVALID_DOMAIN" });
    }
    expect(h.ruleCreate).toHaveBeenCalledTimes(2);
  });
  it("rejects forged rule/project pairs and keeps rule deletion scoped", async () => {
    h.ruleGet.mockResolvedValue(rule);
    h.ruleRemove.mockResolvedValue(undefined);
    const local = await native();
    for (const projects of [remote().projects, local.projects]) {
      await expect(projects.updateRouteRule("project-sibling", { ruleId: rule.id, enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await projects.removeRouteRule("project-sibling", rule.id);
    }
    expect(h.ruleUpdate).not.toHaveBeenCalled();
    for (const args of h.ruleRemove.mock.calls) expect(args).toEqual(["project-sibling", rule.id]);
  });
  it("connects a primary domain through the same domain operation and retains legacy errors", async () => {
    h.domainCreate.mockResolvedValue({ domain: domainFixture(), records: { mode: "external", records: [] }, wwwError: "sibling is already owned" });
    const local = await native();
    const input = { domain: " app.example.com ", externalIngress: true, includeWww: true };
    expect(await remote().projects.connectDomain("project-a", input)).toEqual(await local.projects.connectDomain("project-a", input));
    for (const [context, command] of h.domainCreate.mock.calls) {
      expect(context).not.toHaveProperty("hono");
      expect(command).toMatchObject({ projectId: "project-a", hostname: "app.example.com", isPrimary: true });
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    h.domainCreate.mockRejectedValue(new Error("Domain already in use"));
    for (const projects of [remote().projects, local.projects]) {
      await expect(projects.connectDomain("project-a", input)).rejects.toMatchObject({ statusCode: 400, details: { success: false, message: "Domain already in use" } });
    }
  });
});

describe("provider credential HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  it("shares verification, tenant arguments, masking and secret-free audit", async () => {
    const credential = credentialFixture();
    h.credentialCreate.mockResolvedValue(credential);
    h.credentialGet.mockResolvedValue(credential);
    h.credentialUpdate.mockResolvedValue({ ...credential, name: "Rotated" });
    h.credentialVerify.mockResolvedValue({ ...credential, status: "invalid" });
    const local = await native();
    const input = { provider: "docker-registry", name: "Production registry", selector: "ghcr.io", values: { username: "operator", secret: "do-not-audit-this" } };
    for (const credentials of [local.credentials, remote().credentials]) {
      expect(await credentials.create(input)).toEqual(credential);
      expect(await credentials.update(credential.id, { name: "Rotated", values: { secret: "rotated-private-value" } })).toMatchObject({ name: "Rotated" });
      expect(await credentials.verify(credential.id)).toMatchObject({ status: "invalid" });
      expect(await credentials.remove(credential.id)).toEqual({ success: true });
    }
    expect(h.credentialCreate).toHaveBeenCalledWith("org-a", input);
    expect(h.audit).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("do-not-audit-this");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("rotated-private-value");
    expect(h.audit.mock.calls.some(([row]) => row.after?.secretRotated === true)).toBe(true);
  });
  it("requires actual admin membership on every write even for a token with settings grants", async () => {
    h.identity = { ...alice, tokenScope: { tokenId: "credential-token" }, credential: { organizationId: "org-a", readOnly: false } };
    h.grants.set("credential-token:settings:*", { permissions: ["admin"] });
    const local = await native();
    h.members.set("org-a:alice", { id: "member-a", role: "member" });
    for (const credentials of [local.credentials, remote().credentials]) {
      await expect(credentials.create({ provider: "docker-registry", name: "Registry", values: { secret: "value" } })).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await expect(credentials.update("credential-a", { name: "Renamed" })).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await expect(credentials.remove("credential-a")).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await expect(credentials.verify("credential-a")).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    }
    expect(h.credentialCreate).not.toHaveBeenCalled();
    expect(h.credentialUpdate).not.toHaveBeenCalled();
    expect(h.credentialRemove).not.toHaveBeenCalled();
    expect(h.credentialVerify).not.toHaveBeenCalled();
  });
  it("uses the active organization for identifier reads and rejects malformed secret-bearing results", async () => {
    h.credentialGet.mockResolvedValue(credentialFixture());
    const local = await native();
    expect(await local.credentials.get("credential-a")).toEqual(await remote().credentials.get("credential-a"));
    for (const args of h.credentialGet.mock.calls) expect(args).toEqual(["org-a", "credential-a"]);
    h.credentialGet.mockResolvedValue({ ...credentialFixture(), secretsEnc: "must-not-escape" });
    for (const credentials of [local.credentials, remote().credentials]) {
      await expect(credentials.get("credential-a")).rejects.toMatchObject({ code: "INVALID_OPERATION_RESPONSE" });
    }
  });
});

describe("shared project transfers", () => {
  it("preserves partial promotion status and its structured result", async () => {
    h.transferCloud.mockResolvedValue({ projectId: "project-a", imported: { project: 1 }, localRemoved: false, unrecoverableSteps: 0 });
    const response = await app.request("/api/projects/project-a/transfer/to-cloud", { method: "POST" });
    expect(response.status).toBe(207);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "PROMOTE_LOCAL_CLEANUP_FAILED", imported: { project: 1 } });
    const remote = new OpenshipClient({ baseUrl: "http://openship.test", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
    expect(await remote.projects.transferToCloud("project-a")).toEqual(body);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });
  it("refuses unmapped fixed scopes before moving data", async () => {
    const local = await native();
    const remote = new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
    for (const projects of [local.projects, remote.projects]) {
      await expect(projects.transferToCloud("project-a")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      await expect(projects.transferToSelfHosted("project-a")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    }
    expect(h.transferCloud).not.toHaveBeenCalled();
    expect(h.transferLocal).not.toHaveBeenCalled();
  });
});

afterEach(async () => { await stopAllTunnels(); vi.unstubAllEnvs(); });

import {
  createSetupSession, getActiveSetupSession, getSetupSession, removeSetupSession,
  finishSetupSession, promptSetupUser, subscribeSetupSession, respondToSetupPrompt,
  setupPromptState, appendSetupLog,
} from "@repo/platform/engine/modules/system/setup-session";
import { drainServerInstallations } from "@repo/platform/engine/modules/system/server-install.operations";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";
import { getContainerApplySession } from "@repo/platform/engine/lib/server-container-session";

const setupSessions = new Set<string>();
afterEach(async () => {
  const active = getActiveSetupSession();
  if (active) removeSetupSession(active.id);
  for (const id of setupSessions) removeSetupSession(id);
  setupSessions.clear();
  await drainServerInstallations();
  await drainBackgroundWork();
});

const setupPrompt = {
  id: "edge-conflict", title: "Replace proxy", message: "Approve takeover",
  actions: [{ id: "override", label: "Replace" }, { id: "cancel", label: "Cancel" }],
};

describe("server installation HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  function restrictToServer() {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:server:server-a", { permissions: ["admin"] });
  }
  it("accepts an exact server grant for body-derived diagnostic and installation targets", async () => {
    restrictToServer();
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      expect(await servers.check("server-a", { components: ["docker"] })).toMatchObject({ ready: true, missing: [] });
      expect(await servers.installComponent("server-a", { component: "edge", config: { edgeImage: "untrusted:image" } })).toMatchObject({ success: true, component: "edge", logs: [] });
      expect(await servers.removeComponent("server-a", { component: "edge" })).toMatchObject({ success: true });
      await expect(servers.check("server-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.installComponent("server-b", { component: "edge" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.installEdge).toHaveBeenCalledTimes(2);
    for (const [, , config] of h.installEdge.mock.calls) expect(config.edgeImage).not.toBe("untrusted:image");
    expect(h.audit).toHaveBeenCalledTimes(6);
  });

  it("preserves missing-dependency recovery fields and does not deliver or install the edge", async () => {
    h.componentCheck.mockImplementation(async () => [{ name: "docker", healthy: false }]);
    const local = await native();
    for (const servers of [local.servers, remote().servers])
      await expect(servers.installComponent("server-a", { component: "edge" })).rejects.toMatchObject({
        statusCode: 409, code: "missing_dependency", details: { component: "edge", missing: ["docker"], logs: [] },
      });
    expect(h.deliverEdge).not.toHaveBeenCalled();
    expect(h.installEdge).not.toHaveBeenCalled();
  });

  it("shares install prompts, exact-grant responses, completion, and replay", async () => {
    restrictToServer();
    h.installEdge.mockImplementation(async (_executor, log, config) => {
      const action = await config.promptUser(setupPrompt);
      log({ message: `decision:${action}`, level: "info" });
      return { component: "edge", success: action === "override" };
    });
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      let sessionId = "";
      const events = [];
      for await (const event of servers.installComponents("server-a", { components: ["edge"], config: { reinstall: true } })) {
        events.push(event);
        if (event.event === "session") { sessionId = JSON.parse(event.data).sessionId; setupSessions.add(sessionId); }
        if (event.event === "prompt") expect(await servers.respondToInstall({ sessionId, action: "override" })).toEqual({ ok: true });
      }
      expect(events.some(event => event.event === "complete" && JSON.parse(event.data).status === "completed")).toBe(true);
      expect(await servers.getInstallSession({ sessionId })).toMatchObject({ active: true, serverId: "server-a", status: "completed" });
      const replay = [];
      for await (const event of servers.installEvents({ sessionId })) replay.push(event);
      expect(replay.some(event => event.event === "log" && JSON.parse(event.data).message === "decision:override")).toBe(true);
      expect(replay.at(-1)?.event).toBe("end");
      expect(setupPromptState(sessionId)).toEqual({ pending: false, subscribers: 0 });
    }
    expect(h.installDocker).not.toHaveBeenCalled(); // Healthy implicit dependency stays installed.
    expect(h.installEdge).toHaveBeenCalledTimes(2);
    expect(h.refreshServerContainer).toHaveBeenCalledTimes(2);
  });

  it("registers a prompt before broadcasting to synchronous native subscribers", async () => {
    const session = createSetupSession([{ name: "edge", label: "Edge" }], "server-a");
    setupSessions.add(session.id);
    const subscription = subscribeSetupSession(session.id, event => {
      if (event === "prompt") expect(respondToSetupPrompt(session.id, "override")).toBe(true);
      return true;
    });
    await expect(promptSetupUser(session.id, setupPrompt)).resolves.toBe("override");
    subscription.unsubscribe();
    finishSetupSession(session.id, "completed");
    expect(setupPromptState(session.id)).toEqual({ pending: false, subscribers: 0 });
  });

  it("keeps session replay and response private, including busy-install errors", async () => {
    restrictToServer();
    const session = createSetupSession([{ name: "edge", label: "Edge" }], "server-b");
    setupSessions.add(session.id);
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await expect(servers.getInstallSession({ sessionId: session.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.respondToInstall({ sessionId: session.id, action: "override" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.installEvents({ sessionId: session.id })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      const failure = await servers.installComponents("server-a", { components: ["edge"] })[Symbol.asyncIterator]().next().catch(error => error);
      expect(failure).toMatchObject({ statusCode: 409, code: "install_in_progress" });
      expect(JSON.stringify(failure.details)).not.toContain(session.id);
    }
    expect(h.installEdge).not.toHaveBeenCalled();
  });

  it("revalidates server grants before starting the next installation component", async () => {
    restrictToServer();
    h.installDocker.mockImplementation(async () => {
      h.grants.clear();
      return { component: "docker", success: true };
    });
    const local = await native();
    // Open directly so this test observes the accepted background work as well
    // as the facade refusing subsequent events after revocation.
    const context = await getPlatformKernel().resolveScope(alice, "org-a");
    const operation = await getPlatformKernel().servers.openInstallStream(context, "server-a", { components: ["docker", "edge"] });
    const session = getActiveSetupSession()!;
    setupSessions.add(session.id);
    await drainServerInstallations();
    expect(getSetupSession(session.id)).toMatchObject({ status: "failed", components: [
      expect.objectContaining({ name: "docker", status: "installed" }),
      expect.objectContaining({ name: "edge", status: "failed" }),
    ] });
    expect(h.installEdge).not.toHaveBeenCalled();
    await expect(operation.data[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(local.servers.getInstallSession({ sessionId: session.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(setupPromptState(session.id).subscribers).toBe(0);
  });

  it("revalidates each native replay event and unsubscribes after grant revocation", async () => {
    restrictToServer();
    const session = createSetupSession([{ name: "edge", label: "Edge" }], "server-a");
    setupSessions.add(session.id);
    appendSetupLog(session.id, "edge", "private-install-log");
    const local = await native();
    const iterator = local.servers.installEvents({ sessionId: session.id })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("session");
    h.grants.clear();
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(setupPromptState(session.id).subscribers).toBe(0);
  });

  it("releases the retained monitor connection when either facade disconnects", async () => {
    restrictToServer();
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      const abort = new AbortController();
      const iterator = servers.monitor("server-a", { signal: abort.signal })[Symbol.asyncIterator]();
      const event = await iterator.next();
      expect(event.value).toMatchObject({ event: "stats", data: JSON.stringify({ cpu: 10, memUsed: 1024 }) });
      abort.abort();
      await iterator.return?.();
    }
    await vi.waitFor(() => expect(h.serverRelease).toHaveBeenCalledTimes(2));
    expect(h.serverRetain).toHaveBeenCalledTimes(2);
  });
});

describe("managed container HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });

  it("shares tenant-scoped cached fleet views, scans and issue classification", async () => {
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      expect(await servers.listContainers("server-a")).toEqual([h.containerRows.get("server-a:edge")]);
      expect(await servers.listAllContainers()).toMatchObject([{ server: { id: "server-a", projectCount: 2 } }]);
      expect(await servers.containersBehind()).toEqual({ servers: 1, components: 1 });
      expect(await servers.containerIssues()).toMatchObject({ total: 0, servers: [] });
      expect(await servers.scanContainers("server-a")).toMatchObject({ ok: true, containers: [{ component: "edge", behind: true, down: false }] });
      await expect(servers.listContainers("server-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.scanContainers("server-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.containerApplySession("server-b", { component: "edge" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.containerUpsert).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("keeps reads separate from write authority and checks host policy before scans", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:server:server-a", { permissions: ["read"] });
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      expect(await servers.listContainers("server-a")).toHaveLength(1);
      await expect(servers.applyContainer("server-a", { component: "edge" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.applyAllContainers()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    h.grants.set("org-a:alice:server:server-a", { permissions: ["write"] });
    h.servers.get("server-a")!.isLocal = true;
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    for (const servers of [local.servers, remote().servers])
      await expect(servers.scanContainers("server-a")).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
    expect(h.serverWithExecutor).not.toHaveBeenCalled();
  });

  it("reuses an in-flight swap across apply and read-only subscribers, without cancelling it on disconnect", async () => {
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      h.reconcileEdge.mockClear();
      const complete = Promise.withResolvers<void>();
      h.reconcileEdge.mockImplementation(async (_executor, options) => {
        options.onLog({ level: "info", message: "Pulling pinned image" });
        await complete.promise;
        return { updated: true, edgeDown: false };
      });
      const started = servers.applyContainer("server-a", { component: "edge" })[Symbol.asyncIterator]();
      let sessionId = "";
      try {
        const frame = (await started.next()).value!;
        expect(frame.event).toBe("steps");
        const current = await servers.containerApplySession("server-a", { component: "edge" });
        expect(current.active).toBe(true);
        if (!current.active) throw new Error("Expected an active container swap");
        sessionId = current.sessionId;
        const duplicate = servers.applyContainer("server-a", { component: "edge" })[Symbol.asyncIterator]();
        const reader = servers.containerApplyEvents("server-a", { component: "edge" })[Symbol.asyncIterator]();
        try {
          expect((await duplicate.next()).value!.event).toBe("steps");
          expect((await reader.next()).value!.event).toBe("steps");
          expect(await servers.containerApplySession("server-a", { component: "edge" })).toMatchObject({ active: true, sessionId });
          expect(h.reconcileEdge).toHaveBeenCalledTimes(1);
        } finally { await duplicate.return?.(); await reader.return?.(); }
        await started.return?.();
        expect(getContainerApplySession(sessionId)?.status).toBe("running");
        await vi.waitFor(() => expect(getContainerApplySession(sessionId)?.subscribers.size).toBe(0));
      } finally {
        complete.resolve();
        await started.return?.();
        await drainBackgroundWork();
      }
      expect(getContainerApplySession(sessionId)?.status).toBe("completed");
      expect(await servers.containerApplySession("server-a", { component: "edge" })).toEqual({ active: false });
      await expect(servers.containerApplyEvents("server-a", { component: "edge" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("preserves failed swap outcomes and refuses unprovisioned mail before opening events", async () => {
    h.reconcileEdge.mockResolvedValue({ updated: false, edgeDown: false, error: "takeover consent required" });
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await expect(servers.applyContainer("server-a", { component: "mail", intent: "repair" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "MAIL_SERVER_NOT_PROVISIONED" });
      const events = [];
      for await (const event of servers.applyContainer("server-a", { component: "edge" })) events.push(event);
      expect(events.some(event => event.event === "complete" && JSON.parse(event.data).status === "failed")).toBe(true);
      expect(JSON.stringify(events)).toContain("takeover consent required");
      expect(h.containerRows.get("server-a:edge")?.latestInProgress).toBe(false);
    }
  });

  it("derives bulk targets from the current tenant and records their disposition once per call", async () => {
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      const result = await servers.applyAllContainers({ intents: ["update"] });
      expect(result).toEqual({ started: [{ serverId: "server-a", serverName: "Production", component: "edge", intent: "update" }], skipped: [] });
      await drainBackgroundWork();
    }
    expect(h.reconcileEdge).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const [record] of h.audit.mock.calls) expect(record.after.started).toEqual(["server-a:edge:update"]);
    expect(h.containerRows.get("server-b:edge")?.latestInProgress).toBe(false);
  });
});

describe("server HTTP/native parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });

  it("preserves encrypted credential writes, public presentation and one secret-free audit", async () => {
    const local = await native();
    const input = { sshHost: " 203.0.113.30 ", sshAuthMethod: "key" as const, sshPrivateKey: "private-key-value", sshKeyPassphrase: "passphrase-value" };
    const outputs = [];
    for (const servers of [local.servers, remote().servers]) outputs.push(await servers.create(input));
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]).toMatchObject({ sshHost: "203.0.113.30", hasStoredKeyMaterial: true });
    for (const [data] of h.serverCreate.mock.calls) {
      expect(data.organizationId).toBe("org-a");
      expect(data.sshPrivateKey).toMatch(/^enc1:/);
      expect(decryptSecretField(data.sshPrivateKey)).toBe(input.sshPrivateKey);
      expect(decryptSecretField(data.sshKeyPassphrase)).toBe(input.sshKeyPassphrase);
    }
    expect(h.audit).toHaveBeenCalledTimes(2);
    for (const values of [outputs, h.audit.mock.calls]) {
      expect(JSON.stringify(values)).not.toContain("private-key-value");
      expect(JSON.stringify(values)).not.toContain("passphrase-value");
      expect(JSON.stringify(values)).not.toContain("enc1:");
    }
  });

  it("keeps list/detail counts, fixed tenant ownership, and runtime input validation", async () => {
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      expect(await servers.list()).toEqual([expect.objectContaining({ id: "server-a", projectCount: 2 })]);
      expect(await servers.get("server-a")).toMatchObject({ projectCount: 2, hasStoredKeyMaterial: true });
      await expect(servers.get("server-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.create({ sshHost: "example.com", sshPort: 99999 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(h.serverCreate).not.toHaveBeenCalled();
  });

  it("requires server admin for execution and rate-limit writes, beyond a write grant", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:server:server-a", { permissions: ["write"] });
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await expect(servers.update("server-a", { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
      await expect(servers.exec("server-a", { command: "whoami" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.updateRateLimit("server-a", { rps: 20 })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.remove("server-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.serverWithExecutor).not.toHaveBeenCalled();
    expect(h.serverRateApply).not.toHaveBeenCalled();
    expect(h.serverRemove).not.toHaveBeenCalled();
  });

  it("returns the same partial teardown result and keeps HTTP 409", async () => {
    h.serverWorkloads.mockResolvedValue([{ id: "project-a", name: "Application", appTemplateId: null }]);
    h.projectTeardown.mockResolvedValue({ rowDeleted: false, orphaned: [], unrecoverable: [{ error: "volume busy" }] });
    const local = await native();
    const expected = await local.servers.remove("server-a", { destroyOnSource: true });
    expect(await remote().servers.remove("server-a", { destroyOnSource: true })).toEqual(expected);
    const response = await app.request("/api/system/servers/server-a?destroyOnSource=true", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expected);
    expect(expected).toMatchObject({ ok: false, serverRemoved: false, error: "volume busy" });
    expect(h.serverRemove).not.toHaveBeenCalled();
    for (const [, , options] of h.projectTeardown.mock.calls) {
      expect(options).toEqual({ force: true, recordOnly: false, wipeVolumes: true });
    }
  });

  it("preserves local-row refusal details and checks host policy before execution", async () => {
    h.servers.set("server-a", { ...h.servers.get("server-a")!, isLocal: true });
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await expect(servers.update("server-a", { sshUser: "deployer" })).rejects.toMatchObject({ message: expect.stringContaining("display-only") });
      await expect(servers.exec("server-a", { command: "whoami" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
    }
    await expect(local.servers.update("server-a", { sshUser: "deployer" })).rejects.toMatchObject({ details: { fields: ["sshUser"] } });
    expect(h.serverUpdate).not.toHaveBeenCalled();
    expect(h.serverWithExecutor).not.toHaveBeenCalled();
  });

  it("retains live rate-limit sanitization and verification, and does not audit command output", async () => {
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await servers.updateRateLimit("server-a", { rps: 7.9, burst: -2, whitelist: ["10.0.0.0/8", "invalid; directive"] });
      expect(await servers.exec("server-a", { command: "  whoami  " })).toMatchObject({ output: "private-output" });
    }
    for (const [config] of h.serverRateApply.mock.calls) expect(config).toEqual({ rps: 7, burst: 0, whitelist: ["10.0.0.0/8"] });
    expect(h.serverRateRead).toHaveBeenCalledTimes(4);
    expect(h.audit.mock.calls.filter(([event]) => event.eventType === "server.exec")).toHaveLength(2);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("private-output");
  });

  it("keeps failed module steps as results and uses explicit consent mode", async () => {
    const result = { module: "openresty", fromVersion: "1.0.0", toVersion: "1.0.0", appliedSteps: [], pendingConsent: [], skipped: [], changed: false, ok: false, error: "step failed" };
    h.serverModuleApply.mockResolvedValue(result);
    const local = await native();
    for (const servers of [local.servers, remote().servers]) expect(await servers.applyModule("server-a", { module: "openresty" })).toEqual(result);
    for (const [, module, mode] of h.serverModuleApply.mock.calls) expect([module, mode]).toEqual(["openresty", "all"]);
  });
});

describe("HTTP/native system parity", () => {
  const remote = (organizationId = "org-a") => new OpenshipClient({ baseUrl: "http://openship.test", organizationId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });

  it("refuses anonymous setup writes without the authorized local first-run posture", async () => {
    h.servers.clear();
    const onboarding = new Hono().post("/", onboardingSetup);
    const res = await onboarding.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sshHost: "attacker.test", tunnelToken: "injected" }) });
    expect(res.status).toBe(404);
    expect(h.settingsUpsert).not.toHaveBeenCalled();
    expect(h.serverCreate).not.toHaveBeenCalled();
  });

  it("preserves the host-token setup read without inventing a user session", async () => {
    h.settings = { tunnelToken: "private-host-token" };
    const internal = new Hono().get("/", getInternalSetup);
    const response = await internal.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, productModeEffective: "platform" });
  });

  it("shares deployment metadata and masked settings without requiring instance authority for reads", async () => {
    h.settings = { tunnelToken: "private-tunnel-token", smtpPasswordEncrypted: "private-smtp-ciphertext", authMode: "local" };
    const local = await native();
    expect(await local.system.info()).toEqual(await remote().system.info());
    expect(await local.system.info()).toMatchObject({ selfHosted: true, productMode: "platform", authMode: "local" });
    const settings = await local.system.getSettings();
    expect(await remote().system.getSettings()).toEqual(settings);
    expect(settings).toMatchObject({ configured: true, defaultBuildMode: "auto", autoScanInfra: true });
    expect(JSON.stringify(settings)).not.toContain("private-");
    expect(await local.system.getEmailSettings()).toEqual(await remote().system.getEmailSettings());
    expect(JSON.stringify(await local.system.getEmailSettings())).not.toContain("private-");
  });

  it("does not turn organization ownership or membership into instance administration", async () => {
    for (const role of ["owner", "member", "restricted"]) {
      h.members.set("org-a:alice", { id: "member-a", role });
      h.grants.set("org-a:alice:settings:*", { permissions: ["admin"] });
      const local = await native();
      for (const system of [local.system, remote().system]) {
        await expect(system.updateSettings({ productMode: "mail" })).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.updateEmailSettings({ host: null })).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.resetSettings()).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.health()).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.browse({ path: "/" })).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.listUntrackedEdgeSites()).rejects.toMatchObject({ statusCode: 403 });
        await expect(system.removeUntrackedEdgeSite({ hostname: "orphan.example.test" })).rejects.toMatchObject({ statusCode: 403 });
      }
    }
    expect(h.settingsUpsert).not.toHaveBeenCalled();
    expect(h.settingsDelete).not.toHaveBeenCalled();
    expect(h.orphanScan).not.toHaveBeenCalled();
    expect(h.orphanRemove).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses organization-bound administrator tokens even with explicit settings grants", async () => {
    h.instanceRoles.set("alice", "admin");
    h.identity = { ...alice, tokenScope: { tokenId: "token-a" }, credential: { organizationId: "org-a", readOnly: false } };
    h.grants.set("token-a:settings:*", { permissions: ["admin"] });
    const local = await native();
    for (const system of [local.system, remote().system]) {
      expect(await system.getSettings()).toHaveProperty("configured");
      await expect(system.updateSettings({ productMode: "mail" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(system.listUntrackedEdgeSites()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(system.browse({ path: "/" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.settingsUpsert).not.toHaveBeenCalled();
  });

  it("rechecks the persisted instance role for a previously created scope", async () => {
    h.instanceRoles.set("alice", "admin");
    const local = await native();
    for (const system of [local.system, remote().system]) expect(await system.updateSettings({ productMode: "mail" })).toEqual({ ok: true });
    h.instanceRoles.delete("alice");
    for (const system of [local.system, remote().system]) await expect(system.updateSettings({ productMode: "platform" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.settingsUpsert).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("allows instance reads with an unbound read-only credential while refusing mutations", async () => {
    h.instanceRoles.set("alice", "admin");
    h.identity = { ...alice, credential: { organizationId: null, readOnly: true } };
    const local = await native();
    for (const system of [local.system, remote().system]) {
      expect(await system.listUntrackedEdgeSites()).toEqual({ scanned: true, orphans: [], knownCount: 2 });
      await expect(system.updateSettings({ productMode: "mail" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(system.removeUntrackedEdgeSite({ hostname: "orphan.example.test" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.orphanScan).toHaveBeenCalledTimes(2);
    expect(h.orphanRemove).not.toHaveBeenCalled();
  });

  it("encrypts SMTP passwords, retains an omitted password, and audits only setting names", async () => {
    h.instanceRoles.set("alice", "admin");
    const local = await native();
    for (const system of [local.system, remote().system]) {
      expect(await system.updateEmailSettings({ host: " SMTP.Example.test ", user: " admin ", password: "secret-smtp-password" })).toEqual({ ok: true, configured: true });
      const sealed = h.settings!.smtpPasswordEncrypted as string;
      expect(sealed).not.toBe("secret-smtp-password");
      expect(decrypt(sealed)).toBe("secret-smtp-password");
      expect(await system.getEmailSettings()).toMatchObject({ host: "smtp.example.test", port: 587, user: "admin", hasPassword: true });
      await system.updateEmailSettings({ host: "smtp.example.test", user: "renamed", password: "" });
      expect(h.settings!.smtpPasswordEncrypted).toBe(sealed);
      await system.updateSettings({ tunnelToken: "secret-tunnel-token", tunnelProvider: "cloudflare" });
      expect(JSON.stringify(await system.getSettings())).not.toContain("secret-tunnel-token");
      expect(JSON.stringify(await system.getEmailSettings())).not.toContain(sealed);
    }
    expect(h.audit).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-smtp-password");
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-tunnel-token");
    expect(h.invalidateMailCache).toHaveBeenCalledTimes(4);
  });

  it("retains pinned auth mode and deliberate zero-auth guards in both entry points", async () => {
    h.instanceRoles.set("alice", "admin");
    const local = await native();
    for (const system of [local.system, remote().system]) {
      h.env.OPENSHIP_AUTH_MODE = "local";
      await expect(system.updateSettings({ authMode: "cloud" })).rejects.toMatchObject({ statusCode: 409 });
      h.env.OPENSHIP_AUTH_MODE = undefined;
      h.env.OPENSHIP_ALLOW_ZERO_AUTH = false;
      await expect(system.updateSettings({ authMode: "none", confirm: "I-understand-no-auth" })).rejects.toMatchObject({ statusCode: 403 });
      h.env.OPENSHIP_ALLOW_ZERO_AUTH = true;
      await expect(system.updateSettings({ authMode: "none" })).rejects.toMatchObject({ statusCode: 400 });
      expect(await system.updateSettings({ authMode: "none", confirm: "I-understand-no-auth" })).toEqual({ ok: true });
      await expect(system.updateSettings({ productMode: "unknown-product" })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(h.settingsUpsert).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls.filter(([event]) => event.eventType === "auth-mode-changed")).toHaveLength(2);
  });

  it("keeps host-control writes restricted to the machine's founding organization", async () => {
    h.instanceRoles.set("alice", "admin");
    const local = await native();
    for (const system of [local.system, remote().system]) await expect(system.updateSettings({ hostControl: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.settingsUpsert).not.toHaveBeenCalled();
    h.members.set("org_founder:alice", { id: "founder-membership", role: "owner" });
    const founding = await native("org_founder");
    try {
      for (const system of [founding.system, remote("org_founder").system]) expect(await system.updateSettings({ hostControl: false })).toEqual({ ok: true });
      expect(h.settings).toMatchObject({ hostControlEnabled: false });
    } finally {
      const { setHostControlOverride } = await import("@repo/adapters");
      setHostControlOverride(null);
    }
  });

  it("clears settings caches on reset and deletes only the caller's server records", async () => {
    h.instanceRoles.set("alice", "admin");
    const local = await native();
    for (const system of [local.system, remote().system]) {
      await system.updateSettings({ productMode: "mail" });
      expect(await system.getSettings()).toMatchObject({ productModeEffective: "mail" });
      expect(await system.resetSettings()).toEqual({ ok: true });
      expect(await system.getSettings()).toMatchObject({ productModeEffective: "platform" });
    }
    expect(h.serverRemove.mock.calls).toEqual([["server-a"], ["server-a"]]);
    expect(h.invalidateMailCache).toHaveBeenCalledTimes(2);
  });

  it("returns test-mail delivery failure as a typed result while rejecting invalid recipients", async () => {
    h.instanceRoles.set("alice", "admin");
    h.mailTest.mockRejectedValue(new Error("SMTP connection refused"));
    const local = await native();
    for (const system of [local.system, remote().system]) {
      expect(await system.sendTestEmail({ to: " person@example.test " })).toEqual({ ok: false, error: "SMTP connection refused" });
      await expect(system.sendTestEmail({ to: "invalid" })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_INSTANCE_SETTINGS" });
    }
    expect(h.mailTest.mock.calls).toEqual([["person@example.test"], ["person@example.test"]]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("confines native directory browsing and excludes symlinks and hidden directories", async () => {
    h.instanceRoles.set("alice", "admin");
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    const directory = await mkdtemp(join(tmpdir(), "system-parity-"));
    try {
      const root = join(await realpath(directory), "source");
      await mkdir(root);
      await mkdir(join(root, "a-plain"));
      await mkdir(join(root, "z-project"));
      await mkdir(join(root, ".hidden"));
      await writeFile(join(root, "z-project", "package.json"), "{}");
      await symlink(directory, join(root, "escape"));
      const local = await native();
      await expect(local.system.browse()).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      configureNativeSourceRoots([root]);
      const expected = { path: root, directories: [
        { name: "z-project", path: join(root, "z-project"), isProject: true },
        { name: "a-plain", path: join(root, "a-plain"), isProject: false },
      ] };
      expect(await local.system.browse()).toEqual(expected);
      expect(await remote().system.browse({ path: root })).toEqual(expected);
      for (const system of [local.system, remote().system]) {
        await expect(system.browse({ path: directory })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
        await expect(system.browse({ path: join(root, "escape") })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      }
    } finally {
      configureNativeSourceRoots([]);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HTTP/native server tunnel parity", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });

  it("retains configured ports and auto-start when quick-open omits those fields", async () => {
    h.env.DEPLOY_MODE = "desktop";
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      const row = await servers.saveTunnel("server-a", { remotePort: "5432", localPort: 49100, autoStart: true });
      expect(row).toMatchObject({ remoteHost: "127.0.0.1", remotePort: 5432, localPort: 49100, autoStart: true, running: false });
      expect(await servers.saveTunnel("server-a", { remotePort: 5432 })).toEqual(row);
      expect(await servers.listTunnels("server-a")).toEqual([row]);
      await servers.removeTunnel("server-a", { tunnelId: row.id });
    }
    expect(h.audit).toHaveBeenCalledTimes(6);
    expect(h.tunnelForward).not.toHaveBeenCalled();
  });

  it("shares one running forward and reports the assigned local port in both facades", async () => {
    h.env.DEPLOY_MODE = "desktop";
    const local = await native();
    const row = await local.servers.saveTunnel("server-a", { remotePort: 5432, localPort: 0 });
    const [a, b] = await Promise.all([
      local.servers.startTunnel("server-a", { tunnelId: row.id }),
      remote().servers.startTunnel("server-a", { tunnelId: row.id }),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ running: true, localPort: 49100, url: "http://localhost:49100" });
    expect(h.tunnelForward).toHaveBeenCalledTimes(1);
    expect(h.serverRetain).toHaveBeenCalledTimes(1);
    expect(await remote().servers.stopTunnel("server-a", { tunnelId: row.id })).toMatchObject({ running: false, url: null });
    expect(h.serverRelease).toHaveBeenCalledTimes(1);
  });

  it("refuses foreign server and tunnel identifiers before touching a listener", async () => {
    h.env.DEPLOY_MODE = "desktop";
    h.tunnels.set("foreign-tunnel", { id: "foreign-tunnel", serverId: "server-b", remoteHost: "127.0.0.1", remotePort: 5432, localPort: null, autoStart: false });
    const local = await native();
    for (const servers of [local.servers, remote().servers]) {
      await expect(servers.listTunnels("server-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.startTunnel("server-a", { tunnelId: "foreign-tunnel" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.removeTunnel("server-a", { tunnelId: "foreign-tunnel" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.tunnelForward).not.toHaveBeenCalled();
    expect(h.tunnelRemove).not.toHaveBeenCalled();
  });

  it("rechecks server grants before forwarding each connection", async () => {
    h.env.DEPLOY_MODE = "desktop";
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:server:server-a", { permissions: ["write"] });
    const local = await native();
    const row = await local.servers.saveTunnel("server-a", { remotePort: 5432 });
    await remote().servers.startTunnel("server-a", { tunnelId: row.id });
    const checkAccess = h.tunnelForward.mock.calls[0]![2].beforeConnect as () => Promise<void>;
    await expect(checkAccess()).resolves.toBeUndefined();
    h.grants.clear();
    await expect(checkAccess()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(local.servers.startTunnel("server-a", { tunnelId: row.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires explicit native local-forwarding opt-in and preserves desktop-only HTTP availability", async () => {
    const local = await native();
    await expect(remote().servers.listTunnels("server-a")).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_LOCAL_FORWARDING", "false");
    const row = await local.servers.saveTunnel("server-a", { remotePort: 5432 });
    await expect(local.servers.startTunnel("server-a", { tunnelId: row.id })).rejects.toMatchObject({ code: "LOCAL_FORWARDING_DISABLED" });
    expect(h.tunnelForward).not.toHaveBeenCalled();
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_LOCAL_FORWARDING", "true");
    expect(await local.servers.startTunnel("server-a", { tunnelId: row.id })).toMatchObject({ running: true });
  });
});

vi.mock("@repo/platform/engine/modules/backups/backup.orchestrator", () => ({ backupOrchestrator: { enqueue: h.backupEnqueue } }));
vi.mock("@repo/platform/engine/modules/backups/restore.orchestrator", () => ({ restoreOrchestrator: { beginPrepare: h.backupPrepare, apply: h.backupApply, cancel: h.backupCancel } }));
vi.mock("@repo/platform/engine/modules/backups/triggers/cron", async importOriginal => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/backups/triggers/cron")>(),
  syncPolicySchedule: h.backupSyncSchedule, removePolicySchedule: h.backupRemoveSchedule,
}));

describe("backup HTTP/native parity with retained policy services", () => {
  const remote = () => new OpenshipClient({ baseUrl: "http://openship.test", organizationId: "org-a", fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  beforeEach(() => {
    for (const [id, organizationId] of [["destination-a", "org-a"], ["destination-b", "org-b"]]) {
      h.destinations.set(id!, { id: id!, organizationId: organizationId! } as StoredBackupDestination);
    }
    h.backupPolicies.set("policy-a", backupPolicyFixture());
    h.backupRuns.set("run-a", { ...backupRunFixture(), artifacts: [{ name: "archive", metadata: { restoreCommand: "restore --password=backup-secret", format: "tar" } }] });
    h.backupRestores.set("restore-a", { ...backupRestoreFixture(), confirmationToken: "in-force-token" });
    h.backupPolicyCreate.mockImplementation(async input => {
      const row = { ...backupPolicyFixture(input.id, input.projectId, input.destinationId), ...input };
      h.backupPolicies.set(row.id, row); return row;
    });
    h.backupPolicyUpdate.mockImplementation(async (id, input) => {
      const row = { ...h.backupPolicies.get(id)!, ...input }; h.backupPolicies.set(id, row); return row;
    });
    h.backupPolicyDelete.mockImplementation(async id => { h.backupPolicies.delete(id); });
    h.backupRetentionLock.mockImplementation(async (id, until) => { h.backupRuns.get(id)!.retentionLockedUntil = until?.toISOString() ?? null; });
    h.backupEnqueue.mockResolvedValue({ runId: "run-a", runIds: ["run-a"] });
    h.backupPrepare.mockResolvedValue({ restoreId: "restore-a", confirmationToken: "in-force-token" });
    h.backupApply.mockResolvedValue(undefined);
    h.backupCancel.mockResolvedValue({ accepted: true, status: "applying", destructive: true, forced: false });
  });

  it("preserves project-write enumeration while direct destination readers receive masked snapshots", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:destination-a", { permissions: ["read"] });
    h.grants.set("org-a:alice:project:project-a", { permissions: ["read"] });
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      await expect(ops.listPolicies("project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ops.listRuns("project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      const read = await ops.getRun("run-a");
      expect(JSON.stringify(read)).not.toContain("backup-secret");
      expect(read.artifacts).toMatchObject([{ metadata: { format: "tar" } }]);
      expect(await ops.getRestore("restore-a")).toMatchObject({ confirmationToken: null });
      const events = [];
      for await (const event of ops.streamRun("run-a")) events.push(JSON.parse(event.data));
      expect(events.map(event => event.type)).toEqual(["snapshot", "complete"]);
      expect(JSON.stringify(events)).not.toContain("backup-secret");
    }
    expect(JSON.stringify(h.backupRuns.get("run-a"))).toContain("backup-secret");
    expect(h.backupRestores.get("restore-a")!.confirmationToken).toBe("in-force-token");
  });

  it("reuses policy validation, retention defaults, schedule refresh and webhook rotation", async () => {
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      const created = await ops.createPolicy("project-a", { destinationId: "destination-a", enableWebhook: true });
      expect(created).toMatchObject({ retainCount: 7, retainDays: null, webhookToken: expect.any(String) });
      const updated = await ops.updatePolicy(created.id, { rotateWebhookToken: true, retainCount: null, projectId: "project-b", serviceId: "service-b" } as never);
      expect(updated.projectId).toBe("project-a");
      expect(updated.serviceId).toBeNull();
      expect(updated.webhookToken).not.toBe(created.webhookToken);
      expect(updated.retainCount).toBeNull();
      await expect(ops.updatePolicy(created.id, { cronExpression: "not a cron" })).rejects.toMatchObject({ code: "BACKUP_OPERATION_FAILED" });
      await ops.removePolicy(created.id);
    }
    expect(h.backupSyncSchedule).toHaveBeenCalledTimes(4);
    expect(h.backupRemoveSchedule).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("webhookToken");
  });

  it("confines policy source and destination references before creating anything", async () => {
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      await expect(ops.createPolicy("project-a", { destinationId: "destination-b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ops.createPolicy("project-a", { destinationId: "destination-a", serviceId: "service-b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.backupPolicyCreate).not.toHaveBeenCalled();
  });

  it("requires both destination and project authority before running or restoring", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:destination-a", { permissions: ["admin"] });
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      await expect(ops.run("policy-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ops.prepareRestore("run-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ops.applyRestore("restore-a", { confirmationToken: "in-force-token" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(h.backupEnqueue).not.toHaveBeenCalled();
    expect(h.backupPrepare).not.toHaveBeenCalled();
    expect(h.backupApply).not.toHaveBeenCalled();
    h.grants.set("org-a:alice:project:project-a", { permissions: ["admin"] });
    expect(await local.backups.run("policy-a")).toEqual(await remote().backups.run("policy-a"));
  });

  it("returns the orchestrator's reused token and preserves cooperative cancellation details", async () => {
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      expect(await ops.prepareRestore("run-a")).toEqual({ restoreId: "restore-a", confirmationToken: "in-force-token" });
      expect(await ops.applyRestore("restore-a", { confirmationToken: "in-force-token" })).toEqual({ ok: true });
      expect(await ops.cancelRestore("restore-a")).toEqual({ ok: true, accepted: true, status: "applying", destructive: true, forced: false });
    }
    expect(h.backupApply.mock.calls.every(call => call[2] === "in-force-token")).toBe(true);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("in-force-token");
    expect(h.audit).toHaveBeenCalledTimes(6);
  });

  it("keeps restore actions admin-only and readonly calls cannot prepare or protect", async () => {
    h.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    h.grants.set("org-a:alice:backup_destination:destination-a", { permissions: ["write"] });
    h.grants.set("org-a:alice:project:project-a", { permissions: ["admin"] });
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      await expect(ops.prepareRestore("run-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ops.cancelRestore("restore-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    h.identity = { ...alice, credential: { organizationId: "org-a", readOnly: true } };
    for (const ops of [local.backups, remote().backups]) {
      await expect(ops.protectRun("run-a")).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(ops.prepareRestore("run-a")).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
  });

  it("preserves retention locking and clearing and rejects invalid timestamps before writes", async () => {
    const local = await native();
    for (const ops of [local.backups, remote().backups]) {
      expect(await ops.protectRun("run-a")).toEqual({ ok: true, retentionLockedUntil: "2099-12-31T23:59:59.000Z" });
      expect(await ops.protectRun("run-a", { protected: false })).toEqual({ ok: true, retentionLockedUntil: null });
      await expect(ops.protectRun("run-a", { until: "invalid" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(h.backupRetentionLock).toHaveBeenCalledTimes(4);
  });
});
