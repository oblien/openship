import "./_setup-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform, resetPlatform } from "@repo/adapters";
import { getAppTemplate } from "@repo/core";
import { repos, seedOwner, seedServer } from "../jobs/_harness";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { updateService } from "@repo/platform/engine/modules/services/service.service";
import { mergeServiceDeployEnv } from "@repo/platform/engine/modules/deployments/compose/service-env-layers";
import {
  buildServicePublicUrlMap,
  resolveEnvPublicUrls,
} from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import {
  listWebmailRecoveryCandidates,
  startExternalWebmailDeploy,
  startWebmailDeploy,
} from "@repo/platform/engine/modules/mail/webmail/webmail-install.service";
import type { ExecutionContext } from "@repo/platform";
import { ensureRouteDomainRecord } from "@repo/platform/engine/lib/routing-domains";
import { Hono } from "hono";
import { OpenshipClient } from "@repo/sdk/client";
import { mailRoutes } from "../../../src/modules/mail/mail.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { mailHostRoutableByProject } from "@repo/platform/engine/lib/mail-host-claim";

const h = vi.hoisted(() => ({
  queued: vi.fn(async (_ctx: unknown, _input: unknown) => ({
    deployment_id: "test-webmail-deployment",
  })),
  linkError: null as Error | null,
}));
// Use the shipped catalog. Stop at deployment admission: the real installer,
// routing, settings merge and encrypted DB rows run, without creating containers.
vi.mock("@repo/platform/engine/modules/apps/catalog-source", async (original) => ({
  ...(await original<object>()),
  getTemplateForOrg: async (_org: string, id: string) => getAppTemplate(id),
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  requestBuildAccess: h.queued,
  resolveSnapshotTarget: async (...args: unknown[]) => {
    const original = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build.service")
    >("@repo/platform/engine/modules/deployments/build.service");
    return original.resolveSnapshotTarget(
      ...(args as Parameters<typeof original.resolveSnapshotTarget>),
    );
  },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  verifyExistingCert: vi.fn(async () => ({ valid: false })),
  MAIL_DOMAIN_OWNER: "mail",
}));
vi.mock("@repo/platform/engine/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({
  // Only the saved remote account identity is simulated. Placement and workspace
  // ownership still use real repository rows and the generic project installer.
  requireLinkedCloudServer: async (org: string, id: string) => {
    if (h.linkError) throw h.linkError;
    return repos.cloudWorkspace.findByIdInOrganization(id, org);
  },
  remoteCloudRequest: async (_org: string, path: string, init: RequestInit) => {
    // Acknowledge only the normal shared activity claims; no Cloud request leaves
    // this fixture. The real local admission/release records still run.
    if (!/^\/api\/cloud\/servers\/cloud-test-server-[^/]+\/activity(?:\/release)?$/.test(path))
      throw new Error(`Unexpected Cloud request: ${path}`);
    const { id } = JSON.parse(String(init.body));
    return { id, ...(path.endsWith("/release") ? { released: true } : {}) };
  },
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: async (serverId: string, fn: (executor: unknown) => unknown) => fn({ serverId }) },
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", async (original) => ({
  ...(await original<object>()),
  readState: async (executor: { serverId: string }) => ({
    serverId: executor.serverId, domain: (await repos.mailServer.get(executor.serverId))?.domain,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), completedSteps: {}, dnsRecords: { a: [] },
  }),
}));

beforeAll(async () => {
  await initPlatform({ target: "desktop", runtime: "bare" });
});
beforeEach(() => {
  h.queued.mockClear();
  h.linkError = null;
  h.queued.mockImplementation(async (_ctx, input) => {
    const { projectId, ...overrides } = input as {
      projectId: string;
      deployTarget: "server" | "cloud";
      serverId: string;
    };
    const project = (await repos.project.findById(projectId))!;
    const { resolveSnapshotTarget } = await vi.importActual<
      typeof import("@repo/platform/engine/modules/deployments/build.service")
    >("@repo/platform/engine/modules/deployments/build.service");
    // Run real deployment placement too: a queued mock alone would hide the
    // missing Cloud binding that used to reject this request after installation.
    expect(await resolveSnapshotTarget(project, overrides)).toMatchObject({
      deployTarget: overrides.deployTarget,
      serverId: overrides.serverId,
    });
    return { deployment_id: "test-webmail-deployment" };
  });
});
afterAll(() => resetPlatform());

async function prepared() {
  const owner = await seedOwner({ instanceAdmin: true });
  const serverId = await seedServer(owner.orgId);
  await repos.mailServer.markInstalled(serverId, "example.com");
  return {
    owner,
    ctx: { organizationId: owner.orgId, userId: owner.userId, role: "owner" } as ExecutionContext,
    serverId,
  };
}

async function deploymentEnv(projectId: string) {
  const project = (await repos.project.findById(projectId))!;
  const services = await repos.service.listByProject(projectId);
  expect(services).toHaveLength(1);
  const service = services[0]!;
  const decryptMap = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, decrypt(value)]));
  // These are the same layers and public-URL resolver consumed by compose deploy.
  const merged = mergeServiceDeployEnv(
    {
      project: decryptMap(await repos.project.getEnvMap(projectId, "production", null)),
      frozen: {},
      inline: service.environment ?? {},
      service: decryptMap(await repos.project.getEnvMap(projectId, "production", service.id)),
    },
    false,
  );
  const urls = buildServicePublicUrlMap(project, services, null);
  const resolved = resolveEnvPublicUrls(merged.env, (name, port) =>
    urls.get(port === undefined ? name : `${name}:${port}`),
  );
  expect(resolved.unresolved).toEqual([]);
  return { service, values: resolved.env };
}

async function managedDestination(ctx: ExecutionContext) {
  const workspace = await repos.cloudWorkspace.link({
    organizationId: ctx.organizationId,
    name: "Webmail Cloud",
    remote: {
      apiUrl: "https://cloud.example.test",
      userId: "cloud-test-user",
      organizationId: "cloud-test-org",
      serverId: `cloud-test-server-${ctx.organizationId}`,
      workspaceId: `cloud-test-workspace-${ctx.organizationId}`,
    },
  });
  return {
    workspace,
    server: (await repos.server.findByWorkspace(workspace.id, ctx.organizationId))!,
  };
}

describe("webmail link recovery", () => {
  async function orphaned() {
    const { ctx, serverId, owner } = await prepared();
    const base = `${serverId.replace(/_/g, "-")}.example.com`;
    await repos.mailServer.markInstalled(serverId, base);
    const domain = await repos.domain.findOrCreate({ hostname: `mail.${base}`, ownerType: "mail", domainType: "custom", verified: true, status: "active" });
    const input = { mailServerId: serverId, hostname: `mail.${base}`, target: { kind: "self" as const, serverId } };
    const first = await startWebmailDeploy(ctx, input);
    const deployed = await repos.deployment.create({ projectId: first.projectId, organizationId: ctx.organizationId, branch: "main", status: "ready", meta: { serverId } });
    await repos.project.update(first.projectId, { activeDeploymentId: deployed!.id });
    const initial = await deploymentEnv(first.projectId);
    await repos.mailServer.remove(serverId);
    await repos.mailServer.markInstalled(serverId, base);
    return { ctx, serverId, owner, base, domain, input, first, initial };
  }

  it("reproduces a recreated mail registration and reconnects without duplicating the app or taking its certificate row", async () => {
    const { ctx, serverId, base, domain, input, first, initial } = await orphaned();
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect(await mailHostRoutableByProject(input.hostname, first.projectId, domain)).toBe(false);
    await expect(ensureRouteDomainRecord({ projectId: first.projectId, route: { hostname: input.hostname } as never, domainByHostname: new Map() }))
      .rejects.toThrow("reserved for the mail service");
    const candidates = await listWebmailRecoveryCandidates(ctx, { serverId, domain: base });
    expect(candidates).toEqual([{ projectId: first.projectId, name: `Webmail ${base}`, hostname: input.hostname, serverId }]);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    await expect(startWebmailDeploy(ctx, input)).rejects.toMatchObject({ code: "WEBMAIL_RECONNECT_REQUIRED" });
    const restored = await startWebmailDeploy(ctx, { ...input, reconnectProjectId: first.projectId });
    expect(restored.projectId).toBe(first.projectId);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBe(first.projectId);
    expect(await repos.project.listByOrganization(ctx.organizationId)).toMatchObject({ total: 1 });
    expect((await deploymentEnv(first.projectId)).values).toEqual(initial.values);
    expect(await mailHostRoutableByProject(input.hostname, first.projectId, domain)).toBe(true);
    await expect(ensureRouteDomainRecord({ projectId: first.projectId, route: { hostname: input.hostname } as never, domainByHostname: new Map() }))
      .resolves.toEqual({ domain: null, created: false });
    expect(await repos.domain.findByHostname(input.hostname)).toMatchObject({ id: domain.id, ownerType: "mail", projectId: null });
    // Retrying the same approved reconnect uses the now-linked project.
    expect((await startWebmailDeploy(ctx, { ...input, reconnectProjectId: first.projectId })).projectId).toBe(first.projectId);
  });

  it("exposes read-only suggestions and reconnects through the public SDK and HTTP contract", async () => {
    const { owner, serverId, input, first } = await orphaned();
    const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/mail", mailRoutes);
    const client = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
    const status = await client.mail.getStatus({ serverId });
    expect(status.webmailRecoveryCandidates?.map(candidate => candidate.projectId)).toEqual([first.projectId]);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    const invalid = await app.request("http://openship.test/api/mail/webmail/deploy-project", {
      method: "POST", headers: { ...owner.auth, "Content-Type": "application/json", "X-Organization-Id": owner.orgId },
      body: JSON.stringify({ ...input, reconnectProjectId: 42 }),
    });
    expect(invalid.status).toBe(400);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect((await client.mail.deployWebmail({ ...input, reconnectProjectId: first.projectId })).projectId).toBe(first.projectId);
    const after = await client.mail.getStatus({ serverId });
    expect(after.webmail?.projectId).toBe(first.projectId);
    expect(after.webmailRecoveryCandidates).toBeUndefined();
  });

  it("treats a failed linked-project lookup as unavailable rather than installing a duplicate", async () => {
    const { ctx, serverId, owner, first, input } = await orphaned();
    await repos.mailServer.setWebmailProject(serverId, first.projectId);
    const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/mail", mailRoutes);
    const lookup = vi.spyOn(repos.project, "findById").mockRejectedValueOnce(new Error("temporary read failure"));
    await expect(startWebmailDeploy(ctx, input)).rejects.toMatchObject({ statusCode: 503, code: "WEBMAIL_LINK_UNAVAILABLE" });
    lookup.mockRejectedValueOnce(new Error("temporary read failure"));
    const response = await app.request(`http://openship.test/api/mail/status?serverId=${serverId}`, { headers: owner.auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MAIL_STATUS_UNAVAILABLE" });
    lookup.mockRestore();
    expect(await repos.project.listByOrganization(ctx.organizationId)).toMatchObject({ total: 1 });
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBe(first.projectId);
  });

  it("does not disclose candidate projects to a scoped identity without project read access", async () => {
    const { ctx, serverId, base, first } = await orphaned();
    const restricted = { ...ctx, tokenScope: { tokenId: "no-webmail-grants" } };
    expect(await listWebmailRecoveryCandidates(restricted, { serverId, domain: base })).toEqual([]);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect((await repos.project.findById(first.projectId))?.deletedAt).toBeNull();
  });

  it("does not grant a link over a project-owned hostname", async () => {
    const { ctx, serverId, domain, input, first, initial } = await orphaned();
    await repos.domain.update(domain.id, { ownerType: "project", projectId: first.projectId });
    await expect(startWebmailDeploy(ctx, { ...input, reconnectProjectId: first.projectId })).rejects.toMatchObject({ code: "WEBMAIL_RECONNECT_INVALID" });
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect((await deploymentEnv(first.projectId)).values).toEqual(initial.values);
  });

  it("rejects a raced or removed mail registration without queuing a build", async () => {
    const { ctx, serverId, base, input, first, initial } = await orphaned();
    const queued = h.queued.mock.calls.length;
    const cas = vi.spyOn(repos.mailServer, "reconnectWebmailProject").mockResolvedValueOnce(false);
    await expect(startWebmailDeploy(ctx, { ...input, reconnectProjectId: first.projectId })).rejects.toMatchObject({ code: "WEBMAIL_LINK_CHANGED" });
    expect(h.queued).toHaveBeenCalledTimes(queued);
    expect((await deploymentEnv(first.projectId)).values).toEqual(initial.values);
    cas.mockRestore();
    await repos.mailServer.remove(serverId);
    expect(await repos.mailServer.reconnectWebmailProject(serverId, base, first.projectId)).toBe(false);
    expect(await repos.mailServer.get(serverId)).toBeUndefined();
  });

  it("rejects another organization's project without changing the missing link", async () => {
    const source = await orphaned();
    const foreign = await prepared();
    await expect(startWebmailDeploy(foreign.ctx, { ...source.input, mailServerId: foreign.serverId, target: { kind: "self", serverId: foreign.serverId }, reconnectProjectId: source.first.projectId }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect((await repos.mailServer.get(foreign.serverId))?.webmailProjectId).toBeNull();
    expect(await listWebmailRecoveryCandidates(foreign.ctx, { serverId: foreign.serverId, domain: "example.com" })).toEqual([]);
  });

  it("refuses to move a recovered app or replace a link another request already established", async () => {
    const { ctx, serverId, base, input, first, initial } = await orphaned();
    const otherServer = await seedServer(ctx.organizationId);
    await expect(startWebmailDeploy(ctx, { ...input, hostname: "inbox.example.com", target: { kind: "self", serverId: otherServer }, reconnectProjectId: first.projectId }))
      .rejects.toMatchObject({ code: "WEBMAIL_RECONNECT_INVALID" });
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect((await deploymentEnv(first.projectId)).values).toEqual(initial.values);
    const other = await startExternalWebmailDeploy(ctx, { hostname: "other.example.com", backend: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465 }, target: { deployTarget: "server", serverId } });
    await repos.mailServer.setWebmailProject(serverId, other.projectId);
    await expect(startWebmailDeploy(ctx, { ...input, reconnectProjectId: first.projectId })).rejects.toMatchObject({ code: "WEBMAIL_LINK_CHANGED" });
    expect(await repos.mailServer.reconnectWebmailProject(serverId, base, first.projectId)).toBe(false);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBe(other.projectId);
  });

  it("does not adopt a webmail registered to another mail server", async () => {
    const { ctx, serverId, base, first } = await orphaned();
    const otherServer = await seedServer(ctx.organizationId);
    await repos.mailServer.markInstalled(otherServer, "other.example.com");
    await repos.mailServer.setWebmailProject(otherServer, first.projectId);
    expect(await listWebmailRecoveryCandidates(ctx, { serverId, domain: base })).toEqual([]);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
  });
});

describe("Deploy webmail backend configuration", () => {
  it("carries the mail server backend and generated secrets through install and redeploy", async () => {
    const { ctx, serverId } = await prepared();
    const input = {
      mailServerId: serverId,
      hostname: "webmail.example.com",
      target: { kind: "self" as const, serverId },
    };
    const first = await startWebmailDeploy(ctx, input);
    const initial = await deploymentEnv(first.projectId);
    expect(initial.service.advanced).toMatchObject({ extraHosts: { "mail.example.com": "host-gateway" } });
    expect(initial.values).toMatchObject({
      DEFAULT_IMAP_HOST: "mail.example.com",
      DEFAULT_IMAP_PORT: "993",
      DEFAULT_SMTP_HOST: "mail.example.com",
      DEFAULT_SMTP_PORT: "465",
      TRUSTED_ORIGINS: "https://webmail.example.com",
    });
    expect(initial.values.SESSION_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.values.BRANDING_ADMIN_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBe(first.projectId);

    const retry = await startWebmailDeploy(ctx, { ...input, hostname: "inbox.example.com" });
    expect(retry.projectId).toBe(first.projectId);
    const next = await deploymentEnv(retry.projectId);
    expect(next.service.id).toBe(initial.service.id);
    expect(next.service.advanced).toMatchObject({ extraHosts: { "mail.example.com": "host-gateway" } });
    expect(next.values).toEqual({
      ...initial.values,
      TRUSTED_ORIGINS: "https://inbox.example.com",
    });
    expect(h.queued).toHaveBeenCalledTimes(2);
    expect(h.queued.mock.calls[1]).toEqual([
      ctx,
      expect.objectContaining({ projectId: first.projectId, deployTarget: "server", serverId }),
    ]);
  });

  it("keeps the mail backend pinned when Cloud serves the mail hostname through its proxy", async () => {
    const { ctx, serverId } = await prepared();
    const { workspace, server: managedServer } = await managedDestination(ctx);
    const installed = await startWebmailDeploy(ctx, {
      mailServerId: serverId,
      hostname: "mail.example.com",
      target: { kind: "cloud", serverId: managedServer.id },
    });
    expect(await repos.project.findById(installed.projectId)).toMatchObject({
      workspaceId: workspace.id,
      serverId: managedServer.id,
    });
    const { values, service } = await deploymentEnv(installed.projectId);
    expect(service.advanced?.extraHosts).toBeUndefined();
    expect(values).toMatchObject({
      DEFAULT_IMAP_HOST: "mail.example.com",
      DEFAULT_IMAP_PORT: "993",
      DEFAULT_SMTP_HOST: "mail.example.com",
      DEFAULT_SMTP_PORT: "465",
      TRUSTED_ORIGINS: "https://mail.example.com",
    });
    expect(h.queued.mock.calls[0]).toEqual([
      ctx,
      expect.objectContaining({ deployTarget: "cloud", serverId: managedServer.id }),
    ]);
    const retried = await startWebmailDeploy(ctx, {
      mailServerId: serverId,
      hostname: "mail.example.com",
      target: { kind: "cloud", serverId: managedServer.id },
    });
    expect(retried.projectId).toBe(installed.projectId);
    expect((await deploymentEnv(retried.projectId)).values).toEqual(values);
  });

  it("removes a stale local-backend mapping on another server while preserving other aliases", async () => {
    const { ctx, serverId, owner } = await prepared();
    const otherServerId = await seedServer(owner.orgId);
    const input = { mailServerId: serverId, hostname: `other-${otherServerId.replace(/_/g, "-")}.example.com`, target: { kind: "self" as const, serverId: otherServerId } };
    const installed = await startWebmailDeploy(ctx, input);
    const initial = await deploymentEnv(installed.projectId);
    expect(initial.service.advanced?.extraHosts).toBeUndefined();
    await repos.service.update(initial.service.id, { advanced: { ...initial.service.advanced, extraHosts: { "mail.example.com": "host-gateway", "private.example.com": "10.0.0.2" } } });
    await startWebmailDeploy(ctx, input);
    const next = await deploymentEnv(installed.projectId);
    expect(next.service.advanced?.extraHosts).toEqual({"private.example.com":"10.0.0.2"});
    expect(next.values).toEqual(initial.values);
  });

  it("rejects an invalid host mapping without partially editing a working service", async () => {
    const {ctx,serverId}=await prepared();
    const installed=await startWebmailDeploy(ctx,{mailServerId:serverId,hostname:"webmail.example.com",target:{kind:"self",serverId}});
    const {service}=await deploymentEnv(installed.projectId);
    await expect(updateService(ctx,installed.projectId,service.id,{enabled:false,advanced:{extraHosts:{mail:"invalid"}}})).rejects.toThrow(/addresses/);
    const saved=(await repos.service.listByProject(installed.projectId))[0]!;
    expect(saved.enabled).toBe(true);
    expect(saved.advanced?.extraHosts).toEqual({"mail.example.com":"host-gateway"});
  });

  it.each(["missing", "foreign", "unmanaged"] as const)(
    "rejects a %s Cloud destination before creating a draft or mail link",
    async (kind) => {
      const { ctx, serverId } = await prepared();
      const targetId =
        kind === "missing"
          ? undefined
          : kind === "foreign"
            ? await seedServer((await seedOwner()).orgId)
            : serverId;
      await expect(
        startWebmailDeploy(ctx, {
          mailServerId: serverId,
          hostname: "webmail.example.com",
          target: { kind: "cloud", serverId: targetId },
        }),
      ).rejects.toMatchObject({
        statusCode: kind === "missing" ? 409 : kind === "foreign" ? 404 : 400,
      });
      expect(await repos.project.listByOrganization(ctx.organizationId)).toMatchObject({
        rows: [],
        total: 0,
      });
      expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
      expect(h.queued).not.toHaveBeenCalled();
    },
  );

  it("refuses a Cloud migration before changing the linked webmail route, backend, or secrets", async () => {
    const { ctx, serverId } = await prepared();
    const { server: managedServer } = await managedDestination(ctx);
    const installed = await startWebmailDeploy(ctx, {
      mailServerId: serverId,
      hostname: "mail.example.com",
      target: { kind: "cloud", serverId: managedServer.id },
    });
    const before = await deploymentEnv(installed.projectId);
    await expect(
      startWebmailDeploy(ctx, {
        mailServerId: serverId,
        hostname: "different.example.com",
        target: { kind: "self", serverId },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_TARGET_CONFLICT" });
    expect(await deploymentEnv(installed.projectId)).toEqual(before);
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBe(installed.projectId);
    expect(h.queued).toHaveBeenCalledOnce();
  });

  it("checks server write permission before creating or linking a project", async () => {
    const { ctx, serverId } = await prepared();
    await expect(
      startWebmailDeploy(
        { ...ctx, credential: { organizationId: ctx.organizationId, readOnly: true } },
        {
          mailServerId: serverId,
          hostname: "webmail.example.com",
          target: { kind: "self", serverId },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TOKEN_READ_ONLY" });
    expect(await repos.project.listByOrganization(ctx.organizationId)).toMatchObject({ total: 0 });
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect(h.queued).not.toHaveBeenCalled();
  });

  it("requires the saved Cloud account binding before writing deployment configuration", async () => {
    const { ctx, serverId } = await prepared();
    const { server } = await managedDestination(ctx);
    h.linkError = new Error("Cloud account must be reconnected");
    await expect(
      startWebmailDeploy(ctx, {
        mailServerId: serverId,
        hostname: "webmail.example.com",
        target: { kind: "cloud", serverId: server.id },
      }),
    ).rejects.toBe(h.linkError);
    expect(await repos.project.listByOrganization(ctx.organizationId)).toMatchObject({ total: 0 });
    expect((await repos.mailServer.get(serverId))?.webmailProjectId).toBeNull();
    expect(h.queued).not.toHaveBeenCalled();
  });

  it.each(["server", "cloud"] as const)(
    "preserves an external backend when deploying to %s and retrying",
    async (deployTarget) => {
      const { ctx, serverId } = await prepared();
      const destinationId =
        deployTarget === "cloud" ? (await managedDestination(ctx)).server.id : serverId;
      const input = {
        hostname: `external-webmail-${deployTarget}.example.com`,
        backend: {
          imapHost: "imap.external.example",
          imapPort: 143,
          smtpHost: "smtp.external.example",
          smtpPort: 587,
        },
        target: { deployTarget, serverId: destinationId },
      };
      const first = await startExternalWebmailDeploy(ctx, input);
      const initial = await deploymentEnv(first.projectId);
      expect(initial.service.advanced?.extraHosts).toBeUndefined();
      expect(initial.values).toMatchObject({
        DEFAULT_IMAP_HOST: input.backend.imapHost,
        DEFAULT_IMAP_PORT: "143",
        DEFAULT_SMTP_HOST: input.backend.smtpHost,
        DEFAULT_SMTP_PORT: "587",
        TRUSTED_ORIGINS: `https://${input.hostname}`,
      });
      const retried = await startExternalWebmailDeploy(ctx, input);
      expect(retried.projectId).toBe(first.projectId);
      expect((await deploymentEnv(retried.projectId)).values).toEqual(initial.values);
    },
  );
});
