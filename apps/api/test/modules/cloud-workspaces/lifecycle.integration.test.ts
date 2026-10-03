import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";

const h = vi.hoisted(() => ({
  client: {} as any,
  billing: {} as any,
  exec: vi.fn(),
  cloud: true,
  forward: vi.fn(),
}));
vi.mock("../../../src/app", () => ({ app: { fetch: h.forward } }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      BILLING_ENABLED: true,
      OBLIEN_WEBHOOK_SECRET: "workspace-test-webhook-secret",
      get CLOUD_MODE() {
        return h.cloud;
      },
    },
  };
});
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => h.client,
  getOblienBillingApi: () => h.billing,
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  Oblien: class {
    constructor() {
      return h.client;
    }
  },
  CloudWorkspaceExecutor: class {
    exec = h.exec;
    async dispose() {}
  },
}));

import {
  db,
  schema,
  repos,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { eq } from "@repo/db";
import { AppError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { billingSaasRoutes } from "../../../src/modules/billing/billing.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";
import { handleApiError } from "../../../src/middleware/error-handler";
import { scanRoutes } from "../../../src/lib/route-scanner";
import { ensureCloudDockerWorkspace } from "@repo/platform/engine/lib/cloud-docker-workspace";
import { ensureNamespace } from "@repo/platform/engine/lib/openship-cloud";
import { cloudBillingOwner } from "@repo/platform/engine/lib/cloud-workspace-scope";
import { withCloudWorkspaceActivity } from "@repo/platform/engine/lib/cloud-workspace-lock";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";
import {
  processWorkspaceOperation,
  requestPaidWorkspaceProvisioning,
} from "@repo/platform/engine/modules/cloud-workspaces/cloud-workspace.service";
import {
  assertCloudCanSpend,
  syncOblienEntitlement,
  withCloudBillingLock,
} from "@repo/platform/engine/modules/billing/billing-oblien-quota";
import {
  subscriptionMetadata,
  subscriptionOffer,
} from "@repo/platform/engine/modules/billing/billing-catalog";
import {
  createTrackedWorkspaceCheckout,
  assertWorkspaceCheckoutsSettled,
} from "@repo/platform/engine/modules/billing/workspace-checkout";
import { getCheckoutStatus } from "@repo/platform/engine/modules/billing/billing.service";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { deleteFolderSession } from "@repo/platform/engine/modules/projects/folder/session-store";
import { rm } from "node:fs/promises";

// Real HTTP authorization, SQL ownership, billing reconciliation, provisioning
// and operation workers. Only provider transport/execution is simulated here;
// cloud-shared-workspace.e2e runs the Docker side on a real daemon.
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .use("*", async (c, next) => {
    c.set("clientIp", "192.0.2.72");
    await next();
  })
  .route("/api/health", healthRoutes)
  .route("/api/system", serverResourceRoutes)
  .route("/api/billing", billingSaasRoutes)
  .route("/api/mcp", mcpRoutes);
const vms = new Map<string, any>();
const subscriptions = new Map<string, OblienSubscription>();
const policies = new Map<string, any>();
let owner: SeededOwner;
let workspace: Awaited<ReturnType<typeof repos.cloudWorkspace.create>>;
const runningIds = ["a".repeat(64), "b".repeat(64)];

async function request(method: string, suffix = "", body?: unknown, actor = owner) {
  const parts = suffix.split("/");
  if (parts[1]) parts[1] = (await repos.server.findByWorkspace(parts[1], owner.orgId))?.id ?? parts[1];
  const path = parts.join("/") + (method === "DELETE" ? "/managed" : !suffix && method === "POST" ? "/managed" : "");
  const response = await app.request(`/api/system/servers${path}`, {
    method,
    headers: { ...actor.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function nativeShip(actor = owner, credential?: VerifiedIdentity["credential"]) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => ({ user, sessionId: "workspace-test", credential }) },
  });
  return ship.scope({ identity: "verified", organizationId: actor.orgId });
}
async function clients(actor = owner, credential?: VerifiedIdentity["credential"]) {
  return [
    (await nativeShip(actor, credential)).servers,
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token: actor.token,
      organizationId: actor.orgId,
      fetch: ((url, init) => app.request(String(url), init)) as typeof fetch,
    }).servers,
  ];
}
function subscribe(tier: "hobby" | "starter" = "hobby") {
  const namespace = workspace.namespace!;
  subscriptions.set(namespace, {
    tierId: "reseller",
    status: "active",
    billingInterval: "monthly",
    periodStart: "2026-10-01T00:00:00Z",
    periodEnd: "2026-11-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    canceledAt: null,
    offer: subscriptionOffer(tier, "monthly"),
    metadata: subscriptionMetadata(tier, owner.orgId, namespace),
  });
}
async function addProject(name: string) {
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name,
    slug: `${name}-${randomUUID()}`,
  });
  return repos.project.create({
    organizationId: owner.orgId,
    serverId: (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id,
    groupId: group.id,
    name,
    slug: group.slug,
  });
}
async function provision() {
  const result = await request("POST", `/${workspace.id}/ensure`);
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  await drainBackgroundWork();
  const row = await repos.cloudWorkspace.findById(workspace.id);
  expect(row?.operation).toMatchObject({ status: "succeeded" });
  return (await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: workspace.id }, owner.orgId))!;
}
beforeEach(async () => {
  vi.clearAllMocks();
  h.cloud = true;
  vms.clear();
  subscriptions.clear();
  policies.clear();
  h.forward.mockImplementation((request: Request) => app.fetch(request));
  resetMcpToolCache();
  h.exec.mockImplementation(async (command: string) => {
    if (command.startsWith("docker ps")) return runningIds.join("\n");
    if (command.startsWith("docker inspect")) return runningIds.map(() => "true").join("\n");
    return "";
  });
  h.client = {
    namespaces: {
      ensure: vi.fn(async (input: any) => {
        policies.set(input.slug, input.resource_limits);
        return { data: { id: input.slug, slug: input.slug } };
      }),
      get: vi.fn(async (slug: string) => ({
        data: { id: slug, slug, resource_limits: policies.get(slug) },
      })),
      update: vi.fn(async (slug: string, input: any) => {
        policies.set(slug, input.resource_limits);
        return { data: { id: slug, slug, resource_limits: input.resource_limits } };
      }),
    },
    tokens: {
      create: vi.fn(async (input: any) => ({
        token: `test:${input.namespace}`,
        expiresAt: "2030-01-01T00:00:00Z",
      })),
    },
    workspaces: {
      create: vi.fn(async (input: any) => {
        const existing = [...vms.values()].find((vm) => vm.slug === input.slug);
        if (existing) return existing;
        const vm = {
          id: `vm-${randomUUID()}`,
          namespace: input.namespace,
          slug: input.slug,
          status: "running",
          resources: {
            cpus: input.config.cpus,
            memory_mb: input.config.memory_mb,
            disk_size_mb: input.config.disk_size_mb,
          },
        };
        vms.set(vm.id, vm);
        return vm;
      }),
      get: vi.fn(async (id: string) => {
        const vm = vms.get(id);
        if (!vm) throw Object.assign(new Error("missing"), { status: 404 });
        return vm;
      }),
      list: vi.fn(async () => ({
        workspaces: [...vms.values()],
        total: vms.size,
        page: 1,
        limit: 100,
      })),
    },
    resize: vi.fn(async (id: string, input: any) => {
      vms.get(id).resources = {
        cpus: input.cpus,
        memory_mb: input.memory_mb,
        disk_size_mb: input.disk_size_mb,
      };
      return { success: true };
    }),
    delete: vi.fn(async (id: string) => {
      vms.delete(id);
      return { success: true };
    }),
    workspace: (id: string) => ({
      id,
      get: () => h.client.workspaces.get(id),
      lifecycle: { makePermanent: async () => {} },
      resources: { update: (input: any) => h.client.resize(id, input) },
      delete: () => h.client.delete(id),
      workloads: { list: async () => [] },
      runtime: async () => ({}),
      invalidateRuntime() {},
    }),
  };
  h.billing = {
    getDefaults: async () => ({
      autoApply: true,
      quotaLimit: 0,
      overdraft: 0,
      suspendThreshold: 0,
      onOverdraftAction: "stop_workspaces",
    }),
    getSubscription: vi.fn(async (namespace: string) => ({
      success: true,
      namespace,
      subscription: subscriptions.get(namespace) ?? null,
    })),
    getEntitlement: vi.fn(async (namespace: string) => {
      const sub = subscriptions.get(namespace);
      return {
        success: true,
        namespace,
        tierId: sub?.tierId ?? null,
        status: sub?.status ?? "credit_exhausted",
        periodStart: sub?.periodStart ?? null,
        periodEnd: sub?.periodEnd ?? null,
        quota: { limit: sub ? 1000 : 0, used: 0, balance: sub ? 1000 : 0 },
      };
    }),
    getBalance: vi.fn(async (namespace: string) => ({
      namespace,
      balance: subscriptions.has(namespace) ? 1000 : 0,
      blocking: !subscriptions.has(namespace),
    })),
    createCheckout: vi.fn(async () => ({
      checkoutId: "checkout-test",
      url: "https://checkout.stripe.com/test",
    })),
    getCheckout: vi.fn(async () => ({ checkout: { status: "open", fulfilled: false } })),
  };
  owner = await seedOwner();
  workspace = await repos.cloudWorkspace.create({
    organizationId: owner.orgId,
    name: "Production",
  });
  await ensureNamespace(owner.orgId, workspace.id);
  workspace = (await repos.cloudWorkspace.findById(workspace.id))!;
  subscribe();
});
afterEach(async () => {
  await drainBackgroundWork();
});

describe("subscription-owned Cloud workspace lifecycle", () => {
  it("passes the production route scanner and requires authentication and ownership", async () => {
    expect(scanRoutes(app).errors).toEqual([]);
    expect((await app.request("/api/system/servers")).status).toBe(401);
    const stranger = await seedOwner();
    expect((await request("POST", `/${workspace.id}/ensure`, undefined, stranger)).status).toBe(
      404,
    );
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
    const invalid = await request("POST", "", {
      name: "Broken",
      mode: "shared",
      runtime: "native",
    });
    expect(invalid.status).toBe(400);
  });
  it("discovers and executes the same workspace lifecycle through MCP with tenant and read-only checks", async () => {
    const rpc = async (method: string, params?: Record<string, unknown>, actor = owner) => {
      const response = await app.request("/api/mcp", {
        method: "POST",
        headers: { ...actor.auth, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).result;
    };
    const discovered = await rpc("tools/list");
    const names = discovered.tools.map((tool: { name: string }) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("get_system_servers");
    expect(names).toContain("post_system_servers_by_id_ensure");
    const queued = await rpc("tools/call", {
      name: "post_system_servers_by_id_ensure",
      arguments: { id: (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id },
    });
    expect(queued.isError).toBe(false);
    await drainBackgroundWork();
    const observed = await rpc("tools/call", {
      name: "get_system_servers_by_id",
      arguments: { id: (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id },
    });
    expect(observed.isError).toBe(false);
    expect(JSON.parse(observed.content[0].text).managed.operation.status).toBe("succeeded");
    expect(h.client.workspaces.create).toHaveBeenCalledTimes(1);

    const outsider = await seedOwner();
    expect(
      (
        await rpc(
          "tools/call",
          { name: "get_system_servers_by_id", arguments: { id: (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id } },
          outsider,
        )
      ).isError,
    ).toBe(true);
    await db
      .update(schema.personalAccessToken)
      .set({ readOnly: true })
      .where(eq(schema.personalAccessToken.userId, owner.userId));
    expect(
      (
        await rpc("tools/call", {
          name: "post_system_servers_by_id_ensure",
          arguments: { id: (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id },
        })
      ).isError,
    ).toBe(true);
    expect(h.client.workspaces.create).toHaveBeenCalledTimes(1);
  });
  it("provisions on paid reconciliation and reuses one host across simultaneous project deployments", async () => {
    await syncOblienEntitlement(owner.orgId, { workspaceId: workspace.id });
    await requestPaidWorkspaceProvisioning(owner.orgId, workspace.id);
    await drainBackgroundWork();
    const a = await addProject("A"),
      b = await addProject("B");
    expect(a.serverId).toBeTruthy();
    expect(a.serverId).toBe(b.serverId);
    const targets = await Promise.all(
      [a, b].map((project) =>
        ensureCloudDockerWorkspace({
          projectId: project.id,
          organizationId: owner.orgId,
        }),
      ),
    );
    expect(targets[0]?.workspaceId).toBe(targets[1]?.workspaceId);
    expect(targets.map((target) => target.ownerWorkspaceId)).toEqual([workspace.id, workspace.id]);
    expect(h.client.workspaces.create).toHaveBeenCalledTimes(1);
    expect(h.client.resize).not.toHaveBeenCalled();
    expect(vms.get(targets[0]!.workspaceId).resources).toMatchObject({
      cpus: 1,
      memory_mb: 4096,
      disk_size_mb: 25600,
    });
    await db.delete(schema.project).where(eq(schema.project.id, a.id));
    expect((await repos.cloudDockerWorkspace.find(b.id, owner.orgId))?.workspaceId).toBe(
      targets[0]?.workspaceId,
    );
    expect(h.client.delete).not.toHaveBeenCalled();
  });
  it("creates projects through the public server selector and pins their Cloud owner", async () => {
    const sdk = await nativeShip();
    const server = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!;
    const project = await sdk.projects.create({ name: "Managed project", serverId: server.id });
    const saved = (await repos.project.findById(project.id))!;
    expect(saved).toMatchObject({ serverId: server.id, workspaceId: workspace.id });
    const { resolveSnapshotTarget } =
      await import("@repo/platform/engine/modules/deployments/build.service");
    expect(
      await resolveSnapshotTarget(saved, { serverId: server.id, deployTarget: "server" }),
    ).toMatchObject({ serverId: server.id, deployTarget: "cloud" });
    const other = await repos.cloudWorkspace.create({
      organizationId: owner.orgId,
      name: "Other",
    });
    const otherServer = (await repos.server.findByWorkspace(other.id, owner.orgId))!;
    await expect(
      resolveSnapshotTarget(saved, { serverId: otherServer.id, deployTarget: "server" }),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_TARGET_CONFLICT" });
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("places bare and Docker projects on managed servers without provisioning a second host", async () => {
    const sdk = await nativeShip();
    const selected = await sdk.servers.createManaged({ name: "Direct apps" });
    await ensureNamespace(owner.orgId, selected.id);
    workspace = (await repos.cloudWorkspace.findById(selected.id))!;
    subscribe();
    const bare = await sdk.projects.create({ name: "Direct app", serverId: selected.serverId });
    await repos.project.update(bare.id, { runtimeMode: "bare" });
    const docker = await sdk.projects.create({ name: "Docker app", serverId: selected.serverId });
    for (const project of [bare, docker])
      expect(await repos.project.findById(project.id)).toMatchObject({ serverId: selected.serverId, workspaceId: selected.id });
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("installs and previews catalog apps on the selected managed server without creating a project VM", async () => {
    subscribe("starter");
    const sdk = await nativeShip();
    const server = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!;
    const preview = await sdk.apps.hostFit("redis", { serverId: server.id });
    expect(preview.cloud?.status, preview.cloud?.message).toBe("ready");
    const result = await sdk.apps.install({ templateId: "redis", serverId: server.id });
    if (result.kind !== "template") throw new Error("Expected a catalog project");
    expect(await repos.project.findById(result.projectId)).toMatchObject({
      serverId: server.id,
      workspaceId: workspace.id,
      isApp: true,
    });
    expect(await repos.service.listByProject(result.projectId)).toHaveLength(2);
    expect((await sdk.apps.hostFit("redis", { projectId: result.projectId })).cloud?.status).toBe(
      "ready",
    );
    await expect(
      sdk.apps.hostFit("redis", { projectId: result.projectId, serverId: "another-host" }),
    ).rejects.toMatchObject({ code: "PROJECT_SERVER_TARGET_CONFLICT" });
    const stranger = await nativeShip(await seedOwner());
    await expect(
      stranger.apps.install({ templateId: "redis", serverId: server.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("carries one managed server through source staging, scan and project creation", async () => {
    const sdk = await nativeShip();
    const server = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!;
    const staged = await sdk.sources.stage({
      serverId: server.id,
      source: {
        type: "files",
        files: {
          "package.json": JSON.stringify({
            name: "managed-source",
            scripts: { start: "node index.js" },
          }),
          "index.js": "console.log('source fixture');",
        },
      },
    });
    try {
      expect(staged).toMatchObject({ serverId: server.id, workspaceId: workspace.id });
      const scan = await sdk.sources.scan(staged.sessionId);
      expect(scan).toMatchObject({ serverId: server.id, workspaceId: workspace.id });
      const project = await sdk.projects.create({ name: "Source app", serverId: scan.serverId });
      expect(await repos.project.findById(project.id)).toMatchObject({
        serverId: server.id,
        workspaceId: workspace.id,
      });
      const stranger = await nativeShip(await seedOwner());
      await expect(stranger.sources.scan(staged.sessionId)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(h.client.workspaces.create).not.toHaveBeenCalled();
    } finally {
      const session = deleteFolderSession(staged.sessionId);
      if (session?.stagingDir) await rm(session.stagingDir, { recursive: true, force: true });
    }
  });
  it("recovers a lost provider create response with the same request and disk", async () => {
    const create = h.client.workspaces.create.getMockImplementation()!;
    h.client.workspaces.create.mockImplementationOnce(async (input: any) => {
      await create(input);
      throw new Error("create response lost");
    });
    expect((await request("POST", `/${workspace.id}/ensure`)).status).toBe(202);
    await drainBackgroundWork();
    const interrupted = (await repos.cloudWorkspace.findById(workspace.id))!;
    expect(interrupted.operation?.status).toBe("queued");
    expect(vms.size).toBe(1);
    await repos.cloudWorkspace.updateOperation(
      workspace.id,
      { ...interrupted.operation!, nextAttemptAt: null },
      interrupted.operation!.id,
    );
    await processWorkspaceOperation(workspace.id);
    expect((await repos.cloudWorkspace.findById(workspace.id))?.operation?.status).toBe(
      "succeeded",
    );
    expect(vms.size).toBe(1);
    expect(
      new Set(h.client.workspaces.create.mock.calls.map(([input]: any[]) => input.idempotency_key))
        .size,
    ).toBe(1);
    expect(
      (await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: workspace.id }, owner.orgId))
        ?.workspaceId,
    ).toBe([...vms.keys()][0]);
  });
  it("reconciles signed duplicate billing events and a checkout poll into one subscribed host", async () => {
    const other = await repos.cloudWorkspace.create({
      organizationId: owner.orgId,
      name: "Other",
    });
    await ensureNamespace(owner.orgId, other.id);
    const eventId = randomUUID();
    const body = JSON.stringify({
      id: eventId,
      event: "payment.succeeded",
      namespace: workspace.namespace,
      timestamp: new Date().toISOString(),
      data: {},
    });
    const signature = createHmac("sha256", "workspace-test-webhook-secret")
      .update(body)
      .digest("hex");
    const deliver = (sig = signature) =>
      app.request("/api/billing/oblien-webhook", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-webhook-id": eventId,
          "x-webhook-signature": sig,
        },
      });
    expect((await deliver("bad-signature")).status).toBe(401);
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
    h.billing.getCheckout.mockImplementation(async () => ({
      checkout: {
        id: "checkout-complete",
        status: "complete",
        fulfilled: true,
        namespaceCreditsGranted: 400,
      },
    }));
    const result = await Promise.all([
      deliver(),
      deliver(),
      getCheckoutStatus(owner.orgId, "checkout-complete", workspace.id),
    ]);
    expect((result[0] as Response).status).toBe(200);
    expect((result[1] as Response).status).toBe(200);
    await drainBackgroundWork();
    expect(h.client.workspaces.create).toHaveBeenCalledTimes(1);
    expect((await repos.cloudWorkspace.findById(workspace.id))?.operation?.status).toBe(
      "succeeded",
    );
    expect((await repos.cloudWorkspace.findById(other.id))?.planTierId).toBe("free");
    expect(
      await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: other.id }, owner.orgId),
    ).toBeUndefined();
    expect((await repos.organization.findById(owner.orgId))?.planTierId).toBe("free");
  });
  it("uses the same scoped server operations through native and HTTP SDKs", async () => {
    const server = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!;
    for (const client of await clients()) {
      expect((await client.list()).some(row => row.id === server.id)).toBe(true);
      const created = await client.createManaged({ name: "Isolated draft" });
      expect(await client.update(created.serverId, { name: "Renamed draft" })).toMatchObject({ name: "Renamed draft" });
      await ensureNamespace(owner.orgId, created.id);
      await expect(client.ensure(created.serverId)).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
      await client.removeManaged(created.serverId, { idempotencyKey: randomUUID(), confirmDelete: true });
      await drainBackgroundWork();
      await expect(client.get(created.serverId)).rejects.toMatchObject({ statusCode: 404 });
    }
    const other = await seedOwner();
    for (const client of await clients(other))
      await expect(client.get(server.id)).rejects.toMatchObject({ statusCode: 404 });
    await db.update(schema.personalAccessToken).set({ readOnly: true }).where(eq(schema.personalAccessToken.userId, owner.userId));
    for (const client of await clients(owner, { organizationId: owner.orgId, readOnly: true })) {
      expect(await client.get(server.id)).toMatchObject({ id: server.id, managed: { id: workspace.id } });
      await expect(client.update(server.id, { name: "Unauthorized" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(client.ensure(server.id)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(client.resize(server.id, { revision: "a".repeat(64), confirmRestart: true, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    }
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("does not provision, stop or change the entitlement mirror when provider billing is unavailable", async () => {
    await syncOblienEntitlement(owner.orgId, { workspaceId: workspace.id });
    h.billing.getEntitlement.mockRejectedValue(new Error("Billing temporarily unavailable"));
    const response = await request("POST", `/${workspace.id}/ensure`);
    expect(response.status).toBe(500);
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
    expect(h.client.delete).not.toHaveBeenCalled();
    expect((await repos.cloudWorkspace.findById(workspace.id))?.subscriptionStatus).toBe("active");
  });
  it("isolates independent subscriptions and never guesses an organization-wide plan", async () => {
    await syncOblienEntitlement(owner.orgId, { workspaceId: workspace.id });
    const other = await repos.cloudWorkspace.create({
      organizationId: owner.orgId,
      name: "Staging",
    });
    await ensureNamespace(owner.orgId, other.id);
    await expect(assertCloudCanSpend(owner.orgId, other.id)).rejects.toMatchObject({
      code: "CLOUD_BILLING_BLOCKED",
    });
    await expect(cloudBillingOwner(owner.orgId)).rejects.toMatchObject({
      code: "CLOUD_WORKSPACE_REQUIRED",
    });
    await expect(ensureNamespace(owner.orgId, "organization")).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_NOT_FOUND" });
    await expect(cloudBillingOwner(owner.orgId, null)).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_REQUIRED" });
    expect((await cloudBillingOwner(owner.orgId, workspace.id)).planTierId).toBe("hobby");
  });
  it("queues a reviewed resize, restores the running containers, and retains completion logs", async () => {
    await provision();
    await addProject("API");
    subscribe("starter");
    const preview = await request("GET", `/${workspace.id}/resize`);
    expect(preview.status).toBe(200);
    const payload = {
      revision: preview.body.revision,
      idempotencyKey: randomUUID(),
      confirmRestart: true,
    };
    const result = await request("POST", `/${workspace.id}/resize`, payload);
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    await drainBackgroundWork();
    const row = await repos.cloudWorkspace.findById(workspace.id);
    expect(row?.operation).toMatchObject({ status: "succeeded", restartWorkloads: { wasRunning: true, containers: runningIds, processes: [] } });
    expect(row?.operation?.logs.at(-1)).toContain("restored");
    expect(h.exec).toHaveBeenCalledWith(
      expect.stringContaining(`docker start '${runningIds[0]}' '${runningIds[1]}'`),
    );
    const count = h.client.resize.mock.calls.length;
    expect((await request("POST", `/${workspace.id}/resize`, payload)).status).toBe(202);
    await drainBackgroundWork();
    expect(h.client.resize).toHaveBeenCalledTimes(count);
  });
  it("rejects stale resize previews and missing restart confirmation before any provider write", async () => {
    await provision();
    subscribe("starter");
    const preview = (await request("GET", `/${workspace.id}/resize`)).body;
    await addProject("Added after preview");
    const body = { revision: preview.revision, idempotencyKey: randomUUID(), confirmRestart: true };
    expect((await request("POST", `/${workspace.id}/resize`, body)).body.code).toBe(
      "CLOUD_WORKSPACE_CHANGED",
    );
    expect(
      (await request("POST", `/${workspace.id}/resize`, { ...body, confirmRestart: false })).status,
    ).toBe(400);
    expect(h.client.resize).not.toHaveBeenCalled();
  });
  it("keeps the recovery checkpoint after a lost resize response and resumes the same operation", async () => {
    await provision();
    subscribe("starter");
    const resize = h.client.resize.getMockImplementation()!;
    h.client.resize.mockImplementationOnce(async (...args: any[]) => {
      await resize(...args);
      throw new Error("response lost after resize");
    });
    const preview = (await request("GET", `/${workspace.id}/resize`)).body;
    await request("POST", `/${workspace.id}/resize`, {
      revision: preview.revision,
      idempotencyKey: randomUUID(),
      confirmRestart: true,
    });
    await drainBackgroundWork();
    let row = (await repos.cloudWorkspace.findById(workspace.id))!;
    expect(row.operation).toMatchObject({ status: "queued", restartWorkloads: { wasRunning: true, containers: runningIds, processes: [] } });
    await repos.cloudWorkspace.updateOperation(
      workspace.id,
      { ...row.operation!, nextAttemptAt: null },
      row.operation!.id,
    );
    await processWorkspaceOperation(workspace.id);
    row = (await repos.cloudWorkspace.findById(workspace.id))!;
    expect(row.operation?.status).toBe("succeeded");
    expect(h.client.resize).toHaveBeenCalledTimes(1);
    expect(
      h.exec.mock.calls.filter(([command]) => command.startsWith("docker start")).map(([command]) => command),
    ).toEqual(Array(2).fill(`docker start '${runningIds[0]}' '${runningIds[1]}'`));
  });
  it("waits for workspace activity and refuses deletion until membership and paid billing end", async () => {
    const binding = await provision();
    const project = await addProject("API");
    const payload = { idempotencyKey: randomUUID(), confirmDelete: true };
    expect((await request("DELETE", `/${workspace.id}`, payload)).status).toBe(409);
    subscriptions.delete(workspace.namespace!);
    expect((await request("DELETE", `/${workspace.id}`, payload)).status).toBeGreaterThanOrEqual(
      400,
    );
    await db.delete(schema.project).where(eq(schema.project.id, project.id));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activity = withCloudWorkspaceActivity(workspace.id, () => gate);
    const result = await request("DELETE", `/${workspace.id}`, payload);
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(vms.has(binding.workspaceId!)).toBe(true);
    release();
    await activity;
    await drainBackgroundWork();
    expect(vms.has(binding.workspaceId!)).toBe(false);
    expect(await repos.cloudWorkspace.findById(workspace.id)).toBeUndefined();
  });
  it("requires a verified Cloud link on a self-hosted installation", async () => {
    h.cloud = false;
    expect((await request("POST", `/${workspace.id}/ensure`)).body.code).toBe(
      "CLOUD_SERVER_LINK_REQUIRED",
    );
    expect(h.client.workspaces.create).not.toHaveBeenCalled();
  });
});

describe("workspace payment and deletion races", () => {
  function checkout(key = randomUUID()) {
    return {
      namespace: workspace.namespace!,
      kind: "subscription" as const,
      billingInterval: "monthly" as const,
      offer: subscriptionOffer("hobby", "monthly"),
      metadata: subscriptionMetadata("hobby", owner.orgId, workspace.namespace!),
      successUrl: "https://app.openship.io/billing",
      cancelUrl: "https://app.openship.io/billing",
      idempotencyKey: key,
    };
  }
  const purchase = (input = checkout()) =>
    withCloudBillingLock(
      owner.orgId,
      async () =>
        createTrackedWorkspaceCheckout((await repos.cloudWorkspace.findById(workspace.id))!, input),
      workspace.id,
    );
  it("recovers a lost checkout response using the exact request and blocks deletion while payment can settle", async () => {
    const input = checkout();
    h.billing.createCheckout.mockRejectedValueOnce(
      new Error("response lost after session creation"),
    );
    await expect(purchase(input)).rejects.toThrow("response lost");
    const saved = (await repos.cloudWorkspace.findById(workspace.id))!;
    expect(saved.pendingCheckouts[0]?.request).toEqual(input);
    await expect(assertWorkspaceCheckoutsSettled(saved)).rejects.toMatchObject({
      code: "CLOUD_WORKSPACE_CHECKOUT_PENDING",
    });
    expect(h.billing.createCheckout).toHaveBeenLastCalledWith(input);
    h.billing.getCheckout.mockResolvedValue({ checkout: { status: "complete", fulfilled: false } });
    await expect(
      assertWorkspaceCheckoutsSettled((await repos.cloudWorkspace.findById(workspace.id))!),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_CHECKOUT_PENDING" });
    h.billing.getCheckout.mockResolvedValue({ checkout: { status: "complete", fulfilled: true } });
    await assertWorkspaceCheckoutsSettled((await repos.cloudWorkspace.findById(workspace.id))!);
    expect((await repos.cloudWorkspace.findById(workspace.id))?.pendingCheckouts).toEqual([]);
  });
  it("does not strand a never-created checkout after explicit offer rejection", async () => {
    h.billing.createCheckout.mockRejectedValueOnce(
      new OperationError("Invalid offer", 400, "OBLIEN_BILLING_ERROR", {
        providerCode: "invalid_offer",
      }),
    );
    await expect(purchase()).rejects.toThrow("Invalid offer");
    expect((await repos.cloudWorkspace.findById(workspace.id))?.pendingCheckouts).toEqual([]);
  });
  it("preserves an uncertain charge even if a replay later rejects, and keeps subscription checks after settlement", async () => {
    h.billing.createCheckout.mockRejectedValueOnce(new Error("timeout"));
    await expect(purchase()).rejects.toThrow("timeout");
    h.billing.createCheckout.mockRejectedValue(
      new OperationError("Invalid offer", 400, "OBLIEN_BILLING_ERROR", {
        providerCode: "invalid_offer",
      }),
    );
    await expect(purchase()).rejects.toThrow("Invalid offer");
    expect((await repos.cloudWorkspace.findById(workspace.id))?.pendingCheckouts).toHaveLength(1);
  });
});
